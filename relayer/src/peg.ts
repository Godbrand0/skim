import { pegGuardAbi } from "./abi.ts";
import type { Clients } from "./chain.ts";
import type { Config } from "./config.ts";

export interface PegState {
  /** False when no guard contract is configured; the fixed MUSD value then applies and nothing is paused. */
  configured: boolean;
  healthy: boolean;
  /** What 1 MUSD sells for in Mezo's MUSD/mUSDC pool, in bps of $1. 0 if the read failed. */
  stableBps: bigint;
  /** Same for the MUSD/mUSDT pool. */
  usdtBps: bigint;
  /** MUSD's USD value implied by the BTC pool and the MUSD protocol's PriceFeed, in bps of $1. 0 if the read failed. */
  btcBps: bigint;
}

export const NO_GUARD: PegState = { configured: false, healthy: true, stableBps: 0n, usdtBps: 0n, btcBps: 0n };

/** Reads the on-chain MusdPegGuard. If the read itself fails the state is unhealthy (fail closed). */
export async function readPeg(c: Clients, cfg: Config): Promise<PegState> {
  if (!cfg.pegGuardAddress) return NO_GUARD;
  try {
    const [healthy, stableBps, usdtBps, btcBps] = await c.mezoClient.readContract({ address: cfg.pegGuardAddress, abi: pegGuardAbi, functionName: "status" });
    return { configured: true, healthy, stableBps, usdtBps, btcBps };
  } catch {
    return { configured: true, healthy: false, stableBps: 0n, usdtBps: 0n, btcBps: 0n };
  }
}

/**
 * The value to put on MUSD, in bps of $1: never more than the configured value, and never more than the
 * pool actually pays for it. With no guard, or no reading, the configured value applies.
 */
export function musdValueBps(configured: bigint, peg: PegState): bigint {
  if (!peg.configured || peg.stableBps === 0n) return configured;
  return peg.stableBps < configured ? peg.stableBps : configured;
}

/**
 * What to value MUSD at when paying it out, in bps of $1: the pool's price, so the user receives what they paid for
 * (a MUSD that sells at $0.99 returns about 1.01 per dollar). With no guard or no reading it is par.
 */
export function musdPayoutBps(peg: PegState): bigint {
  return !peg.configured || peg.stableBps === 0n ? 10_000n : peg.stableBps;
}
