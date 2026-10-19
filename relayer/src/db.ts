import { DatabaseSync } from "node:sqlite";

export type Status = "new" | "waiting" | "sending" | "paid" | "manual_review";

export interface DepositRow {
  id: string;
  nonce: number;
  tx_hash: string;
  block_number: number;
  sender: string;
  token: string;
  asset: string;
  amount: string; // base units, as decimal string
  recipient: string;
  status: Status;
  gross_micro: string | null;
  fee_micro: string | null;
  payout_micro: string | null;
  release_tx: string | null;
  note: string | null;
  created_at: number;
  updated_at: number;
}

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS deposits (
      id TEXT PRIMARY KEY,
      nonce INTEGER NOT NULL,
      tx_hash TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      sender TEXT NOT NULL,
      token TEXT NOT NULL,
      asset TEXT NOT NULL,
      amount TEXT NOT NULL,
      recipient TEXT NOT NULL,
      status TEXT NOT NULL,
      gross_micro TEXT,
      fee_micro TEXT,
      payout_micro TEXT,
      release_tx TEXT,
      note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS deposits_status ON deposits(status, nonce);
    CREATE INDEX IF NOT EXISTS deposits_tx ON deposits(tx_hash);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

export class Store {
  db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }
  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  insertDeposit(d: Omit<DepositRow, "status" | "gross_micro" | "fee_micro" | "payout_micro" | "release_tx" | "note" | "created_at" | "updated_at">): boolean {
    const now = Date.now();
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO deposits (id, nonce, tx_hash, block_number, sender, token, asset, amount, recipient, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
      )
      .run(d.id, d.nonce, d.tx_hash, d.block_number, d.sender, d.token, d.asset, d.amount, d.recipient, now, now);
    return Number(res.changes) > 0;
  }

  update(id: string, fields: Partial<Pick<DepositRow, "status" | "gross_micro" | "fee_micro" | "payout_micro" | "release_tx" | "note">>): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => fields[k] ?? null);
    this.db.prepare(`UPDATE deposits SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, Date.now(), id);
  }

  byStatus(statuses: Status[]): DepositRow[] {
    const marks = statuses.map(() => "?").join(",");
    return this.db.prepare(`SELECT * FROM deposits WHERE status IN (${marks}) ORDER BY nonce ASC`).all(...statuses) as unknown as DepositRow[];
  }
  byTx(txHash: string): DepositRow[] {
    return this.db.prepare("SELECT * FROM deposits WHERE tx_hash = ? ORDER BY nonce ASC").all(txHash.toLowerCase()) as unknown as DepositRow[];
  }
  byId(id: string): DepositRow | undefined {
    return this.db.prepare("SELECT * FROM deposits WHERE id = ?").get(id) as unknown as DepositRow | undefined;
  }
  /** Sum of payouts sent in the last `sinceMs` milliseconds, in USDC micro. */
  paidSince(sinceMs: number): { count: number; payoutMicro: bigint; feeMicro: bigint } {
    const rows = this.db
      .prepare("SELECT payout_micro, fee_micro FROM deposits WHERE status = 'paid' AND updated_at >= ?")
      .all(Date.now() - sinceMs) as unknown as { payout_micro: string | null; fee_micro: string | null }[];
    let payoutMicro = 0n;
    let feeMicro = 0n;
    for (const r of rows) {
      payoutMicro += BigInt(r.payout_micro ?? "0");
      feeMicro += BigInt(r.fee_micro ?? "0");
    }
    return { count: rows.length, payoutMicro, feeMicro };
  }
  counts(): Record<string, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM deposits GROUP BY status").all() as unknown as { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }
}
