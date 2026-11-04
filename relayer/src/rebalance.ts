import { erc20Abi, poolAbi, rebalancerAbi } from "./abi.ts";
import type { Clients } from "./chain.ts";
import { BTC_ERC20, MUSD, MUSDT } from "./config.ts";
import type { Config } from "./config.ts";
import { readPeg } from "./peg.ts";
import type { Address } from "viem";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/** Mirrors `MezoRebalancer.Route`. The relayer only automates the first three (cash-out direction); the last two (mUSDC -> MUSD -> BTC, for gas BTC) are keeper calls. */
export const ROUTES = { MusdToMusdc: 0, BtcToMusd: 1, MusdtToMusd: 2, MusdcToMusd: 3, MusdToBtc: 4 } as const;

/** How much to sell now: the balance, less anything held back, up to the approval and the caps; nothing if under the minimum. */
export function swapAmount(balance: bigint, reserve: bigint, allowance: bigint, min: bigint, caps: bigint[]): bigint {
  let amount = balance > reserve ? balance - reserve : 0n;
  for (const limit of [allowance, ...caps]) if (limit < amount) amount = limit;
  return amount >= min ? amount : 0n;
}

/** The lowest output to accept: the pool's own quote, less the keeper's slippage allowance. */
export const minOutFor = (quotedOut: bigint, slippageBps: bigint): bigint => (quotedOut * (10_000n - slippageBps)) / 10_000n;

export interface Leg {
  name: string;
  route: number;
  tokenIn: Address;
  min: bigint;
  reserve: bigint;
  cap: bigint;
}

/**
 * Converts what deposits left in the treasury toward mUSDC through Mezo's pools via the MezoRebalancer: mUSDT and BTC into
 * MUSD first, then MUSD into mUSDC. Returns the transaction hashes. The contract re-checks everything on-chain (peg guard,
 * per-route cap, price floor), this only decides when. A failing leg is logged and the others still run.
 */
export async function rebalanceOnce(cfg: Config, c: Clients): Promise<`0x${string}`[]> {
  const reb = cfg.rebalancerAddress;
  const wallet = c.mezoWallet;
  if (!reb || !wallet || !c.account || !cfg.enablePayouts) return [];

  const peg = await readPeg(c, cfg);
  if (!peg.healthy) {
    log("rebalance skipped: MUSD is below its peg");
    return [];
  }
  const treasury = await c.mezoClient.readContract({ address: reb, abi: rebalancerAbi, functionName: "treasury" });
  const legs: Leg[] = [
    { name: "mUSDT to MUSD", route: ROUTES.MusdtToMusd, tokenIn: MUSDT, min: cfg.rebalanceMinMusdt, reserve: 0n, cap: cfg.rebalanceMaxMusdt },
    { name: "BTC to MUSD", route: ROUTES.BtcToMusd, tokenIn: BTC_ERC20, min: cfg.rebalanceMinBtcWei, reserve: cfg.rebalanceBtcReserveWei, cap: cfg.rebalanceMaxBtcWei },
    { name: "MUSD to mUSDC", route: ROUTES.MusdToMusdc, tokenIn: MUSD, min: cfg.rebalanceMinMusd, reserve: 0n, cap: cfg.rebalanceMaxMusd },
  ];

  const hashes: `0x${string}`[] = [];
  for (const leg of legs) {
    try {
      const hash = await runLeg(cfg, c, reb, treasury, leg);
      if (hash) hashes.push(hash);
    } catch (e) {
      log(`rebalance ${leg.name} error:`, (e as Error).message.split("\n")[0]);
    }
  }
  return hashes;
}

/**
 * Sells as much of one leg's input token as the treasury holds, has approved and the route allows, if it is at least the
 * leg's minimum. `limit` lowers the amount further (the refill step uses it to buy only what a float needs). Returns the
 * transaction hash, or undefined when there was nothing worth swapping.
 */
export async function runLeg(cfg: Config, c: Clients, reb: Address, treasury: Address, leg: Leg, limit?: bigint): Promise<`0x${string}` | undefined> {
  const wallet = c.mezoWallet;
  if (!wallet || !c.account) return undefined;
  const [balance, allowance, route] = await Promise.all([
    c.mezoClient.readContract({ address: leg.tokenIn, abi: erc20Abi, functionName: "balanceOf", args: [treasury] }),
    c.mezoClient.readContract({ address: leg.tokenIn, abi: erc20Abi, functionName: "allowance", args: [treasury, reb] }),
    c.mezoClient.readContract({ address: reb, abi: rebalancerAbi, functionName: "routes", args: [leg.route] }),
  ]);
  const [pool, , , , , maxIn, slippageBps] = route;
  const amount = swapAmount(balance, leg.reserve, allowance, leg.min, limit === undefined ? [leg.cap, maxIn] : [leg.cap, maxIn, limit]);
  if (amount === 0n) return undefined;

  const quoted = await c.mezoClient.readContract({ address: pool, abi: poolAbi, functionName: "getAmountOut", args: [amount, leg.tokenIn] });
  const minOut = minOutFor(quoted, cfg.rebalanceSlippageBps < slippageBps ? cfg.rebalanceSlippageBps : slippageBps);
  const { request } = await c.mezoClient.simulateContract({ address: reb, abi: rebalancerAbi, functionName: "rebalance", args: [leg.route, amount, minOut], account: c.account });
  const hash = await wallet.writeContract(request);
  const receipt = await c.mezoClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  log(`rebalance ${leg.name} ${receipt.status}: ${amount} in, quoted ${quoted} out`, hash);
  return hash;
}
