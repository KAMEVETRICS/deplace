import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RailViolation } from "./guard.js";

interface Commitment {
  ref: string;
  /** Smallest token units, as a decimal string. */
  amount: string;
  /** What has been paid against it so far, booked before each payment is signed. */
  paid?: string;
  at: number;
}

const DAY_MS = 24 * 3_600_000;

/**
 * The agent's spending budget. Posting a bounty commits its reward: each reward is capped,
 * and so is the total committed in any 24 hours. A payment is allowed only against a
 * commitment for that bounty, and all payments against it together never exceed it, so the
 * agent never pays anything it did not commit to and never pays a reward twice.
 * Everything is saved to a file, so the limits survive restarts.
 */
export class SpendBudget {
  private entries: Commitment[];

  constructor(
    private readonly file: string | null,
    readonly limits: { maxPerBounty: bigint; dailyCap: bigint },
    private readonly now: () => number = Date.now,
  ) {
    this.entries = file && existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Commitment[]) : [];
  }

  spentLast24h(): bigint {
    const since = this.now() - DAY_MS;
    return this.entries.filter((e) => e.at > since).reduce((sum, e) => sum + BigInt(e.amount), 0n);
  }

  /** Throws RailViolation if a new commitment of `amount` would break a limit. Records nothing. */
  check(amount: bigint): void {
    if (amount > this.limits.maxPerBounty) throw new RailViolation(`reward ${amount} exceeds the per-bounty cap of ${this.limits.maxPerBounty}`);
    const spent = this.spentLast24h();
    if (spent + amount > this.limits.dailyCap) {
      throw new RailViolation(`reward ${amount} would exceed the daily budget: ${spent} of ${this.limits.dailyCap} already committed in the last 24 hours`);
    }
  }

  /** Records the reward of a bounty the agent posted. Throws RailViolation over a limit. */
  commit(ref: string, amount: bigint): void {
    const existing = this.entries.find((e) => e.ref === ref);
    if (existing && amount <= BigInt(existing.amount)) return;
    if (existing) throw new RailViolation(`${ref} is already committed at ${existing.amount}; raising it to ${amount} is not allowed`);
    this.check(amount);
    this.entries.push({ ref, amount: amount.toString(), at: this.now() });
    this.save();
  }

  /**
   * Books a payment against the bounty's commitment, before it is signed. Throws
   * RailViolation if there is no commitment or what is left of it does not cover the amount.
   * Returns an undo for the caller to use only when it knows no payment was produced; a
   * payment that may have gone out stays booked.
   */
  reserve(ref: string, amount: bigint): () => void {
    const c = this.entries.find((e) => e.ref === ref);
    if (!c) throw new RailViolation(`no commitment for ${ref}: the agent only pays rewards it committed to when posting`);
    const paid = BigInt(c.paid ?? "0");
    if (paid + amount > BigInt(c.amount)) {
      throw new RailViolation(`payment ${amount} for ${ref} is more than what is left of the committed ${c.amount} (${paid} already paid)`);
    }
    c.paid = (paid + amount).toString();
    this.save();
    let undone = false;
    return () => {
      if (undone) return;
      undone = true;
      c.paid = (BigInt(c.paid ?? "0") - amount).toString();
      this.save();
    };
  }

  /**
   * Moves a commitment, with what was paid against it, to another ref: a post's reward is committed
   * as `post-tx:<hash>` before the post is sent, and moved to `bounty:<id>` once the post is final.
   */
  rename(from: string, to: string): void {
    const c = this.entries.find((e) => e.ref === from);
    if (!c) throw new RailViolation(`no commitment ${from} to move to ${to}`);
    if (this.entries.some((e) => e.ref === to)) throw new RailViolation(`${to} is already committed; not moving ${from} onto it`);
    c.ref = to;
    this.save();
  }

  /** Drops a commitment nothing was paid against: the reward of a post that never landed. */
  remove(ref: string): void {
    const i = this.entries.findIndex((e) => e.ref === ref);
    const c = this.entries[i];
    if (!c) throw new RailViolation(`no commitment ${ref} to drop`);
    if (BigInt(c.paid ?? "0") > 0n) throw new RailViolation(`${ref} has payments booked against it, so it stays committed`);
    this.entries.splice(i, 1);
    this.save();
  }

  /**
   * Gives back a payment that provably never landed: its transaction expired before its nonce
   * was used. Never gives back more than was booked.
   */
  unbook(ref: string, amount: bigint): void {
    const c = this.entries.find((e) => e.ref === ref);
    if (!c) throw new RailViolation(`no commitment ${ref} to give a payment back to`);
    const paid = BigInt(c.paid ?? "0");
    if (amount > paid) throw new RailViolation(`cannot give back ${amount} for ${ref}: only ${paid} is booked`);
    c.paid = (paid - amount).toString();
    this.save();
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.entries, null, 2));
  }
}
