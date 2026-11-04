import { test } from "node:test";
import assert from "node:assert/strict";
import { musdValueBps, NO_GUARD } from "../src/peg.ts";
import { minOutFor, swapAmount } from "../src/rebalance.ts";

const peg = (stableBps: bigint, healthy = true) => ({ configured: true, healthy, stableBps, usdtBps: 9979n, btcBps: 9985n });

test("MUSD value follows the pool when it pays less than the configured value", () => {
  assert.equal(musdValueBps(9900n, peg(9750n)), 9750n);
});
test("MUSD value never rises above the configured value", () => {
  assert.equal(musdValueBps(9900n, peg(10020n)), 9900n);
});
test("no guard or no reading keeps the configured value", () => {
  assert.equal(musdValueBps(9900n, NO_GUARD), 9900n);
  assert.equal(musdValueBps(9900n, peg(0n)), 9900n);
});

const E18 = 10n ** 18n;
test("swapAmount sells everything up to the caps", () => {
  assert.equal(swapAmount(30n * E18, 0n, 1000n * E18, 5n * E18, [100n * E18, 50n * E18]), 30n * E18);
  assert.equal(swapAmount(300n * E18, 0n, 1000n * E18, 5n * E18, [100n * E18, 50n * E18]), 50n * E18);
});
test("swapAmount is limited by the treasury approval and skips dust", () => {
  assert.equal(swapAmount(30n * E18, 0n, 12n * E18, 5n * E18, [100n * E18]), 12n * E18);
  assert.equal(swapAmount(30n * E18, 0n, 0n, 5n * E18, [100n * E18]), 0n);
  assert.equal(swapAmount(4n * E18, 0n, 100n * E18, 5n * E18, [100n * E18]), 0n);
});
test("swapAmount keeps a gas reserve back", () => {
  assert.equal(swapAmount(10n, 4n, 100n, 1n, [100n]), 6n);
  assert.equal(swapAmount(3n, 4n, 100n, 1n, [100n]), 0n);
});
test("minOutFor takes the slippage allowance off the quote", () => {
  assert.equal(minOutFor(9_900_000n, 50n), 9_850_500n);
});

import { musdForUsdMicro } from "../src/pricing.ts";
import { musdPayoutBps } from "../src/peg.ts";

test("a dollar buys more than one MUSD when MUSD sells below par, and rounds down", () => {
  assert.equal(musdForUsdMicro(1_000_000n, 10_000n), 10n ** 18n);
  assert.equal(musdForUsdMicro(1_000_000n, 9_900n), (10n ** 18n * 10_000n) / 9_900n);
  assert.ok(musdForUsdMicro(650_000n, 9_896n) > 650_000n * 10n ** 12n);
});
test("a MUSD above par returns less than one per dollar", () => {
  assert.ok(musdForUsdMicro(1_000_000n, 10_100n) < 10n ** 18n);
});
test("payout is sized at the pool's price, and at par with no guard or reading", () => {
  assert.equal(musdPayoutBps(peg(9896n)), 9896n);
  assert.equal(musdPayoutBps(NO_GUARD), 10_000n);
  assert.equal(musdPayoutBps(peg(0n)), 10_000n);
});
test("a zero price is refused", () => {
  assert.throws(() => musdForUsdMicro(1n, 0n));
});
