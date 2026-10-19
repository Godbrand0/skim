// Pure pricing and fee math. All amounts are bigint; USD values are in USDC micro-units (6 decimals).

export type Asset = "musd" | "musdc" | "btc";

export interface PricingConfig {
  /** MUSD value in USD, in basis points of $1 (9900 = $0.99). Covers peg drift. */
  musdValueBps: bigint;
  /** mUSDC value in USD, in basis points of $1. */
  musdcValueBps: bigint;
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
