import type { Address, Hex } from "viem";
import type { PricingConfig } from "./pricing.ts";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}
const opt = (name: string, dflt: string): string => process.env[name] || dflt;
const big = (name: string, dflt: string): bigint => BigInt(opt(name, dflt));

export type ChainKey = "mezo" | "base";
export const CHAIN_IDS: Record<ChainKey, number> = { mezo: 31612, base: 8453 };

/** One direction of travel: deposits on `src` are paid out of a float on `dst`. */
export interface Lane {
  /** "exit" = Mezo to Base (USDC out). "enter" = Base to Mezo (mUSDC in). "musd" = Base to Mezo (MUSD in). "gas" = Base to Mezo (native BTC in). */
  id: "exit" | "enter" | "musd" | "gas";
  /** What the float pays: an ERC-20 (amounts in micro-units) or native BTC (amounts in wei, priced from the oracle). */
  payout: "token" | "btc";
  /** Decimals of the float's token when it is not 6 (MUSD has 18). The float's limits and balance are in these units. */
  payoutDecimals?: 6 | 18;
  src: ChainKey;
  dst: ChainKey;
  depositAddress: Address;
  depositStartBlock: bigint;
  floatAddress: Address;
  /** Intended float size in payout-token micro-units; drives the low-liquidity surcharge. */
  floatTargetMicro: bigint;
  /** Below this float level the monitor recommends a top-up. */
  lowFloatMicro: bigint;
  /** Source-chain blocks to wait before acting on a deposit. */
  confirmations: bigint;
  /**
   * When the database has no progress marker (a fresh or wiped database), start this many blocks behind the head
   * instead of at `depositStartBlock`. 0 = always start at `depositStartBlock`. Useful on hosts whose disk is wiped.
   */
  lookbackBlocks: bigint;
}

export interface Config {
  mezoRpc: string;
  baseRpc: string;
  lanes: Lane[];
  treasuryAddress?: Address;
  /** Treasury on Base that collects USDC from the enter lane (used by the monitor). */
  baseTreasuryAddress?: Address;
  logChunk: bigint;
  pollMs: number;
  /** Address the API listens on. Hosting platforms need 0.0.0.0. */
  host: string;
  /** Trust proxy headers for the client address (set this on a host that puts a proxy in front). */
  trustProxy: boolean;
  dbPath: string;
  port: number;
  corsOrigin: string;
  /** Payouts are only sent when this is true. Default false: the relayer simulates and logs only. */
  enablePayouts: boolean;
  relayerKey?: Hex;
  minPayoutMicro: bigint;
  oracleMaxAgeSec: bigint;
  /** Treasury value that triggers a batch, in USDC micro. */
  batchThresholdMicro: bigint;
  pricing: PricingConfig;
  /** MusdPegGuard on Mezo. When set, MUSD is paused while it reports a depeg and valued at the pool's price. */
  pegGuardAddress?: Address;
  /** MezoRebalancer on Mezo. When set (and payouts are on), the relayer sells treasury MUSD for mUSDC through Mezo's pool. */
  rebalancerAddress?: Address;
  rebalanceMinMusd: bigint;
  rebalanceMaxMusd: bigint;
  /** Smallest mUSDT (6 decimals) and BTC (wei) lots worth converting, and the BTC kept back for gas. */
  rebalanceMinMusdt: bigint;
  rebalanceMaxMusdt: bigint;
  rebalanceMaxBtcWei: bigint;
  rebalanceMinBtcWei: bigint;
  rebalanceBtcReserveWei: bigint;
  rebalanceIntervalMs: number;
  /** MezoFloatRefiller on Mezo. When set (and payouts are on), treasury funds top up the Mezo floats that run low. */
  refillerAddress?: Address;
  /** Smallest top-up worth sending, in micro-dollars. */
  refillMinMicro: bigint;
  /** Extra slack under the pool's quoted output the keeper tolerates, in bps. */
  rebalanceSlippageBps: bigint;
}

export const MEZO_ORACLE: Address = "0x7b7c000000000000000000000000000000000015";
export const MUSD: Address = "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186";
export const MUSDC: Address = "0x04671C72Aab5AC02A03c1098314b1BB6B560c197";
export const MUSD_MUSDC_POOL: Address = "0xEd812AEc0Fecc8fD882Ac3eccC43f3aA80A6c356";
export const MUSDT: Address = "0xeB5a5d39dE4Ea42C2Aa6A57EcA2894376683bB8E";
export const BTC_ERC20: Address = "0x7b7C000000000000000000000000000000000000";
export const NATIVE: Address = "0x0000000000000000000000000000000000000000";
export const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Rough seconds per block, rounded down so a look-back in hours covers at least that long. */
const BLOCK_TIME_SEC: Record<ChainKey, number> = { mezo: 3, base: 2 };
const lookbackBlocks = (hours: bigint, chain: ChainKey): bigint => (hours * 3600n) / BigInt(BLOCK_TIME_SEC[chain]);

export const laneById = (cfg: Config, id: Lane["id"]): Lane | undefined => cfg.lanes.find((l) => l.id === id);

/** A dollar-sized micro-unit figure expressed in the lane's own token units (the inverse of `laneMicro`). */
export const laneUnits = (lane: Lane, micro: bigint): bigint => (lane.payoutDecimals === 18 ? micro * 10n ** 12n : micro);

/** A float amount in the lane's own token units, expressed as 6-decimal micro-units (a dollar-sized figure). */
export const laneMicro = (lane: Lane, units: bigint): bigint => (lane.payoutDecimals === 18 ? units / 10n ** 12n : units);

export function loadConfig(opts: { needKey?: boolean } = {}): Config {
  const enablePayouts = opt("ENABLE_PAYOUTS", "false") === "true";
  const relayerKey = process.env.RELAYER_PRIVATE_KEY as Hex | undefined;
  if (opts.needKey && enablePayouts && !relayerKey) throw new Error("ENABLE_PAYOUTS=true requires RELAYER_PRIVATE_KEY");
  if (relayerKey && !/^0x[0-9a-fA-F]{64}$/.test(relayerKey)) throw new Error("RELAYER_PRIVATE_KEY is not a 32-byte hex key");

  const exitTarget = big("FLOAT_TARGET_MICRO", "300000000");
  const lookbackHours = big("LOOKBACK_HOURS", "0");
  const lanes: Lane[] = [
    {
      id: "exit",
      payout: "token",      src: "mezo",
      dst: "base",
      depositAddress: req("DEPOSIT_ADDRESS") as Address,
      depositStartBlock: BigInt(req("DEPOSIT_START_BLOCK")),
      floatAddress: req("FLOAT_ADDRESS") as Address,
      floatTargetMicro: exitTarget,
      lowFloatMicro: big("LOW_FLOAT_MICRO", String((exitTarget * 3n) / 10n)),
      confirmations: big("CONFIRMATIONS", "5"),
      lookbackBlocks: lookbackBlocks(lookbackHours, "mezo"),
    },
  ];

  // The reverse direction is optional: it only runs when its Base deposit contract is configured.
  if (process.env.ENTER_DEPOSIT_ADDRESS) {
    const enterTarget = big("ENTER_FLOAT_TARGET_MICRO", "300000000");
    lanes.push({
      id: "enter",
      payout: "token",      src: "base",
      dst: "mezo",
      depositAddress: req("ENTER_DEPOSIT_ADDRESS") as Address,
      depositStartBlock: BigInt(req("ENTER_DEPOSIT_START_BLOCK")),
      floatAddress: req("ENTER_FLOAT_ADDRESS") as Address,
      floatTargetMicro: enterTarget,
      lowFloatMicro: big("ENTER_LOW_FLOAT_MICRO", String((enterTarget * 3n) / 10n)),
      confirmations: big("ENTER_CONFIRMATIONS", "10"),
      lookbackBlocks: lookbackBlocks(lookbackHours, "base"),
    });
  }

  // USDC on Base to MUSD on Mezo is optional as well: its own Base deposit contract and a MUSD float on Mezo.
  if (process.env.MUSD_DEPOSIT_ADDRESS) {
    const musdTarget = big("MUSD_FLOAT_TARGET_MICRO", "3000000"); // dollar-sized target, in micro-units
    lanes.push({
      id: "musd",
      payout: "token",
      payoutDecimals: 18,
      src: "base",
      dst: "mezo",
      depositAddress: req("MUSD_DEPOSIT_ADDRESS") as Address,
      depositStartBlock: BigInt(req("MUSD_DEPOSIT_START_BLOCK")),
      floatAddress: req("MUSD_FLOAT_ADDRESS") as Address,
      floatTargetMicro: musdTarget,
      lowFloatMicro: big("MUSD_LOW_FLOAT_MICRO", String((musdTarget * 3n) / 10n)),
      confirmations: big("MUSD_CONFIRMATIONS", "10"),
      lookbackBlocks: lookbackBlocks(lookbackHours, "base"),
    });
  }

  // The gas-pack lane is optional too: USDC on Base is deposited, native BTC on Mezo is paid.
  if (process.env.GAS_DEPOSIT_ADDRESS) {
    const gasTarget = big("GAS_FLOAT_TARGET_MICRO", "30000000"); // USD value of the BTC float we want to keep
    lanes.push({
      id: "gas",
      payout: "btc",
      src: "base",
      dst: "mezo",
      depositAddress: req("GAS_DEPOSIT_ADDRESS") as Address,
      depositStartBlock: BigInt(req("GAS_DEPOSIT_START_BLOCK")),
      floatAddress: req("GAS_FLOAT_ADDRESS") as Address,
      floatTargetMicro: gasTarget,
      lowFloatMicro: big("GAS_LOW_FLOAT_MICRO", String((gasTarget * 3n) / 10n)),
      confirmations: big("GAS_CONFIRMATIONS", "10"),
      lookbackBlocks: lookbackBlocks(lookbackHours, "base"),
    });
  }

  return {
    mezoRpc: req("MEZO_RPC_URL"),
    baseRpc: req("BASE_RPC_URL"),
    lanes,
    treasuryAddress: process.env.TREASURY_ADDRESS as Address | undefined,
    baseTreasuryAddress: process.env.BASE_TREASURY_ADDRESS as Address | undefined,
    logChunk: big("LOG_CHUNK", "1000"),
    pollMs: Number(opt("POLL_MS", "5000")),
    host: opt("HOST", "0.0.0.0"),
    trustProxy: opt("TRUST_PROXY", "false") === "true",
    dbPath: opt("DB_PATH", "./relayer.sqlite"),
    port: Number(opt("PORT", "8787")),
    corsOrigin: opt("CORS_ORIGIN", "http://localhost:5173"),
    enablePayouts,
    relayerKey,
    minPayoutMicro: big("MIN_PAYOUT_MICRO", "500000"),
    oracleMaxAgeSec: big("ORACLE_MAX_AGE_SEC", "3600"),
    batchThresholdMicro: big("BATCH_THRESHOLD_MICRO", "300000000"),
    pegGuardAddress: (process.env.PEG_GUARD_ADDRESS || undefined) as Address | undefined,
    rebalancerAddress: (process.env.REBALANCER_ADDRESS || undefined) as Address | undefined,
    rebalanceMinMusd: big("REBALANCE_MIN_MUSD", "5000000000000000000"),
    rebalanceMaxMusd: big("REBALANCE_MAX_MUSD", "100000000000000000000"),
    rebalanceMinMusdt: big("REBALANCE_MIN_MUSDT", "5000000"),
    rebalanceMaxMusdt: big("REBALANCE_MAX_MUSDT", "100000000"),
    rebalanceMaxBtcWei: big("REBALANCE_MAX_BTC_WEI", "1000000000000000"),
    rebalanceMinBtcWei: big("REBALANCE_MIN_BTC_WEI", "50000000000000"),
    rebalanceBtcReserveWei: big("REBALANCE_BTC_RESERVE_WEI", "200000000000000"),
    rebalanceIntervalMs: Number(opt("REBALANCE_INTERVAL_MS", "600000")),
    refillerAddress: (process.env.REFILLER_ADDRESS || undefined) as Address | undefined,
    refillMinMicro: big("REFILL_MIN_MICRO", "100000"),
    rebalanceSlippageBps: big("REBALANCE_SLIPPAGE_BPS", "50"),
    pricing: {
      musdValueBps: big("MUSD_VALUE_BPS", "9900"),
      musdcValueBps: big("MUSDC_VALUE_BPS", "10000"),
      usdcValueBps: big("USDC_VALUE_BPS", "10000"),
      btcSpreadBps: big("BTC_SPREAD_BPS", "50"),
      feeBps: big("FEE_BPS", "200"),
      feeFloorMicro: big("FEE_FLOOR_MICRO", "50000"),
      lowFloatSurchargeBps: big("LOW_FLOAT_SURCHARGE_BPS", "100"),
      floatTargetMicro: exitTarget,
    },
  };
}
