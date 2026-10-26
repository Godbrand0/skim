import { loadConfig, CHAIN_IDS } from "./config.ts";
import { clientFor, makeClients, RELAYER_ROLE } from "./chain.ts";
import { floatAbi } from "./abi.ts";
import { openDb, Store } from "./db.ts";
import { ingest, processPending, recover } from "./processor.ts";
import { startServer } from "./server.ts";
import { retry } from "./retry.ts";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/** Startup reads are retried: a brief network problem should not stop the relayer, but a wrong answer still does. */
const patient = <T>(label: string, fn: () => Promise<T>): Promise<T> =>
  retry(fn, 6, 5_000, (e, n) => log(`${label} failed (attempt ${n} of 6), retrying in 5s:`, e.message.split("\n")[0]));

async function main() {
  const cfg = loadConfig({ needKey: true });
  const c = makeClients(cfg);
  const store = new Store(openDb(cfg.dbPath));

  // Startup safety checks: wrong chain, wrong address or missing role should stop us before any payout.
  const [mezoId, baseId] = await patient("chain check", () => Promise.all([c.mezoClient.getChainId(), c.baseClient.getChainId()]));
  if (mezoId !== CHAIN_IDS.mezo) throw new Error(`MEZO_RPC_URL is chain ${mezoId}, expected ${CHAIN_IDS.mezo}`);
  if (baseId !== CHAIN_IDS.base) throw new Error(`BASE_RPC_URL is chain ${baseId}, expected ${CHAIN_IDS.base}`);

  for (const lane of cfg.lanes) {
    for (const [name, chain, addr] of [
      ["deposit", lane.src, lane.depositAddress],
      ["float", lane.dst, lane.floatAddress],
    ] as const) {
      const code = await patient("contract check", () => clientFor(c, chain).getCode({ address: addr }));
      if (!code || code === "0x") throw new Error(`[${lane.id} lane] No contract code at ${name} address ${addr} on ${chain}`);
    }
  }

  if (c.account) {
    // An EIP-7702 delegated account (code 0xef0100 + delegate) can have its funds moved by the delegate's code.
    for (const chain of ["base", "mezo"] as const) {
      const code = await patient("key check", () => clientFor(c, chain).getCode({ address: c.account!.address }));
      if (code && code.toLowerCase().startsWith("0xef0100")) {
        throw new Error(`Relayer ${c.account.address} is an EIP-7702 delegated account on ${chain}. Use a fresh plain key.`);
      }
    }
  }

  if (cfg.enablePayouts) {
    if (!c.account) throw new Error("no relayer account");
    for (const lane of cfg.lanes) {
      const ok = await patient("role check", () => clientFor(c, lane.dst).readContract({ address: lane.floatAddress, abi: floatAbi, functionName: "hasRole", args: [RELAYER_ROLE, c.account!.address] }));
      if (!ok) throw new Error(`[${lane.id} lane] ${c.account.address} does not hold RELAYER_ROLE on the float at ${lane.floatAddress}`);
      const gas = await patient("gas check", () => clientFor(c, lane.dst).getBalance({ address: c.account!.address }));
      if (gas === 0n) log(`WARNING: the relayer has no gas on ${lane.dst}; ${lane.id}-lane payouts will fail until it is funded`);
    }
    log("payouts ENABLED, relayer", c.account.address, "lanes:", cfg.lanes.map((l) => l.id).join(", "));
  } else {
    log("payouts DISABLED (simulation only). Set ENABLE_PAYOUTS=true to send. Lanes:", cfg.lanes.map((l) => l.id).join(", "));
  }

  await recover(cfg, c, store);
  startServer(cfg, c, store);

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await ingest(cfg, c, store);
      await processPending(cfg, c, store);
    } catch (e) {
      log("tick error:", (e as Error).message);
    } finally {
      running = false;
    }
  };
  await tick();
  setInterval(tick, cfg.pollMs);
}

main().catch((e) => {
  console.error("fatal:", e.message);
  process.exit(1);
});
