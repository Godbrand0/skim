import { isAddress, getAddress } from "viem";
import type { Address, Hex } from "viem";
import { depositAbi, floatAbi } from "./abi.ts";
import type { Store, DepositRow } from "./db.ts";
import type { Config } from "./config.ts";
import { MUSD, MUSDC, NATIVE } from "./config.ts";
import { readBtcUsd18, readFloatState } from "./chain.ts";
import type { Clients } from "./chain.ts";
import { quote } from "./pricing.ts";
import type { Asset } from "./pricing.ts";

export function assetOf(token: string): Asset | undefined {
  const t = token.toLowerCase();
  if (t === MUSD.toLowerCase()) return "musd";
  if (t === MUSDC.toLowerCase()) return "musdc";
  if (t === NATIVE.toLowerCase()) return "btc";
  return undefined;
}

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/** Pull new Deposit events from Mezo (only blocks with enough confirmations) into the database. */
export async function ingest(cfg: Config, c: Clients, store: Store): Promise<number> {
  const head = await c.mezoClient.getBlockNumber();
  const safe = head - cfg.confirmations;
  const last = store.getMeta("last_block");
  let from = last ? BigInt(last) + 1n : cfg.depositStartBlock;
  let inserted = 0;

  while (from <= safe) {
    const to = from + cfg.logChunk - 1n < safe ? from + cfg.logChunk - 1n : safe;
    const logs = await c.mezoClient.getContractEvents({
      address: cfg.depositAddress,
      abi: depositAbi,
      eventName: "Deposit",
      fromBlock: from,
      toBlock: to,
    });
    for (const l of logs) {
      if (l.removed || !l.args.id || l.args.nonce === undefined) continue;
      const token = l.args.token as Address;
      const asset = assetOf(token);
      const ok = store.insertDeposit({
        id: l.args.id,
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
        log("ingested deposit", l.args.nonce?.toString(), asset ?? "unknown", l.args.amount?.toString());
      }
    }
    store.setMeta("last_block", to.toString());
    from = to + 1n;
  }
  store.setMeta("head_block", head.toString());
  store.setMeta("last_ingest_at", String(Date.now()));
  return inserted;
}

/** On startup, settle anything left 'sending' by a previous run. */
export async function recover(cfg: Config, c: Clients, store: Store): Promise<void> {
  for (const row of store.byStatus(["sending"])) {
    const used = await c.baseClient.readContract({ address: cfg.floatAddress, abi: floatAbi, functionName: "refUsed", args: [row.id as Hex] });
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
      await processOne(cfg, c, store, row, btcUsd18, btcError);
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
  row: DepositRow,
  btcUsd18: bigint | undefined,
  btcError: string | undefined,
): Promise<void> {
  const asset = assetOf(row.token);
  if (!asset) return void store.update(row.id, { status: "manual_review", note: "unknown token" });
  if (!isAddress(row.recipient)) return void store.update(row.id, { status: "manual_review", note: "invalid recipient" });
  const recipient = getAddress(row.recipient);

  // Idempotency: never pay a ref twice, even if our database lost track.
  const already = await c.baseClient.readContract({ address: cfg.floatAddress, abi: floatAbi, functionName: "refUsed", args: [row.id as Hex] });
  if (already) return void store.update(row.id, { status: "paid", note: "already released on-chain" });

  if (asset === "btc" && btcUsd18 === undefined) {
    return void store.update(row.id, { status: "waiting", note: `waiting for BTC price: ${btcError}` });
  }

  const fs = await readFloatState(c, cfg.floatAddress);
  const q = quote(asset, BigInt(row.amount), btcUsd18, fs.balanceMicro, cfg.pricing);
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
  const addrSpent = await c.baseClient.readContract({ address: cfg.floatAddress, abi: floatAbi, functionName: "addressSpentToday", args: [recipient] });
  if (addrSpent + q.payoutMicro > fs.maxPerAddress) {
    return void store.update(row.id, { ...amounts, status: "waiting", note: "recipient daily limit reached" });
  }

  const args = [recipient, q.payoutMicro, row.id as Hex] as const;
  if (!cfg.enablePayouts || !c.wallet || !c.account) {
    // Simulation only: proves the call would succeed without sending it.
    await c.baseClient.simulateContract({ address: cfg.floatAddress, abi: floatAbi, functionName: "release", args, account: c.account });
    return void store.update(row.id, { ...amounts, status: "waiting", note: "payouts disabled (simulation ok)" });
  }

  const { request } = await c.baseClient.simulateContract({ address: cfg.floatAddress, abi: floatAbi, functionName: "release", args, account: c.account });
  store.update(row.id, { ...amounts, status: "sending", note: null });
  const hash = await c.wallet.writeContract(request);
  store.update(row.id, { release_tx: hash });
  log("release sent", row.id, hash);

  const receipt = await c.baseClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status === "success") {
    store.update(row.id, { status: "paid", note: null });
    log("paid", row.id, q.payoutMicro.toString());
  } else {
    const used = await c.baseClient.readContract({ address: cfg.floatAddress, abi: floatAbi, functionName: "refUsed", args: [row.id as Hex] });
    store.update(row.id, used ? { status: "paid" } : { status: "waiting", note: "release reverted; will retry" });
  }
}
