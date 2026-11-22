import { randomBytes } from "node:crypto";

/** The exact text a person or agent signs to prove control of an account. */
export function challengeMessage(nonce: string): string {
  return `Deplace/v1/login:${nonce}`;
}

interface Pending {
  subject: string;
  expiresAt: number;
}

/**
 * Single-use login challenges kept in memory. A nonce is bound to the subject
 * (account address or badge) it was issued for and expires after `ttlMs`.
 */
export class ChallengeStore {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  issue(subject: string): { nonce: string; message: string; expiresAt: number } {
    this.sweep();
    const nonce = randomBytes(16).toString("hex");
    const expiresAt = this.now() + this.ttlMs;
    this.pending.set(nonce, { subject, expiresAt });
    return { nonce, message: challengeMessage(nonce), expiresAt };
  }

  /** True once for a live nonce issued to `subject`; false for unknown, reused, expired or foreign nonces. */
  consume(subject: string, nonce: string): boolean {
    const p = this.pending.get(nonce);
    if (!p || p.subject !== subject) return false;
    this.pending.delete(nonce);
    return p.expiresAt >= this.now();
  }

  private sweep() {
    const t = this.now();
    for (const [nonce, p] of this.pending) if (p.expiresAt < t) this.pending.delete(nonce);
  }
}
