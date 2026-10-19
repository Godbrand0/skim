import { test } from "node:test";
import assert from "node:assert/strict";
import {
  grossMicro,
  feeMicro,
  quote,
  parseDecimal,
  formatMicro,
  satsToWei,
  weiToSats,
  type PricingConfig,
} from "../src/pricing.ts";

const cfg: PricingConfig = {
  musdValueBps: 9900n,
  musdcValueBps: 10000n,
  btcSpreadBps: 50n,
  feeBps: 200n,
  feeFloorMicro: 50_000n,
  lowFloatSurchargeBps: 100n,
  floatTargetMicro: 300_000_000n,
};
const FLOAT_OK = 300_000_000n;
const BTC_83K = 83_000n * 10n ** 18n;

test("mUSDC is valued 1:1 and fee is 2%", () => {
  const q = quote("musdc", 10_000_000n, undefined, FLOAT_OK, cfg);
  assert.equal(q.grossMicro, 10_000_000n);
  assert.equal(q.feeMicro, 200_000n);
  assert.equal(q.payoutMicro, 9_800_000n);
  assert.equal(q.surchargeApplied, false);
});

test("MUSD (18 decimals) is haircut by the peg setting", () => {
  assert.equal(grossMicro("musd", 10n * 10n ** 18n, undefined, cfg), 9_900_000n);
});

test("fee floor applies to small amounts", () => {
  const q = quote("musdc", 1_000_000n, undefined, FLOAT_OK, cfg); // 2% = $0.02 < floor $0.05
  assert.equal(q.feeMicro, 50_000n);
  assert.equal(q.payoutMicro, 950_000n);
});

test("low-float surcharge applies below 30% of target and not at exactly 30%", () => {
  const low = feeMicro(10_000_000n, 89_999_999n, cfg);
  assert.equal(low.surchargeApplied, true);
  assert.equal(low.fee, 200_000n + 100_000n);
  const edge = feeMicro(10_000_000n, 90_000_000n, cfg);
  assert.equal(edge.surchargeApplied, false);
});

test("BTC value uses oracle price minus spread", () => {
  // 0.0001 BTC at $83,000 = $8.30; minus 0.5% = $8.2585
  const wei = 10n ** 14n;
  assert.equal(grossMicro("btc", wei, BTC_83K, cfg), 8_258_500n);
});

test("BTC without a price throws", () => {
  assert.throws(() => grossMicro("btc", 10n ** 14n, undefined, cfg));
  assert.throws(() => grossMicro("btc", 10n ** 14n, 0n, cfg));
});

test("payout never goes negative and fee never exceeds gross", () => {
  const q = quote("musdc", 10_000n, undefined, FLOAT_OK, cfg); // $0.01 deposit, floor $0.05
  assert.equal(q.payoutMicro, 0n);
  assert.equal(q.feeMicro, 10_000n);
});

test("sats <-> wei conversion", () => {
  assert.equal(satsToWei(1n), 10_000_000_000n);
  assert.equal(weiToSats(satsToWei(12_345n)), 12_345n);
  assert.equal(satsToWei(100_000_000n), 10n ** 18n); // 1 BTC
});

test("parseDecimal accepts valid and rejects invalid input", () => {
  assert.equal(parseDecimal("1.5", 6), 1_500_000n);
  assert.equal(parseDecimal("20", 6), 20_000_000n);
  assert.equal(parseDecimal("0.000001", 6), 1n);
  assert.throws(() => parseDecimal("1.0000001", 6));
  assert.throws(() => parseDecimal("-1", 6));
  assert.throws(() => parseDecimal("abc", 6));
  assert.throws(() => parseDecimal("", 6));
  assert.throws(() => parseDecimal("1e5", 6));
});

test("formatMicro", () => {
  assert.equal(formatMicro(9_800_000n), "9.800000");
  assert.equal(formatMicro(1n), "0.000001");
});
