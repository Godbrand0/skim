import { test } from "node:test";
import assert from "node:assert/strict";
import { refillAmount } from "../src/refill.ts";

const base = { balance: 100_000n, low: 300_000n, target: 1_000_000n, available: 5_000_000n, allowance: 5_000_000n, cap: 5_000_000n, min: 100_000n };

test("a float that is low is topped up to its target", () => {
  assert.equal(refillAmount(base), 900_000n);
});
test("a float at or above its low level is left alone", () => {
  assert.equal(refillAmount({ ...base, balance: 300_000n }), 0n);
  assert.equal(refillAmount({ ...base, balance: 800_000n }), 0n);
});
test("the treasury balance, the approval and the cap each limit the top-up", () => {
  assert.equal(refillAmount({ ...base, available: 400_000n }), 400_000n);
  assert.equal(refillAmount({ ...base, allowance: 250_000n }), 250_000n);
  assert.equal(refillAmount({ ...base, cap: 200_000n }), 200_000n);
});
test("a top-up below the minimum is not worth a transaction", () => {
  assert.equal(refillAmount({ ...base, available: 99_999n }), 0n);
  assert.equal(refillAmount({ ...base, available: 100_000n }), 100_000n);
});
test("no allowance or an empty treasury sends nothing", () => {
  assert.equal(refillAmount({ ...base, allowance: 0n }), 0n);
  assert.equal(refillAmount({ ...base, available: 0n }), 0n);
});
test("works in 18-decimal units", () => {
  const e = 10n ** 12n;
  assert.equal(refillAmount({ balance: 0n, low: 300_000n * e, target: 1_000_000n * e, available: 5_000_000n * e, allowance: 5_000_000n * e, cap: 5_000_000n * e, min: 100_000n * e }), 1_000_000n * e);
});

import { lowLevel } from "../src/refill.ts";
test("a float that cannot cover one maximum payout counts as low", () => {
  assert.equal(lowLevel(300_000n, 1_000_000n), 1_000_000n);
  assert.equal(lowLevel(1_500_000n, 1_000_000n), 1_500_000n);
});
