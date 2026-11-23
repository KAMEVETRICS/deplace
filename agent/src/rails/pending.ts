import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** A signed Deplace transaction that was sent (or was about to be) and whose outcome the agent has not seen. */
export type PendingTx = {
  kind: "tx";
  action: string;
  bountyId: string | null;
  /** The hash the node names the transaction by. */
  hash: string;
  /** Unix ms after which the transaction can no longer be included in a block. */
  expiresAt: number;
  /** The budget commitment written for it before sending (a post's reward), moved or dropped once it is settled. */
  commitRef?: string;
};

/** An x402 payment the agent signed whose outcome it has not seen. The board's sponsor signs it after the agent, so it is known by its nonce. */
export type PendingPayment = {
  kind: "payment";
  purpose: "fund" | "deliver";
  bountyId: string;
  /** The budget commitment the payment is booked against. */
  ref: string;
  /** The agent account's sequence number the payment uses. */
  nonce: string;
  /** Smallest token units. */
  amount: string;
  expiresAt: number;
};

export type PendingRecord = PendingTx | PendingPayment;

/**
 * Transactions and payments the agent sent but has not seen the outcome of. A record is on disk
 * before its transaction or payment leaves, so after a restart the agent still knows what may
 * have landed, and does not send a second one blind.
 */
export class PendingStore {
  private records: PendingRecord[];

  constructor(private readonly file: string | null) {
    this.records = file && existsSync(file) ? read(file) : [];
  }

  list(): PendingRecord[] {
    return [...this.records];
  }

  /** Saved to disk before it returns. */
  add(r: PendingRecord): void {
    this.records.push(r);
    this.save();
  }

  /** Removes the records that match; returns how many. */
  remove(match: (r: PendingRecord) => boolean): number {
    const before = this.records.length;
    this.records = this.records.filter((r) => !match(r));
    const removed = before - this.records.length;
    if (removed > 0) this.save();
    return removed;
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    // Written next to the file and renamed over it, so a crash never leaves half a file.
    const next = `${this.file}.next`;
    writeFileSync(next, JSON.stringify(this.records, null, 2));
    renameSync(next, this.file);
  }
}

function read(file: string): PendingRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: cannot read the pending transactions (${(e as Error).message}); check them on the explorer before moving the file away`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${file}: expected a JSON array of pending transactions`);
  return parsed as PendingRecord[];
}
