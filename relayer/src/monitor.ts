// Prints float and treasury status and says whether it is time to run a rebalancing batch.
// Usage: node src/monitor.ts   (needs the same env as the relayer, except the private key)
import { formatUnits } from "viem";
import { loadConfig, MUSD, MUSDC } from "./config.ts";
import { makeClients, readBtcUsd18, readFloatState } from "./chain.ts";
import { erc20Abi } from "./abi.ts";
import { openDb, Store } from "./db.ts";
import { formatMicro, grossMicro } from "./pricing.ts";

const cfg = loadConfig();
const c = makeClients(cfg);
const store = new Store(openDb(cfg.dbPath));

const fs = await readFloatState(c, cfg.floatAddress);
console.log(`Base float:        $${formatMicro(fs.balanceMicro)} USDC${fs.paused ? "  [PAUSED]" : ""}`);
console.log(`Daily payout used: $${formatMicro(fs.globalSpentToday)} of $${formatMicro(fs.maxGlobal)}`);

const day = store.paidSince(24 * 3600 * 1000);
console.log(`Last 24h:          ${day.count} payouts, $${formatMicro(day.payoutMicro)} paid, $${formatMicro(day.feeMicro)} fees`);
console.log("Queue:            ", JSON.stringify(store.counts()));

let treasuryMicro = 0n;
if (cfg.treasuryAddress) {
  const t = cfg.treasuryAddress;
  const [musd, musdc, btcWei] = await Promise.all([
    c.mezoClient.readContract({ address: MUSD, abi: erc20Abi, functionName: "balanceOf", args: [t] }),
    c.mezoClient.readContract({ address: MUSDC, abi: erc20Abi, functionName: "balanceOf", args: [t] }),
    c.mezoClient.getBalance({ address: t }),
  ]);
  let btcUsd18: bigint | undefined;
  try {
    btcUsd18 = await readBtcUsd18(c, cfg.oracleMaxAgeSec);
  } catch (e) {
    console.log("BTC price unavailable:", (e as Error).message);
  }
  const musdUsd = grossMicro("musd", musd, undefined, cfg.pricing);
  const musdcUsd = grossMicro("musdc", musdc, undefined, cfg.pricing);
  const btcUsd = btcUsd18 ? grossMicro("btc", btcWei, btcUsd18, cfg.pricing) : 0n;
  treasuryMicro = musdUsd + musdcUsd + btcUsd;
  console.log(`Mezo treasury:     MUSD ${formatUnits(musd, 18)} | mUSDC ${formatUnits(musdc, 6)} | BTC ${formatUnits(btcWei, 18)}`);
  console.log(`Treasury value:    ~$${formatMicro(treasuryMicro)} (after peg/BTC haircuts)`);
} else {
  console.log("Set TREASURY_ADDRESS to include Mezo treasury balances.");
}

const reasons: string[] = [];
if (fs.balanceMicro < cfg.lowFloatMicro) reasons.push(`float below $${formatMicro(cfg.lowFloatMicro)}`);
if (treasuryMicro >= cfg.batchThresholdMicro) reasons.push(`treasury at or above $${formatMicro(cfg.batchThresholdMicro)}`);
console.log(reasons.length ? `\nACTION: run a rebalancing batch (${reasons.join("; ")}). See docs/RUNBOOK.md.` : "\nNo rebalance needed.");
