import { isAddress, getAddress } from "viem";
import type { Address, Hex } from "viem";
import { depositAbi, floatAbi } from "./abi.ts";
import type { Store, DepositRow } from "./db.ts";
import type { Config, Lane } from "./config.ts";
import { BASE_USDC, MUSD, MUSDC, NATIVE, laneById } from "./config.ts";
import { clientFor, readBtcUsd18, readFloatState, walletFor } from "./chain.ts";
import type { Clients } from "./chain.ts";
import { quote } from "./pricing.ts";
import type { Asset } from "./pricing.ts";

/** Which asset a deposited token is, for a given lane. Unknown tokens go to manual review. */
export function assetOf(token: string, lane: Lane["id"]): Asset | undefined {
  const t = token.toLowerCase();
  if (lane === "enter") return t === BASE_USDC.toLowerCase() ? "usdc" : undefined;
  if (t === MUSD.toLowerCase()) return "musd";
  if (t === MUSDC.toLowerCase()) return "musdc";
  if (t === NATIVE.toLowerCase()) return "btc";
  return undefined;
}

/**
 * First block to scan. With a progress marker we continue after it. Without one (a fresh or wiped database) we start at
 * the deployment block, or, when a look-back is set, only that far behind the head. A look-back means a host that wipes
 * its disk doesn't rescan the whole chain on every restart. Anything older that was never paid needs a manual start block.
 */
export function firstBlock(last: bigint | undefined, depositStart: bigint, head: bigint, lookback: bigint): bigint {
  if (last !== undefined) return last + 1n;
  if (lookback > 0n && head > lookback) {
    const from = head - lookback;
    return from > depositStart ? from : depositStart;
  }
  return depositStart;
}

/** The exit lane keeps the original bookkeeping keys so existing databases keep working. */
export const metaKey = (lane: Lane, key: string): string => (lane.id === "exit" ? key : `${key}:${lane.id}`);

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/** Pull new Deposit events (only blocks with enough confirmations) from every lane's source chain into the database. */
export async function ingest(cfg: Config, c: Clients, store: Store): Promise<number> {
  let inserted = 0;
  for (const lane of cfg.lanes) {
    // A failing RPC on one chain must not stop the other lane from working.
    try {
      inserted += await ingestLane(cfg, c, store, lane);
    } catch (e) {
      log(`ingest error (${lane.id} lane):`, (e as Error).message);
    }
  }
  return inserted;
}

async function ingestLane(cfg: Config, c: Clients, store: Store, lane: Lane): Promise<number> {
  const client = clientFor(c, lane.src);
  const head = await client.getBlockNumber();
  const safe = head - lane.confirmations;
  const last = store.getMeta(metaKey(lane, "last_block"));
  let from = firstBlock(last ? BigInt(last) : undefined, lane.depositStartBlock, head, lane.lookbackBlocks);
  let inserted = 0;

  while (from <= safe) {
    const to = from + cfg.logChunk - 1n < safe ? from + cfg.logChunk - 1n : safe;
    const logs = await client.getContractEvents({
      address: lane.depositAddress,
      abi: depositAbi,
      eventName: "Deposit",
      fromBlock: from,
      toBlock: to,
    });
    for (const l of logs) {
      if (l.removed || !l.args.id || l.args.nonce === undefined) continue;
      const token = l.args.token as Address;
      const asset = assetOf(token, lane.id);
      const ok = store.insertDeposit({
        id: l.args.id,
        lane: lane.id,
        nonce: Number(l.args.nonce),
        tx_hash: (l.transactionHash as string).toLowerCase(),
        block_number: Number(l.blockNumber),
        sender: l.args.sender as string,
        token,
        asset: asset ?? "unknown",
        amount: (l.args.amount as bigint).toString(),
        recipient: l.args.recipient as string,
      });
      if (ok) {
        inserted++;
        log(`ingested ${lane.id} deposit`, l.args.nonce?.toString(), asset ?? "unknown", l.args.amount?.toString());
      }
    }
    store.setMeta(metaKey(lane, "last_block"), to.toString());
    from = to + 1n;
  }
  store.setMeta(metaKey(lane, "head_block"), head.toString());
  store.setMeta(metaKey(lane, "last_ingest_at"), String(Date.now()));
  return inserted;
}

/** On startup, settle anything left 'sending' by a previous run. */
export async function recover(cfg: Config, c: Clients, store: Store): Promise<void> {
  for (const row of store.byStatus(["sending"])) {
    const lane = laneById(cfg, row.lane as Lane["id"]);
    if (!lane) continue;
    const used = await clientFor(c, lane.dst).readContract({ address: lane.floatAddress, abi: floatAbi, functionName: "refUsed", args: [row.id as Hex] });
    if (used) {
      store.update(row.id, { status: "paid", note: "reconciled after restart" });
      log("recovered as paid", row.id);
    } else {
      store.update(row.id, { status: "waiting", note: "retry after restart" });
      log("recovered as waiting", row.id);
    }
  }
}

/** Try to pay every deposit that is new or waiting, oldest first. */
export async function processPending(cfg: Config, c: Clients, store: Store): Promise<void> {
  const rows = store.byStatus(["new", "waiting"]);
  if (rows.length === 0) return;

  let btcUsd18: bigint | undefined;
  let btcError: string | undefined;
  if (rows.some((r) => r.asset === "btc")) {
    try {
      btcUsd18 = await readBtcUsd18(c, cfg.oracleMaxAgeSec);
    } catch (e) {
      btcError = (e as Error).message;
    }
  }

  for (const row of rows) {
    try {
      const lane = laneById(cfg, row.lane as Lane["id"]);
      if (!lane) {
        store.update(row.id, { status: "waiting", note: `lane "${row.lane}" is not configured` });
        continue;
      }
      await processOne(cfg, c, store, lane, row, btcUsd18, btcError);
    } catch (e) {
      store.update(row.id, { status: "waiting", note: `error: ${(e as Error).message}`.slice(0, 300) });
      log("error processing", row.id, (e as Error).message);
    }
  }
}

async function processOne(
  cfg: Config,
  c: Clients,
  store: Store,
  lane: Lane,
  row: DepositRow,
  btcUsd18: bigint | undefined,
  btcError: string | undefined,
): Promise<void> {
  const dst = clientFor(c, lane.dst);
  const wallet = walletFor(c, lane.dst);
  const asset = assetOf(row.token, lane.id);
  if (!asset) return void store.update(row.id, { status: "manual_review", note: "unknown token" });
  if (!isAddress(row.recipient)) return void store.update(row.id, { status: "manual_review", note: "invalid recipient" });
  const recipient = getAddress(row.recipient);

  // Idempotency: never pay a ref twice, even if our database lost track.
  const already = await dst.readContract({ address: lane.floatAddress, abi: floatAbi, functionName: "refUsed", args: [row.id as Hex] });
  if (already) return void store.update(row.id, { status: "paid", note: "already released on-chain" });

  if (asset === "btc" && btcUsd18 === undefined) {
    return void store.update(row.id, { status: "waiting", note: `waiting for BTC price: ${btcError}` });
  }

  const fs = await readFloatState(dst, lane.floatAddress);
  const q = quote(asset, BigInt(row.amount), btcUsd18, fs.balanceMicro, { ...cfg.pricing, floatTargetMicro: lane.floatTargetMicro });
  const amounts = { gross_micro: q.grossMicro.toString(), fee_micro: q.feeMicro.toString(), payout_micro: q.payoutMicro.toString() };

  if (q.payoutMicro < cfg.minPayoutMicro) {
    return void store.update(row.id, { ...amounts, status: "manual_review", note: "payout below minimum; refund required" });
  }
  if (q.payoutMicro > fs.maxPerTx) {
    return void store.update(row.id, { ...amounts, status: "manual_review", note: "payout above per-transaction limit" });
  }
  if (fs.paused) return void store.update(row.id, { ...amounts, status: "waiting", note: "float is paused" });
  if (fs.balanceMicro < q.payoutMicro) return void store.update(row.id, { ...amounts, status: "waiting", note: "float balance too low" });
  if (fs.globalSpentToday + q.payoutMicro > fs.maxGlobal) {
    return void store.update(row.id, { ...amounts, status: "waiting", note: "global daily limit reached" });
  }
  const addrSpent = await dst.readContract({ address: lane.floatAddress, abi: floatAbi, functionName: "addressSpentToday", args: [recipient] });
  if (addrSpent + q.payoutMicro > fs.maxPerAddress) {
    return void store.update(row.id, { ...amounts, status: "waiting", note: "recipient daily limit reached" });
  }

  const args = [recipient, q.payoutMicro, row.id as Hex] as const;
  if (!cfg.enablePayouts || !wallet || !c.account) {
    // Simulation only: proves the call would succeed without sending it.
    await dst.simulateContract({ address: lane.floatAddress, abi: floatAbi, functionName: "release", args, account: c.account });
    return void store.update(row.id, { ...amounts, status: "waiting", note: "payouts disabled (simulation ok)" });
  }

  const { request } = await dst.simulateContract({ address: lane.floatAddress, abi: floatAbi, functionName: "release", args, account: c.account });
  store.update(row.id, { ...amounts, status: "sending", note: null });
  const hash = await wallet.writeContract(request);
  store.update(row.id, { release_tx: hash });
  log(`release sent (${lane.id})`, row.id, hash);

  const receipt = await dst.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status === "success") {
    store.update(row.id, { status: "paid", note: null });
    log(`paid (${lane.id})`, row.id, q.payoutMicro.toString());
  } else {
    const used = await dst.readContract({ address: lane.floatAddress, abi: floatAbi, functionName: "refUsed", args: [row.id as Hex] });
    store.update(row.id, used ? { status: "paid" } : { status: "waiting", note: "release reverted; will retry" });
  }
}
