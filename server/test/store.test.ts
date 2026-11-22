import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Bounty } from "@bounty/shared";
import { BoardStore } from "../src/store/db.js";
import { syncFromChain } from "../src/store/sync.js";

const dbPath = () => join(mkdtempSync(join(tmpdir(), "board-")), "board.db");

function bounty(id: bigint, over: Partial<Bounty> = {}): Bounty {
  return {
    id,
    poster: "poster",
    posterAgent: null,
    kind: "Exclusive",
    specHash: "ab".repeat(32),
    reward: 1_000_000n,
    funding: { type: "NotFunded" },
    deadline: 1_800_000_000_000n,
    status: { type: "Open" },
    rejections: 0,
    lastRejectedAt: null,
    entryCount: 0,
    created: 1n,
    ...over,
  };
}

describe("BoardStore", () => {
  it("upserts bounties and filters them, keeping bigints", () => {
    const s = new BoardStore(dbPath());
    s.upsertBounty(bounty(0n));
    s.upsertBounty(bounty(1n, { kind: "Contest", funding: { type: "Escrowed", fundingTx: "11".repeat(32) } }));
    s.upsertBounty(bounty(0n, { status: { type: "Claimed", worker: "w", agent: 3n } }));
    expect(s.bounty(0n)?.status).toEqual({ type: "Claimed", worker: "w", agent: 3n });
    expect(s.bounty(1n)?.reward).toBe(1_000_000n);
    expect(s.bounties({}).map((b) => b.id)).toEqual([1n, 0n]); // newest first
    expect(s.bounties({ kind: "Contest" }).map((b) => b.id)).toEqual([1n]);
    expect(s.bounties({ status: "Claimed" }).map((b) => b.id)).toEqual([0n]);
    expect(s.bounties({ funding: "Escrowed" }).map((b) => b.id)).toEqual([1n]);
    expect(s.bounty(9n)).toBeNull();
  });

  it("stores specs and submissions by hash", () => {
    const s = new BoardStore(dbPath());
    s.putSpec("ab".repeat(32), '{"title":"t"}');
    expect(s.spec("ab".repeat(32))).toBe('{"title":"t"}');
    s.putSubmission({ workHash: "cd".repeat(32), bountyId: 0n, worker: "w", preview: "p", full: "f" });
    expect(s.submission("cd".repeat(32))).toMatchObject({ bountyId: 0n, worker: "w", preview: "p", full: "f" });
    expect(s.spec("00".repeat(32))).toBeNull();
  });

  it("records events once per transaction and index", () => {
    const s = new BoardStore(dbPath());
    const ev = [{ type: "Claimed" as const, id: 2n, worker: "w", agent: null }];
    s.recordEvents("aa".repeat(32), ev, 100);
    s.recordEvents("aa".repeat(32), ev, 100);
    expect(s.events(2n)).toEqual([{ tx: "aa".repeat(32), index: 0, at: 100, event: ev[0] }]);
  });

  it("keeps the escrow worker's write-ahead records across a restart", () => {
    const path = dbPath();
    const a = new BoardStore(path).escrow;
    a.addCandidate(4n);
    a.putTransfer({ key: "payout:4:w", hash: "ff".repeat(32), amount: 10n, expiresAt: 99 });
    a.markDeposit("ee".repeat(32), { confirmed: false, reason: "amount 1 does not equal the reward 10" });
    const b = new BoardStore(path).escrow;
    expect(b.candidates()).toEqual([4n]);
    expect(b.getTransfer("payout:4:w")).toEqual({ key: "payout:4:w", hash: "ff".repeat(32), amount: 10n, expiresAt: 99 });
    expect(b.depositOutcome("ee".repeat(32))).toEqual({ confirmed: false, reason: "amount 1 does not equal the reward 10" });
    expect(b.unmatchedDeposits()).toEqual([{ tx: "ee".repeat(32), reason: "amount 1 does not equal the reward 10" }]);
    b.removeCandidate(4n);
    expect(new BoardStore(path).escrow.candidates()).toEqual([]);
  });
});

describe("syncFromChain", () => {
  it("caches every bounty and queues escrowed, unfinished ones for the escrow worker", async () => {
    const s = new BoardStore(dbPath());
    const chain = {
      all: async () => [
        bounty(0n, { funding: { type: "Escrowed", fundingTx: "11".repeat(32) }, status: { type: "Accepted", worker: "w", at: 5n } }),
        bounty(1n),
        bounty(2n, { funding: { type: "Escrowed", fundingTx: "11".repeat(32) }, status: { type: "Paid" } }),
      ],
    };
    await syncFromChain(chain, s);
    expect(s.bounties({}).length).toBe(3);
    expect(s.escrow.candidates()).toEqual([0n]);
  });
});
