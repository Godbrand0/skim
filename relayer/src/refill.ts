import type { Address } from "viem";
import { erc20Abi, refillerAbi } from "./abi.ts";
import { readFloatState } from "./chain.ts";
import type { Clients } from "./chain.ts";
import { MUSD, MUSDC, laneById, laneUnits } from "./config.ts";
import type { Config, Lane } from "./config.ts";
import { ROUTES, runLeg } from "./rebalance.ts";
import type { Leg } from "./rebalance.ts";
import { readPeg } from "./peg.ts";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/**
 * How much to send a float that is running low, in its token's units: up to its target, less than what the treasury holds,
 * has approved and the refiller's per-call cap allows, and nothing if that is under the minimum worth a transaction.
 */
export function refillAmount(p: { balance: bigint; low: bigint; target: bigint; available: bigint; allowance: bigint; cap: bigint; min: bigint }): bigint {
  if (p.balance >= p.low) return 0n;
  let amount = p.target > p.balance ? p.target - p.balance : 0n;
  for (const limit of [p.available, p.allowance, p.cap]) if (limit < amount) amount = limit;
  return amount >= p.min ? amount : 0n;
}

/**
 * When a float counts as low, in its token's units: under its configured low level, or under one maximum payout. Without the
 * second rule a float above its low level but below one payout would leave a deposit waiting with nothing to trigger a refill.
 */
export const lowLevel = (configuredLow: bigint, maxPerTx: bigint): bigint => (configuredLow > maxPerTx ? configuredLow : maxPerTx);

/** The token a Mezo-side float pays, by lane. */
const tokenOf = (lane: Lane): Address => (lane.id === "musd" ? MUSD : MUSDC);

/**
 * Tops up the Mezo floats from the treasury through the MezoFloatRefiller, so what deposits leave in the treasury pays the
 * next users without a bridge: mUSDC deposited on Mezo refills the mUSDC float, and MUSD deposited on Mezo refills the MUSD float.
 * If the treasury has no MUSD for the MUSD float, it buys just that much with spare mUSDC (rebalancer route 3). The mUSDC float
 * is served first. The contract re-checks everything on-chain (listed floats only, per-call cap, the treasury's allowance).
 */
export async function refillOnce(cfg: Config, c: Clients): Promise<`0x${string}`[]> {
  const refiller = cfg.refillerAddress;
  const wallet = c.mezoWallet;
  if (!refiller || !wallet || !c.account || !cfg.enablePayouts) return [];

  const treasury = await c.mezoClient.readContract({ address: refiller, abi: refillerAbi, functionName: "treasury" });
  const hashes: `0x${string}`[] = [];
  const lanes = (["enter", "musd"] as const).map((id) => laneById(cfg, id)).filter((l): l is Lane => !!l);

  const treasuryBalance = (token: Address) => c.mezoClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [treasury] });

  const send = async (lane: Lane): Promise<boolean> => {
    const token = tokenOf(lane);
    const [fs, available, allowance, listed] = await Promise.all([
      readFloatState(c.mezoClient, lane.floatAddress),
      treasuryBalance(token),
      c.mezoClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [treasury, refiller] }),
      c.mezoClient.readContract({ address: refiller, abi: refillerAbi, functionName: "floats", args: [lane.floatAddress] }),
    ]);
    const cap = listed[1];
    if (cap === 0n) {
      log(`refill ${lane.id}: the float is not listed on the refiller`);
      return false;
    }
    const amount = refillAmount({
      balance: fs.balanceMicro,
      low: lowLevel(laneUnits(lane, lane.lowFloatMicro), fs.maxPerTx),
      target: laneUnits(lane, lane.floatTargetMicro),
      available,
      allowance,
      cap,
      min: laneUnits(lane, cfg.refillMinMicro),
    });
    if (amount === 0n) return false;
    const { request } = await c.mezoClient.simulateContract({ address: refiller, abi: refillerAbi, functionName: "refill", args: [lane.floatAddress, amount], account: c.account });
    const hash = await wallet.writeContract(request);
    const receipt = await c.mezoClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    log(`refill ${lane.id} float ${receipt.status}: ${amount} sent`, hash);
    hashes.push(hash);
    return true;
  };

  for (const lane of lanes) {
    try {
      const sent = await send(lane);
      if (sent || lane.id !== "musd") continue;

      // The MUSD float is low and the treasury could not cover it with MUSD. Buy only the shortfall with spare mUSDC.
      const reb = cfg.rebalancerAddress;
      if (!reb) continue;
      const fs = await readFloatState(c.mezoClient, lane.floatAddress);
      if (fs.balanceMicro >= lowLevel(laneUnits(lane, lane.lowFloatMicro), fs.maxPerTx)) continue;
      const peg = await readPeg(c, cfg);
      if (!peg.healthy) {
        log("refill musd: MUSD is below its peg, not buying");
        continue;
      }
      const shortfallMusd = laneUnits(lane, lane.floatTargetMicro) - fs.balanceMicro - (await treasuryBalance(MUSD));
      if (shortfallMusd <= 0n) continue;
      // mUSDC (6 decimals) buys about one MUSD each; ask for a little over so rounding does not leave it short.
      const musdcIn = shortfallMusd / 10n ** 12n + 1n;
      const leg: Leg = { name: "mUSDC to MUSD (float refill)", route: ROUTES.MusdcToMusd, tokenIn: MUSDC, min: cfg.refillMinMicro, reserve: 0n, cap: musdcIn };
      const swapped = await runLeg(cfg, c, reb, treasury, leg, musdcIn);
      if (swapped) {
        hashes.push(swapped);
        await send(lane);
      }
    } catch (e) {
      log(`refill ${lane.id} error:`, (e as Error).message.split("\n")[0]);
    }
  }
  return hashes;
}
