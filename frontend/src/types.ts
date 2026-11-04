import type { Address } from "viem";

export type AssetKey = "musdc" | "musd" | "btc" | "usdc";

export interface AssetCfg {
  key: AssetKey;
  symbol: string;
  decimals: number;
  address: Address;
  /** What the amount field is denominated in: "sats" for BTC, the token symbol otherwise. */
  unit: string;
  enabled: boolean;
  min: string;
  max: string;
}
/** The reverse direction (USDC on Base to mUSDC on Mezo). Absent when the relayer has that lane switched off. */
export interface EnterCfg {
  chains: { source: number; destination: number };
  contracts: { deposit: Address; float: Address };
  asset: AssetCfg;
  payoutToken: string;
  floatAvailable: string;
  maxPayout: string;
  paused: boolean;
  /** Why payouts are paused, when they are (for example the MUSD peg guard). */
  pausedReason?: string | null;
}
/** Live state of the on-chain MUSD peg guard. Null/absent when the relayer runs without one. */
export interface MusdPeg {
  healthy: boolean;
  /** What 1 MUSD sells for in the MUSD/mUSDC pool, in USD. */
  poolValueUsd: string;
  usdtPoolValueUsd: string;
  /** MUSD's value implied by the BTC pool and the MUSD protocol's PriceFeed, in USD. */
  protocolImpliedUsd: string;
  guard: Address;
  rebalancer: Address | null;
}
export interface AppConfig {
  contracts: { deposit: Address; float: Address };
  assets: AssetCfg[];
  fee: { percent: number; floorUsdc: string };
  floatAvailableUsdc: string;
  paused: boolean;
  enter?: EnterCfg;
  /** USDC on Base to MUSD on Mezo. Null when the relayer has that lane switched off. */
  enterMusd?: EnterCfg | null;
  musdPeg?: MusdPeg | null;
}
export interface QuoteResp {
  payoutToken: string;
  grossUsdc: string;
  feeUsdc: string;
  payoutUsdc: string;
  canFulfill: boolean;
  reasons: string[];
}
export interface DepositRow {
  id: string;
  lane: "exit" | "enter" | "musd";
  payoutToken: string;
  status: "new" | "waiting" | "sending" | "paid" | "manual_review";
  payoutUsdc: string | null;
  releaseTx: string | null;
  note: string | null;
}
export interface Balances {
  musdc: bigint | undefined;
  musd: bigint | undefined;
  btcWei: bigint | undefined;
  /** USDC on Base: the receiving address on the exit lane, the connected wallet on the enter lane. */
  baseUsdc: bigint | undefined;
  /** USDC on Base held by the connected wallet (what it can send on the enter lane). */
  accountBaseUsdc: bigint | undefined;
  /** ETH on Base held by the connected wallet, for gas on the enter lane. */
  baseEth: bigint | undefined;
  failed: boolean;
}

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
}
declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}
