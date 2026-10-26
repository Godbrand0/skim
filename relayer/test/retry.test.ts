import { test } from "node:test";
import assert from "node:assert/strict";
import { retry } from "../src/retry.ts";

test("returns at once when the first attempt works", async () => {
  let calls = 0;
  assert.equal(await retry(async () => (++calls, "ok"), 3, 1), "ok");
  assert.equal(calls, 1);
});

test("recovers from a couple of failures and reports each retry", async () => {
  let calls = 0;
  const seen: number[] = [];
  const result = await retry(
    async () => {
      if (++calls < 3) throw new Error("network blip");
      return "recovered";
    },
    5,
    1,
    (_e, n) => seen.push(n),
  );
  assert.equal(result, "recovered");
  assert.equal(calls, 3);
  assert.deepEqual(seen, [1, 2]);
});

test("gives up after the last attempt with the real error", async () => {
  let calls = 0;
  await assert.rejects(
    retry(async () => { calls++; throw new Error("still down"); }, 3, 1),
    /still down/,
  );
  assert.equal(calls, 3);
});
