import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BoardEvent, Bounty, BountyKind } from "@deplace/shared";
import type { DepositOutcome, EscrowStore, StoredTransfer } from "../escrow/worker.js";

/** JSON that keeps bigints: {"$n":"123"}. */
const enc = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? { $n: x.toString() } : x));
const dec = <T>(s: string): T =>
  JSON.parse(s, (_k, x) => (x && typeof x === "object" && typeof x.$n === "string" && Object.keys(x).length === 1 ? BigInt(x.$n) : x));

export interface Submission {
  workHash: string;
  bountyId: bigint;
  worker: string;
  /** Shown to the poster before acceptance. */
  preview: string;
  /** Released on acceptance (escrowed) or on x402 payment (not funded). */
  full: string;
}

export interface SettledPayment {
  tx: string;
  payee: string;
  amount: bigint;
  recorded: boolean;
}

export interface BountyFilter {
  status?: string;
  kind?: BountyKind;
  funding?: "NotFunded" | "Escrowed";
  poster?: string;
}

/**
 * The board's local store: a cache of on-chain bounty state (the chain stays the source
 * of truth and the cache can be rebuilt), the off-chain data whose hashes are on chain,
 * the events of transactions the board relayed, and the escrow worker's durable records.
 */
export class BoardStore {
  readonly db: DatabaseSync;
  readonly escrow: EscrowStore;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS bounties (id INTEGER PRIMARY KEY, json TEXT NOT NULL, status TEXT NOT NULL, kind TEXT NOT NULL, funding TEXT NOT NULL, poster TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS specs (hash TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS submissions (work_hash TEXT PRIMARY KEY, bounty_id INTEGER NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (tx TEXT NOT NULL, idx INTEGER NOT NULL, bounty_id INTEGER, at INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (tx, idx));
      CREATE TABLE IF NOT EXISTS escrow_candidates (id INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS escrow_transfers (key TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deposits (tx TEXT PRIMARY KEY, seq INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS x402_payments (bounty_id INTEGER PRIMARY KEY, json TEXT NOT NULL);
    `);
    this.escrow = this.escrowStore();
  }

  upsertBounty(b: Bounty) {
    this.db
      .prepare("INSERT INTO bounties (id, json, status, kind, funding, poster) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, status = excluded.status, kind = excluded.kind, funding = excluded.funding, poster = excluded.poster")
      .run(b.id, enc(b), b.status.type, b.kind, b.funding.type, b.poster);
  }

  bounty(id: bigint): Bounty | null {
    const row = this.db.prepare("SELECT json FROM bounties WHERE id = ?").get(id) as { json: string } | undefined;
    return row ? dec<Bounty>(row.json) : null;
  }

  bounties(f: BountyFilter): Bounty[] {
    const where: string[] = [];
    const args: string[] = [];
    if (f.status) (where.push("status = ?"), args.push(f.status));
    if (f.kind) (where.push("kind = ?"), args.push(f.kind));
    if (f.funding) (where.push("funding = ?"), args.push(f.funding));
    if (f.poster) (where.push("poster = ?"), args.push(f.poster));
    const sql = `SELECT json FROM bounties ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC`;
    return (this.db.prepare(sql).all(...args) as { json: string }[]).map((r) => dec<Bounty>(r.json));
  }

  putSpec(hash: string, json: string) {
    this.db.prepare("INSERT OR IGNORE INTO specs (hash, json) VALUES (?, ?)").run(hash, json);
  }

  spec(hash: string): string | null {
    return (this.db.prepare("SELECT json FROM specs WHERE hash = ?").get(hash) as { json: string } | undefined)?.json ?? null;
  }

  putSubmission(s: Submission) {
    this.db
      .prepare("INSERT OR REPLACE INTO submissions (work_hash, bounty_id, seq, json) VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM submissions), ?)")
      .run(s.workHash, s.bountyId, enc(s));
  }

  submission(workHash: string): Submission | null {
    const row = this.db.prepare("SELECT json FROM submissions WHERE work_hash = ?").get(workHash) as { json: string } | undefined;
    return row ? dec<Submission>(row.json) : null;
  }

  /** The most recent submission stored for a bounty (re-fetching work after payment). */
  latestSubmission(bountyId: bigint): Submission | null {
    const row = this.db.prepare("SELECT json FROM submissions WHERE bounty_id = ? ORDER BY seq DESC LIMIT 1").get(bountyId) as { json: string } | undefined;
    return row ? dec<Submission>(row.json) : null;
  }

  /** An x402 payment that settled for a bounty, kept until (and after) it is recorded on chain. */
  putSettledPayment(bountyId: bigint, p: SettledPayment) {
    this.db.prepare("INSERT OR REPLACE INTO x402_payments (bounty_id, json) VALUES (?, ?)").run(bountyId, enc(p));
  }

  settledPayment(bountyId: bigint): SettledPayment | null {
    const row = this.db.prepare("SELECT json FROM x402_payments WHERE bounty_id = ?").get(bountyId) as { json: string } | undefined;
    return row ? dec<SettledPayment>(row.json) : null;
  }

  unrecordedPayments(): { bountyId: bigint; payment: SettledPayment }[] {
    return (this.db.prepare("SELECT bounty_id, json FROM x402_payments").all() as { bounty_id: number | bigint; json: string }[])
      .map((r) => ({ bountyId: BigInt(r.bounty_id), payment: dec<SettledPayment>(r.json) }))
      .filter((x) => !x.payment.recorded);
  }

  recordEvents(tx: string, events: BoardEvent[], at: number) {
    const ins = this.db.prepare("INSERT OR IGNORE INTO events (tx, idx, bounty_id, at, json) VALUES (?, ?, ?, ?, ?)");
    events.forEach((e, i) => ins.run(tx, i, "id" in e ? e.id : null, at, enc(e)));
  }

  events(bountyId?: bigint): { tx: string; index: number; at: number; event: BoardEvent }[] {
    const rows = (
      bountyId === undefined
        ? this.db.prepare("SELECT tx, idx, at, json FROM events ORDER BY at, tx, idx").all()
        : this.db.prepare("SELECT tx, idx, at, json FROM events WHERE bounty_id = ? ORDER BY at, tx, idx").all(bountyId)
    ) as { tx: string; idx: number; at: number; json: string }[];
    return rows.map((r) => ({ tx: r.tx, index: r.idx, at: r.at, event: dec<BoardEvent>(r.json) }));
  }

  private escrowStore(): EscrowStore {
    const db = this.db;
    return {
      candidates: () => (db.prepare("SELECT id FROM escrow_candidates ORDER BY id").all() as { id: number | bigint }[]).map((r) => BigInt(r.id)),
      addCandidate: (id) => void db.prepare("INSERT OR IGNORE INTO escrow_candidates (id) VALUES (?)").run(id),
      removeCandidate: (id) => void db.prepare("DELETE FROM escrow_candidates WHERE id = ?").run(id),
      getTransfer: (key) => {
        const row = db.prepare("SELECT json FROM escrow_transfers WHERE key = ?").get(key) as { json: string } | undefined;
        return row ? dec<StoredTransfer>(row.json) : undefined;
      },
      putTransfer: (t) => void db.prepare("INSERT OR REPLACE INTO escrow_transfers (key, json) VALUES (?, ?)").run(t.key, enc(t)),
      depositOutcome: (tx) => {
        const row = db.prepare("SELECT json FROM deposits WHERE tx = ?").get(tx) as { json: string } | undefined;
        return row ? dec<DepositOutcome>(row.json) : undefined;
      },
      markDeposit: (tx, outcome) =>
        void db.prepare("INSERT OR REPLACE INTO deposits (tx, seq, json) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM deposits), ?)").run(tx, enc(outcome)),
      unmatchedDeposits: () =>
        (db.prepare("SELECT tx, json FROM deposits ORDER BY seq").all() as { tx: string; json: string }[]).flatMap((r) => {
          const o = dec<DepositOutcome>(r.json);
          return o.confirmed ? [] : [{ tx: r.tx, reason: o.reason }];
        }),
    };
  }
}
