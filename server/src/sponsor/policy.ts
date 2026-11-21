/**
 * What the board's sponsor account will pay fees for. The server builds every payload
 * itself; this policy decides whether a request to build and co-sign one is allowed.
 */

/** bounty_board entrypoints people and agents call. Operator and admin entrypoints are excluded. */
export const SPONSORED_ENTRYPOINTS = new Set([
  "post",
  "cancel",
  "claim",
  "submit",
  "accept",
  "reject",
  "enter",
  "award",
  "auto_accept",
  "expire",
  "mark_unpaid",
  "split_unawarded",
  "no_award",
]);

export type Intent =
  | { type: "contract"; entrypoint: string; parameter: Uint8Array }
  | { type: "plt-transfer"; token: string; to: string; amount: bigint; memo: string };

/** What the policy needs to know about a bounty to judge a transfer for it. */
export interface BountyFacts {
  poster: string;
  /** Who is owed the reward right now (recorded worker or contest winner), if anyone. */
  payee: string | null;
  reward: bigint;
}

export interface PolicyOptions {
  escrowAccount: string;
  rewardTokenId: string;
  bounty: (id: bigint) => Promise<BountyFacts | null>;
  perSenderPerHour?: number;
  perBadgePerHour?: number;
  now?: () => number;
}

export type PolicyDecision = { ok: true } | { ok: false; reason: string; retryAfter?: number };

const HOUR_MS = 60 * 60_000;
const MEMO = /^(fund|bounty):(\d{1,20})$/;

class SlidingWindow {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly limit: number) {}

  /** Records a hit for `key` unless it is over the limit; returns seconds to wait when it is. */
  take(key: string, now: number): number | null {
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - HOUR_MS);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return Math.ceil((recent[0]! + HOUR_MS - now) / 1000);
    }
    recent.push(now);
    this.hits.set(key, recent);
    return null;
  }
}

export class SponsorPolicy {
  private readonly perSender: SlidingWindow;
  private readonly perBadge: SlidingWindow;
  private readonly now: () => number;

  constructor(private readonly opts: PolicyOptions) {
    this.perSender = new SlidingWindow(opts.perSenderPerHour ?? 30);
    this.perBadge = new SlidingWindow(opts.perBadgePerHour ?? 10);
    this.now = opts.now ?? Date.now;
  }

  async check(intent: Intent, sender: string, badge?: string): Promise<PolicyDecision> {
    const shape = await this.checkShape(intent, sender);
    if (!shape.ok) return shape;

    const now = this.now();
    const waitSender = this.perSender.take(sender, now);
    if (waitSender !== null) return { ok: false, reason: `sponsor rate limit reached for ${sender}`, retryAfter: waitSender };
    if (badge) {
      const waitBadge = this.perBadge.take(badge, now);
      if (waitBadge !== null) return { ok: false, reason: `sponsor rate limit reached for badge ${badge}`, retryAfter: waitBadge };
    }
    return { ok: true };
  }

  private async checkShape(intent: Intent, sender: string): Promise<PolicyDecision> {
    if (intent.type === "contract") {
      return SPONSORED_ENTRYPOINTS.has(intent.entrypoint)
        ? { ok: true }
        : { ok: false, reason: `entrypoint "${intent.entrypoint}" is not sponsored` };
    }

    if (intent.token !== this.opts.rewardTokenId) return { ok: false, reason: `token ${intent.token} is not the reward token` };
    if (intent.amount <= 0n) return { ok: false, reason: "amount must be positive" };
    const m = MEMO.exec(intent.memo);
    if (!m) return { ok: false, reason: `memo "${intent.memo}" is not fund:<id> or bounty:<id>` };
    const id = BigInt(m[2]!);
    const facts = await this.opts.bounty(id);
    if (!facts) return { ok: false, reason: `no bounty ${id}` };
    if (facts.poster !== sender) return { ok: false, reason: "only the bounty's poster can fund or pay it" };

    if (m[1] === "fund") {
      return intent.to === this.opts.escrowAccount ? { ok: true } : { ok: false, reason: "funding transfers must go to the escrow account" };
    }
    return facts.payee !== null && intent.to === facts.payee
      ? { ok: true }
      : { ok: false, reason: "payments must go to the bounty's recorded worker" };
  }
}
