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

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.entries, null, 2));
  }
}
