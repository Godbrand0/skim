import type { Address } from "viem";

export type AssetKey = "musdc" | "musd" | "btc";

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
export interface AppConfig {
  contracts: { deposit: Address; float: Address };
  assets: AssetCfg[];
  fee: { percent: number; floorUsdc: string };
  floatAvailableUsdc: string;
  paused: boolean;
}
export interface QuoteResp {
  grossUsdc: string;
  feeUsdc: string;
  payoutUsdc: string;
  canFulfill: boolean;
  reasons: string[];
}
export interface DepositRow {
  id: string;
  status: "new" | "waiting" | "sending" | "paid" | "manual_review";
  payoutUsdc: string | null;
  releaseTx: string | null;
  note: string | null;
}
export interface Balances {
  musdc: bigint | undefined;
  musd: bigint | undefined;
  btcWei: bigint | undefined;
  baseUsdc: bigint | undefined;
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
