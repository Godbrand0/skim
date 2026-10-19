import { loadConfig } from "./config.ts";
import { makeClients, RELAYER_ROLE } from "./chain.ts";
import { floatAbi } from "./abi.ts";
import { openDb, Store } from "./db.ts";
import { ingest, processPending, recover } from "./processor.ts";
import { startServer } from "./server.ts";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

async function main() {
  const cfg = loadConfig({ needKey: true });
  const c = makeClients(cfg);
  const store = new Store(openDb(cfg.dbPath));

  // Startup safety checks: wrong chain, wrong address or missing role should stop us before any payout.
  const [mezoId, baseId] = await Promise.all([c.mezoClient.getChainId(), c.baseClient.getChainId()]);
  if (mezoId !== 31612) throw new Error(`MEZO_RPC_URL is chain ${mezoId}, expected 31612`);
  if (baseId !== 8453) throw new Error(`BASE_RPC_URL is chain ${baseId}, expected 8453`);
  for (const [name, client, addr] of [
    ["deposit", c.mezoClient, cfg.depositAddress],
    ["float", c.baseClient, cfg.floatAddress],
  ] as const) {
    const code = await client.getCode({ address: addr });
    if (!code || code === "0x") throw new Error(`No contract code at ${name} address ${addr}`);
  }
  if (c.account) {
    // An EIP-7702 delegated account (code 0xef0100 + delegate) can have its funds moved by the delegate's code.
    const code = await c.baseClient.getCode({ address: c.account.address });
    if (code && code.toLowerCase().startsWith("0xef0100")) {
      throw new Error(`Relayer ${c.account.address} is an EIP-7702 delegated account. Use a fresh plain key.`);
    }
  }
  if (cfg.enablePayouts) {
    if (!c.account) throw new Error("no relayer account");
    const ok = await c.baseClient.readContract({ address: cfg.floatAddress, abi: floatAbi, functionName: "hasRole", args: [RELAYER_ROLE, c.account.address] });
    if (!ok) throw new Error(`${c.account.address} does not hold RELAYER_ROLE on the float`);
    log("payouts ENABLED, relayer", c.account.address);
  } else {
    log("payouts DISABLED (simulation only). Set ENABLE_PAYOUTS=true to send.");
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
