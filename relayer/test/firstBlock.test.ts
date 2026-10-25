import { test } from "node:test";
import assert from "node:assert/strict";
import { firstBlock } from "../src/processor.ts";

test("with a progress marker, scanning continues right after it", () => {
  assert.equal(firstBlock(500n, 100n, 10_000n, 1_000n), 501n);
});

test("without a marker and without a look-back, scanning starts at the deployment block", () => {
  assert.equal(firstBlock(undefined, 100n, 10_000n, 0n), 100n);
});

test("without a marker, a look-back starts only that far behind the head", () => {
  assert.equal(firstBlock(undefined, 100n, 10_000n, 1_000n), 9_000n);
});

test("a look-back never starts before the deployment block", () => {
  assert.equal(firstBlock(undefined, 9_500n, 10_000n, 1_000n), 9_500n);
  assert.equal(firstBlock(undefined, 100n, 500n, 1_000n), 100n, "a young chain is scanned from the start");
});
