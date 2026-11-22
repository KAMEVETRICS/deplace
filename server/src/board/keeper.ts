import type { Bounty } from "@deplace/shared";

export type KeeperAction = "auto_accept" | "mark_unpaid" | "split_unawarded" | "no_award" | "expire";

/**
 * The permissionless, time-based contract action now due for a bounty, if any. Mirrors the
 * deplace rules so the board's keeper only sends calls the contract will accept:
 * silent posters cannot trap escrowed work, unpaid promises reach the public record, and
 * unawarded escrowed contests are split among entrants.
 */
export function dueAction(b: Bounty, nowMs: bigint, w: { reviewWindowMs: bigint; paymentWindowMs: bigint }): KeeperAction | null {
  const s = b.status;
  const escrowed = b.funding.type === "Escrowed";
  switch (s.type) {
    case "Submitted":
      return escrowed && nowMs >= s.at + w.reviewWindowMs ? "auto_accept" : null;
    case "Accepted":
    case "Awarded":
      return !escrowed && nowMs >= s.at + w.paymentWindowMs ? "mark_unpaid" : null;
    case "Claimed": {
      const grace = b.lastRejectedAt !== null ? b.lastRejectedAt + w.reviewWindowMs : 0n;
      const until = grace > b.deadline ? grace : b.deadline;
      return nowMs > until ? "expire" : null;
    }
    case "Open":
      if (b.kind === "Contest" && b.entryCount > 0) {
        if (nowMs < b.deadline + w.reviewWindowMs) return null;
        return escrowed ? "split_unawarded" : "no_award";
      }
      return nowMs > b.deadline ? "expire" : null;
    default:
      return null;
  }
}
