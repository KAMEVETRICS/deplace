import { describe, expect, it } from "vitest";
import type { BoardEvent, Bounty, BountyStatus } from "@deplace/shared";
import { auditEscrow } from "../src/escrow/audit.js";
import type { DepositInfo } from "../src/escrow/worker.js";

const ESCROW = "escrow";
const POSTER = "poster";
const W = "worker";
const T = (n: number) => n.toString(16).padStart(64, "0");

function b(id: bigint, status: BountyStatus, fundingTx = T(id === 0n ? 100 : 200 + Number(id))): Bounty {
  return {
    id,
    poster: POSTER,
    posterAgent: null,
    kind: "Exclusive",
    specHash: "ab".repeat(32),
    reward: 100n,
    funding: { type: "Escrowed", fundingTx },
    deadline: 0n,
    status,
    rejections: 0,
    lastRejectedAt: null,
    entryCount: 0,
    created: 0n,
  };
}

function chain(transfers: DepositInfo[]) {
  const m = new Map(transfers.map((t) => [t.tx, t]));
  return async (tx: string) => m.get(tx) ?? null;
}
const transfer = (tx: string, from: string, to: string, amount: bigint, memo: string): DepositInfo => ({ tx, success: true, token: "EUDemo", from, to, amount, memo });

describe("escrow audit", () => {
  it("passes when every escrowed bounty is funded, paid as recorded, and the balance covers what is owed", async () => {
    const bounties = [b(0n, { type: "Paid" }), b(1n, { type: "Open" })];
    const events = new Map<bigint, BoardEvent[]>([[0n, [{ type: "PayoutRecorded", id: 0n, to: W, amount: 100n, tx: T(300) }]]]);
    const r = await auditEscrow({
      escrowAccount: ESCROW,
      rewardToken: "EUDemo",
      bounties,
      events: (id) => events.get(id) ?? [],
      transferInfo: chain([
        transfer(T(100), POSTER, ESCROW, 100n, "fund:0"),
        transfer(T(201), POSTER, ESCROW, 100n, "fund:1"),
        transfer(T(300), ESCROW, W, 100n, "bounty:0"),
      ]),
      escrowBalance: 100n,
    });
    expect(r.ok).toBe(true);
    expect(r.liabilities).toBe(100n);
    expect(r.rows.map((x) => x.notes)).toEqual([[], []]);
  });

  it("flags a payout that does not match the chain", async () => {
    const r = await auditEscrow({
      escrowAccount: ESCROW,
      rewardToken: "EUDemo",
      bounties: [b(0n, { type: "Paid" })],
      events: () => [{ type: "PayoutRecorded", id: 0n, to: W, amount: 100n, tx: T(300) }],
      transferInfo: chain([transfer(T(100), POSTER, ESCROW, 100n, "fund:0"), transfer(T(300), ESCROW, "someone-else", 100n, "bounty:0")]),
      escrowBalance: 0n,
    });
    expect(r.ok).toBe(false);
    expect(r.rows[0]!.notes.join(" ")).toMatch(/payout .* does not match/);
  });

  it("flags a funding transaction that is not a matching deposit", async () => {
    const r = await auditEscrow({
      escrowAccount: ESCROW,
      rewardToken: "EUDemo",
      bounties: [b(1n, { type: "Open" })],
      events: () => [],
      transferInfo: chain([transfer(T(201), POSTER, ESCROW, 50n, "fund:1")]),
      escrowBalance: 100n,
    });
    expect(r.ok).toBe(false);
    expect(r.rows[0]!.notes.join(" ")).toMatch(/funding/);
  });

  it("fails when the escrow balance does not cover the rewards still owed", async () => {
    const r = await auditEscrow({
      escrowAccount: ESCROW,
      rewardToken: "EUDemo",
      bounties: [b(1n, { type: "Accepted", worker: W, at: 0n, workHash: "cd".repeat(32) })],
      events: () => [],
      transferInfo: chain([transfer(T(201), POSTER, ESCROW, 100n, "fund:1")]),
      escrowBalance: 99n,
    });
    expect(r.ok).toBe(false);
    expect(r.liabilities).toBe(100n);
    expect(r.shortfall).toBe(1n);
  });

  it("checks refunds go back to the poster", async () => {
    const ok = await auditEscrow({
      escrowAccount: ESCROW,
      rewardToken: "EUDemo",
      bounties: [b(1n, { type: "Refunded" })],
      events: () => [{ type: "RefundRecorded", id: 1n, tx: T(400) }],
      transferInfo: chain([transfer(T(201), POSTER, ESCROW, 100n, "fund:1"), transfer(T(400), ESCROW, POSTER, 100n, "refund:1")]),
      escrowBalance: 0n,
    });
    expect(ok.ok).toBe(true);
  });

  it("ignores not-funded bounties", async () => {
    const nf: Bounty = { ...b(5n, { type: "Paid" }), funding: { type: "NotFunded" } };
    const r = await auditEscrow({ escrowAccount: ESCROW, rewardToken: "EUDemo", bounties: [nf], events: () => [], transferInfo: chain([]), escrowBalance: 0n });
    expect(r.rows).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
