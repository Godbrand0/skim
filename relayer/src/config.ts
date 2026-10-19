import type { Address, Hex } from "viem";
import type { PricingConfig } from "./pricing.ts";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}
const opt = (name: string, dflt: string): string => process.env[name] || dflt;
const big = (name: string, dflt: string): bigint => BigInt(opt(name, dflt));

export interface Config {
  mezoRpc: string;
  baseRpc: string;
  floatAddress: Address;
  depositAddress: Address;
  treasuryAddress?: Address;
  depositStartBlock: bigint;
  confirmations: bigint;
  logChunk: bigint;
  pollMs: number;
  dbPath: string;
  port: number;
  corsOrigin: string;
  /** Payouts are only sent when this is true. Default false: the relayer simulates and logs only. */
  enablePayouts: boolean;
  relayerKey?: Hex;
  minPayoutMicro: bigint;
  oracleMaxAgeSec: bigint;
  /** Below this float level the monitor recommends a rebalance, in USDC micro. */
  lowFloatMicro: bigint;
  /** Treasury value that triggers a batch, in USDC micro. */
  batchThresholdMicro: bigint;
  pricing: PricingConfig;
}

export const MEZO_ORACLE: Address = "0x7b7c000000000000000000000000000000000015";
export const MUSD: Address = "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186";
export const MUSDC: Address = "0x04671C72Aab5AC02A03c1098314b1BB6B560c197";
export const NATIVE: Address = "0x0000000000000000000000000000000000000000";
export const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export function loadConfig(opts: { needKey?: boolean } = {}): Config {
  const enablePayouts = opt("ENABLE_PAYOUTS", "false") === "true";
  const relayerKey = process.env.RELAYER_PRIVATE_KEY as Hex | undefined;
  if (opts.needKey && enablePayouts && !relayerKey) throw new Error("ENABLE_PAYOUTS=true requires RELAYER_PRIVATE_KEY");
  if (relayerKey && !/^0x[0-9a-fA-F]{64}$/.test(relayerKey)) throw new Error("RELAYER_PRIVATE_KEY is not a 32-byte hex key");

  const floatTarget = big("FLOAT_TARGET_MICRO", "300000000");
  return {
    mezoRpc: req("MEZO_RPC_URL"),
    baseRpc: req("BASE_RPC_URL"),
    floatAddress: req("FLOAT_ADDRESS") as Address,
    depositAddress: req("DEPOSIT_ADDRESS") as Address,
    treasuryAddress: process.env.TREASURY_ADDRESS as Address | undefined,
    depositStartBlock: BigInt(req("DEPOSIT_START_BLOCK")),
    confirmations: big("CONFIRMATIONS", "5"),
    logChunk: big("LOG_CHUNK", "1000"),
    pollMs: Number(opt("POLL_MS", "5000")),
    dbPath: opt("DB_PATH", "./relayer.sqlite"),
    port: Number(opt("PORT", "8787")),
    corsOrigin: opt("CORS_ORIGIN", "http://localhost:5173"),
    enablePayouts,
    relayerKey,
    minPayoutMicro: big("MIN_PAYOUT_MICRO", "500000"),
    oracleMaxAgeSec: big("ORACLE_MAX_AGE_SEC", "3600"),
    lowFloatMicro: big("LOW_FLOAT_MICRO", String((floatTarget * 3n) / 10n)),
    batchThresholdMicro: big("BATCH_THRESHOLD_MICRO", "300000000"),
    pricing: {
      musdValueBps: big("MUSD_VALUE_BPS", "9900"),
      musdcValueBps: big("MUSDC_VALUE_BPS", "10000"),
      btcSpreadBps: big("BTC_SPREAD_BPS", "50"),
      feeBps: big("FEE_BPS", "200"),
      feeFloorMicro: big("FEE_FLOOR_MICRO", "50000"),
      lowFloatSurchargeBps: big("LOW_FLOAT_SURCHARGE_BPS", "100"),
      floatTargetMicro: floatTarget,
    },
  };
}
