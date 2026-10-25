import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, Store } from "../src/db.ts";

test("a database created before lanes existed is upgraded and its rows become exit-lane rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "skim-db-"));
  const path = join(dir, "old.sqlite");
  try {
    // the schema as it was before the lane column existed
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE deposits (id TEXT PRIMARY KEY, nonce INTEGER NOT NULL, tx_hash TEXT NOT NULL, block_number INTEGER NOT NULL,
        sender TEXT NOT NULL, token TEXT NOT NULL, asset TEXT NOT NULL, amount TEXT NOT NULL, recipient TEXT NOT NULL,
        status TEXT NOT NULL, gross_micro TEXT, fee_micro TEXT, payout_micro TEXT, release_tx TEXT, note TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO deposits VALUES ('0xaa', 0, '0xbb', 1, '0xs', '0xt', 'musdc', '800000', '0xr', 'paid', '800000', '50000', '750000', '0xrel', NULL, 1, 2);
    `);
    old.close();

    const store = new Store(openDb(path));
    assert.equal(store.byId("0xaa")?.lane, "exit");
    assert.equal(store.byId("0xaa")?.status, "paid");

    // re-opening an already upgraded database must not fail
    const again = new Store(openDb(path));
    assert.equal(again.byId("0xaa")?.lane, "exit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rows from the two lanes are kept apart and counted separately", () => {
  const dir = mkdtempSync(join(tmpdir(), "skim-db-"));
  try {
    const store = new Store(openDb(join(dir, "new.sqlite")));
    const base = { nonce: 0, block_number: 1, sender: "0xs", token: "0xt", amount: "1000000", recipient: "0xr" };
    assert.equal(store.insertDeposit({ ...base, id: "0x01", lane: "exit", tx_hash: "0xa1", asset: "musdc" }), true);
    assert.equal(store.insertDeposit({ ...base, id: "0x02", lane: "enter", tx_hash: "0xa2", asset: "usdc" }), true);
    assert.equal(store.insertDeposit({ ...base, id: "0x02", lane: "enter", tx_hash: "0xa2", asset: "usdc" }), false, "same id is ignored");
    store.update("0x02", { status: "paid" });
    assert.deepEqual(store.counts("exit"), { new: 1 });
    assert.deepEqual(store.counts("enter"), { paid: 1 });
    assert.equal(store.byTx("0xa2")[0].lane, "enter");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
