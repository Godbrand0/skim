// Prints float and treasury status for each lane and says whether it is time to rebalance.
// Usage: node src/monitor.ts   (needs the same env as the relayer, except the private key)
import { formatUnits } from "viem";
import { loadConfig, laneById, BASE_USDC, MUSD, MUSDC } from "./config.ts";
import { clientFor, makeClients, readBtcUsd18, readFloatState } from "./chain.ts";
import { erc20Abi } from "./abi.ts";
import { openDb, Store } from "./db.ts";
import { formatMicro, grossMicro } from "./pricing.ts";

const cfg = loadConfig();
const c = makeClients(cfg);
const store = new Store(openDb(cfg.dbPath));
const actions: string[] = [];

for (const lane of cfg.lanes) {
  const fs = await readFloatState(clientFor(c, lane.dst), lane.floatAddress);
  const token = lane.id === "exit" ? "USDC on Base" : "mUSDC on Mezo";
  console.log(`\n== ${lane.id.toUpperCase()} lane (${lane.src} to ${lane.dst}) ==`);
  console.log(`Float:             $${formatMicro(fs.balanceMicro)} ${token}${fs.paused ? "  [PAUSED]" : ""}`);
  console.log(`Daily payout used: $${formatMicro(fs.globalSpentToday)} of $${formatMicro(fs.maxGlobal)}`);
  const day = store.paidSince(24 * 3600 * 1000, lane.id);
  console.log(`Last 24h:          ${day.count} payouts, $${formatMicro(day.payoutMicro)} paid, $${formatMicro(day.feeMicro)} fees`);
  console.log("Queue:            ", JSON.stringify(store.counts(lane.id)));
  if (fs.balanceMicro < lane.lowFloatMicro) actions.push(`${lane.id} float below $${formatMicro(lane.lowFloatMicro)}`);
}

// Treasury positions. Each direction's deposits can refill the other direction's float on the same chain.
let exitTreasuryMicro = 0n;
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
  exitTreasuryMicro = grossMicro("musd", musd, undefined, cfg.pricing) + grossMicro("musdc", musdc, undefined, cfg.pricing) + (btcUsd18 ? grossMicro("btc", btcWei, btcUsd18, cfg.pricing) : 0n);
  console.log(`\nMezo treasury:     MUSD ${formatUnits(musd, 18)} | mUSDC ${formatUnits(musdc, 6)} | BTC ${formatUnits(btcWei, 18)}`);
  console.log(`Treasury value:    ~$${formatMicro(exitTreasuryMicro)} (after peg/BTC haircuts)`);
  const enter = laneById(cfg, "enter");
  if (enter) {
    const efs = await readFloatState(clientFor(c, enter.dst), enter.floatAddress);
    if (efs.balanceMicro < enter.lowFloatMicro && musdc > 0n) {
      console.log(`Netting:           the Mezo treasury holds ${formatUnits(musdc, 6)} mUSDC that can refill the Mezo float (no bridge needed)`);
    }
  }
} else {
  console.log("\nSet TREASURY_ADDRESS to include Mezo treasury balances.");
}

if (cfg.baseTreasuryAddress) {
  const usdc = await c.baseClient.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [cfg.baseTreasuryAddress] });
  console.log(`Base treasury:     ${formatUnits(usdc, 6)} USDC (collected from the enter lane)`);
  const exit = laneById(cfg, "exit")!;
  const xfs = await readFloatState(clientFor(c, exit.dst), exit.floatAddress);
  if (xfs.balanceMicro < exit.lowFloatMicro && usdc > 0n) {
    console.log("Netting:           the Base treasury USDC can refill the Base float directly (no bridge needed)");
  }
}

if (exitTreasuryMicro >= cfg.batchThresholdMicro) actions.push(`Mezo treasury at or above $${formatMicro(cfg.batchThresholdMicro)}`);
console.log(actions.length ? `\nACTION: ${actions.join("; ")}. See docs/RUNBOOK.md.` : "\nNo rebalance needed.");
