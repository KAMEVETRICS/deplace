import { describe, expect, it } from "vitest";
import type { Bounty, BountyStatus, Funding } from "@deplace/shared";
import { dueAction } from "../src/board/keeper.js";

const W = { reviewWindowMs: 60_000n, paymentWindowMs: 120_000n };
const escrowed: Funding = { type: "Escrowed", fundingTx: "11".repeat(32) };
const notFunded: Funding = { type: "NotFunded" };

function b(status: BountyStatus, over: Partial<Bounty> = {}): Bounty {
  return {
    id: 1n,
    poster: "p",
    posterAgent: null,
    kind: "Exclusive",
    specHash: "ab".repeat(32),
    reward: 10n,
    funding: notFunded,
    deadline: 1_000_000n,
    status,
    rejections: 0,
    lastRejectedAt: null,
    entryCount: 0,
    created: 0n,
    ...over,
  };
}
const submitted: BountyStatus = { type: "Submitted", worker: "w", agent: null, workHash: "cd".repeat(32), at: 500_000n };
const accepted: BountyStatus = { type: "Accepted", worker: "w", at: 500_000n, workHash: "cd".repeat(32) };

describe("keeper", () => {
  it("auto-accepts escrowed work the poster left unreviewed for a full review window", () => {
    expect(dueAction(b(submitted, { funding: escrowed }), 559_999n, W)).toBeNull();
    expect(dueAction(b(submitted, { funding: escrowed }), 560_000n, W)).toBe("auto_accept");
    expect(dueAction(b(submitted), 900_000n, W)).toBeNull(); // not funded: nothing to enforce
  });

  it("marks accepted or awarded not-funded bounties unpaid after the payment window", () => {
    expect(dueAction(b(accepted), 619_999n, W)).toBeNull();
    expect(dueAction(b(accepted), 620_000n, W)).toBe("mark_unpaid");
    expect(dueAction(b(accepted, { funding: escrowed }), 900_000n, W)).toBeNull(); // escrow worker pays these
    expect(dueAction(b({ type: "Awarded", entryId: 0, at: 500_000n }, { kind: "Contest" }), 620_000n, W)).toBe("mark_unpaid");
  });

  it("splits or closes contests nobody awarded once the review window after the deadline is over", () => {
    const open = (f: Funding) => b({ type: "Open" }, { kind: "Contest", entryCount: 2, funding: f });
    expect(dueAction(open(escrowed), 1_059_999n, W)).toBeNull();
    expect(dueAction(open(escrowed), 1_060_000n, W)).toBe("split_unawarded");
    expect(dueAction(open(notFunded), 1_060_000n, W)).toBe("no_award");
  });

  it("expires open bounties after the deadline, and empty contests", () => {
    expect(dueAction(b({ type: "Open" }), 1_000_000n, W)).toBeNull();
    expect(dueAction(b({ type: "Open" }), 1_000_001n, W)).toBe("expire");
    expect(dueAction(b({ type: "Open" }, { kind: "Contest" }), 1_000_001n, W)).toBe("expire");
  });

  it("expires a claim that was never delivered, honouring the grace after a rejection", () => {
    const claimed: BountyStatus = { type: "Claimed", worker: "w", agent: null };
    expect(dueAction(b(claimed), 1_000_001n, W)).toBe("expire");
    expect(dueAction(b(claimed, { lastRejectedAt: 990_000n, rejections: 1 }), 1_000_001n, W)).toBeNull();
    expect(dueAction(b(claimed, { lastRejectedAt: 990_000n, rejections: 1 }), 1_050_001n, W)).toBe("expire");
  });

  it("leaves settled bounties alone", () => {
    for (const s of [{ type: "Paid" }, { type: "Refunded" }, { type: "Cancelled" }, { type: "Expired" }, { type: "NoAward" }] as BountyStatus[]) {
      expect(dueAction(b(s, { funding: escrowed }), 10_000_000n, W)).toBeNull();
    }
  });
});
