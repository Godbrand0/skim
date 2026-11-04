// Pure pricing and fee math. All amounts are bigint; USD values are in USDC micro-units (6 decimals).

export type Asset = "musd" | "musdc" | "btc" | "usdc";

export interface PricingConfig {
  /** MUSD value in USD, in basis points of $1 (9900 = $0.99). Covers peg drift. */
  musdValueBps: bigint;
  /** mUSDC value in USD, in basis points of $1. */
  musdcValueBps: bigint;
  /** USDC (deposited on Base) value in USD, in basis points of $1. */
  usdcValueBps: bigint;
  /** Haircut applied to the BTC oracle price, in basis points. Covers BTC movement before conversion. */
  btcSpreadBps: bigint;
  /** Percentage fee, in basis points of the gross value. */
  feeBps: bigint;
  /** Minimum fee in USDC micro-units. */
  feeFloorMicro: bigint;
  /** Extra fee, in basis points, charged while the float is below 30% of its target. */
  lowFloatSurchargeBps: bigint;
  /** Intended float size in USDC micro-units, used to decide when the surcharge applies. */
  floatTargetMicro: bigint;
}

export interface Quote {
  grossMicro: bigint;
  feeMicro: bigint;
  payoutMicro: bigint;
  surchargeApplied: boolean;
}

const BPS = 10_000n;

/** Value of a deposit in USDC micro-units before fees. `btcUsd18` is USD per BTC scaled by 1e18. */
export function grossMicro(asset: Asset, amount: bigint, btcUsd18: bigint | undefined, cfg: PricingConfig): bigint {
  switch (asset) {
    case "musd":
      // 18 decimals -> 6 decimals
      return ((amount / 10n ** 12n) * cfg.musdValueBps) / BPS;
    case "musdc":
      return (amount * cfg.musdcValueBps) / BPS;
    case "usdc":
      return (amount * cfg.usdcValueBps) / BPS;
    case "btc": {
      if (btcUsd18 === undefined || btcUsd18 <= 0n) throw new Error("BTC price unavailable");
      // wei (1e18 per BTC) * price (USD*1e18 per BTC) / 1e36 = USD; * 1e6 = micro
      const raw = (amount * btcUsd18) / 10n ** 30n;
      return (raw * (BPS - cfg.btcSpreadBps)) / BPS;
    }
  }
}

/** Fee for a deposit with the given gross value, given the current float balance. */
export function feeMicro(gross: bigint, floatMicro: bigint, cfg: PricingConfig): { fee: bigint; surchargeApplied: boolean } {
  let fee = (gross * cfg.feeBps) / BPS;
  if (fee < cfg.feeFloorMicro) fee = cfg.feeFloorMicro;
  const lowFloat = floatMicro * 10n < cfg.floatTargetMicro * 3n;
  if (lowFloat) fee += (gross * cfg.lowFloatSurchargeBps) / BPS;
  return { fee, surchargeApplied: lowFloat };
}

export function quote(
  asset: Asset,
  amount: bigint,
  btcUsd18: bigint | undefined,
  floatMicro: bigint,
  cfg: PricingConfig,
): Quote {
  const gross = grossMicro(asset, amount, btcUsd18, cfg);
  const { fee, surchargeApplied } = feeMicro(gross, floatMicro, cfg);
  const payout = gross > fee ? gross - fee : 0n;
  return { grossMicro: gross, feeMicro: fee > gross ? gross : fee, payoutMicro: payout, surchargeApplied };
}

/**
 * BTC (wei) that a USD value buys when the user pays for BTC. The oracle price is marked UP by the spread, so the user
 * gets slightly less BTC than the mid price gives (the mirror of the haircut on BTC deposits).
 */
export function btcPayoutWei(usdMicro: bigint, btcUsd18: bigint, spreadBps: bigint): bigint {
  if (btcUsd18 <= 0n) throw new Error("BTC price unavailable");
  const price = (btcUsd18 * (BPS + spreadBps)) / BPS;
  // micro / 1e6 = USD; wei = USD * 1e18 / (price18 / 1e18) = micro * 1e30 / price18
  return (usdMicro * 10n ** 30n) / price;
}

/**
 * MUSD (18 decimals) paid for a USD value when MUSD is worth `valueBps` of $1. Rounds down, so the float is never overpaid.
 * A MUSD that sells below $1 therefore returns a little more than one MUSD per dollar, and one above $1 a little less.
 */
export function musdForUsdMicro(usdMicro: bigint, valueBps: bigint): bigint {
  if (valueBps <= 0n) throw new Error("MUSD value unavailable");
  return (usdMicro * 10n ** 12n * BPS) / valueBps;
}

/** USD value, in micro-units, of an amount of BTC (wei) at the oracle price (no spread). */
export const weiToUsdMicro = (wei: bigint, btcUsd18: bigint): bigint => (wei * btcUsd18) / 10n ** 30n;

/** 1 satoshi = 1e10 wei (native BTC on Mezo has 18 decimals). */
export const WEI_PER_SAT = 10n ** 10n;
export const satsToWei = (sats: bigint): bigint => sats * WEI_PER_SAT;
export const weiToSats = (wei: bigint): bigint => wei / WEI_PER_SAT;

/** Parse a non-negative decimal string into base units. Throws on bad input or too many decimals. */
export function parseDecimal(value: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error("invalid amount");
  const [whole, frac = ""] = value.split(".");
  if (frac.length > decimals) throw new Error("too many decimals");
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

export function formatMicro(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}
