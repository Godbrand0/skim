import { test } from "node:test";
import assert from "node:assert/strict";
import { clientIp } from "../src/clientIp.ts";

test("without trustProxy the socket address is always used, so headers cannot be spoofed", () => {
  assert.equal(clientIp({ "x-forwarded-for": "1.1.1.1", "cf-connecting-ip": "2.2.2.2" }, "10.0.0.5", false), "10.0.0.5");
});

test("with trustProxy: Cloudflare's header wins, then True-Client-IP, then the last X-Forwarded-For entry", () => {
  assert.equal(clientIp({ "cf-connecting-ip": "2.2.2.2", "x-forwarded-for": "1.1.1.1" }, "10.0.0.5", true), "2.2.2.2");
  assert.equal(clientIp({ "true-client-ip": "3.3.3.3", "x-forwarded-for": "1.1.1.1" }, "10.0.0.5", true), "3.3.3.3");
  assert.equal(clientIp({ "x-forwarded-for": "9.9.9.9, 1.1.1.1, 4.4.4.4" }, "10.0.0.5", true), "4.4.4.4");
});

test("with trustProxy but no usable headers it falls back to the socket address, and to 'unknown' as a last resort", () => {
  assert.equal(clientIp({}, "10.0.0.5", true), "10.0.0.5");
  assert.equal(clientIp({ "x-forwarded-for": " , " }, "10.0.0.5", true), "10.0.0.5");
  assert.equal(clientIp({}, undefined, true), "unknown");
});
