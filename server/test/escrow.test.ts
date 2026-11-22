import { beforeEach, describe, expect, it } from "vitest";
import type { Bounty, BountyStatus, Funding } from "@deplace/shared";
import { EscrowWorker, MemoryEscrowStore, type DepositInfo, type EscrowChain, type TxState } from "../src/escrow/worker.js";

const ESCROW = "escrow-acct";
const POSTER = "poster-acct";
const WORKER = "worker-acct";
const TX = (n: number) => n.toString(16).padStart(64, "0");

function bounty(id: bigint, status: BountyStatus, funding: Funding, over: Partial<Bounty> = {}): Bounty {
  return {
    id,
    poster: POSTER,
    posterAgent: null,
    kind: "Exclusive",
    specHash: "ab".repeat(32),
    reward: 100n,
    funding,
    deadline: 0n,
    status,
    rejections: 0,
    lastRejectedAt: null,
    entryCount: 0,
    created: 0n,
    ...over,
  };
}

const escrowed: Funding = { type: "Escrowed", fundingTx: TX(1) };

/** An in-memory chain: bounties, transfer outcomes, and every call the worker makes. */
class FakeChain implements EscrowChain {
  bounties = new Map<bigint, Bounty>();
  deposits = new Map<string, DepositInfo>();
  splits = new Map<bigint, { to: string; amount: bigint }[]>();
  winners = new Map<string, string>();
  status = new Map<string, TxState>();
  sent: { to: string; amount: bigint; memo: string; hash: string }[] = [];
  confirmed: [bigint, string][] = [];
  payouts: [bigint, { to: string; amount: bigint; tx: string }[]][] = [];
  refunds: [bigint, string][] = [];
  failRecordOnce = false;
  private n = 100;

  async bounty(id: bigint) {
    return this.bounties.get(id) ?? null;
  }
  async split(id: bigint) {
    return this.splits.get(id) ?? [];
  }
  async entryWorker(id: bigint, entryId: number) {
    return this.winners.get(`${id}:${entryId}`) ?? null;
  }
  async transferInfo(tx: string) {
    return this.deposits.get(tx) ?? null;
  }
  async prepareTransfer(to: string, amount: bigint, memo: string) {
    const hash = TX(this.n++);
    return {
      hash,
      expiresAt: 10_000,
      submit: async () => {
        this.sent.push({ to, amount, memo, hash });
        this.status.set(hash, { state: "pending" });
      },
    };
  }
  async txStatus(hash: string): Promise<TxState> {
    return this.status.get(hash) ?? { state: "absent" };
  }
  async confirmFunding(id: bigint, tx: string) {
    this.confirmed.push([id, tx]);
    const b = this.bounties.get(id)!;
    this.bounties.set(id, { ...b, funding: { type: "Escrowed", fundingTx: tx } });
  }
  async recordPayout(id: bigint, payouts: { to: string; amount: bigint; tx: string }[]) {
    if (this.failRecordOnce) {
      this.failRecordOnce = false;
      throw new Error("node unreachable");
    }
    this.payouts.push([id, payouts]);
    this.bounties.set(id, { ...this.bounties.get(id)!, status: { type: "Paid" } });
  }
  async recordRefund(id: bigint, tx: string) {
    this.refunds.push([id, tx]);
    this.bounties.set(id, { ...this.bounties.get(id)!, status: { type: "Refunded" } });
  }
  finalizeAll(state: TxState = { state: "success" }) {
    for (const s of this.sent) if (this.status.get(s.hash)?.state === "pending") this.status.set(s.hash, state);
  }
}

let chain: FakeChain;
let store: MemoryEscrowStore;
let now: number;
const worker = () =>
  new EscrowWorker({ chain, store, escrowAccount: ESCROW, rewardToken: "EUDemo", now: () => now, retryBackoffMs: 60_000 });

beforeEach(() => {
  chain = new FakeChain();
  store = new MemoryEscrowStore();
  now = 1_000;
});

function deposit(tx: string, over: Partial<DepositInfo> = {}): DepositInfo {
  const d: DepositInfo = { tx, success: true, token: "EUDemo", from: POSTER, to: ESCROW, amount: 100n, memo: "fund:1", ...over };
  chain.deposits.set(tx, d);
  return d;
}

describe("escrow deposits", () => {
  beforeEach(() => {
    chain.bounties.set(1n, bounty(1n, { type: "Open" }, { type: "NotFunded" }));
  });

  it("confirms an exact deposit from the poster with memo fund:<id>, once", async () => {
    deposit(TX(5));
    expect(await worker().noteDeposit(TX(5))).toEqual({ confirmed: true });
    expect(await worker().noteDeposit(TX(5))).toEqual({ confirmed: true });
    expect(chain.confirmed).toEqual([[1n, TX(5)]]);
  });

  it("unmatched_amount_not_confirmed", async () => {
    deposit(TX(5), { amount: 99n });
    expect(await worker().noteDeposit(TX(5))).toMatchObject({ confirmed: false, reason: expect.stringMatching(/amount/) });
    deposit(TX(6), { amount: 101n });
    expect(await worker().noteDeposit(TX(6))).toMatchObject({ confirmed: false });
    expect(chain.confirmed).toEqual([]);
    expect(store.unmatchedDeposits().map((u) => u.tx)).toEqual([TX(5), TX(6)]);
  });

  it("wrong_memo_not_confirmed", async () => {
    deposit(TX(5), { memo: "bounty:1" });
    deposit(TX(6), { memo: null });
    deposit(TX(7), { memo: "fund:2" });
    for (const tx of [TX(5), TX(6), TX(7)]) expect((await worker().noteDeposit(tx)).confirmed).toBe(false);
    expect(chain.confirmed).toEqual([]);
  });

  it("second_deposit_not_confirmed", async () => {
    deposit(TX(5));
    deposit(TX(6));
    await worker().noteDeposit(TX(5));
    expect(await worker().noteDeposit(TX(6))).toMatchObject({ confirmed: false, reason: expect.stringMatching(/already escrowed/) });
    expect(chain.confirmed).toEqual([[1n, TX(5)]]);
  });

  it("refuses deposits from someone other than the poster, to another account, in another token, or failed", async () => {
    deposit(TX(5), { from: "stranger" });
    deposit(TX(6), { to: "elsewhere" });
    deposit(TX(7), { token: "USDR" });
    deposit(TX(8), { success: false });
    for (const tx of [TX(5), TX(6), TX(7), TX(8)]) expect((await worker().noteDeposit(tx)).confirmed).toBe(false);
    expect(chain.confirmed).toEqual([]);
  });

  it("does not mark a deposit that is not finalized yet", async () => {
    expect(await worker().noteDeposit(TX(9))).toMatchObject({ confirmed: false, reason: expect.stringMatching(/not finalized/) });
    deposit(TX(9));
    expect(await worker().noteDeposit(TX(9))).toEqual({ confirmed: true });
  });

  it("confirms a memo-less x402 deposit when the funding route names the bounty", async () => {
    deposit(TX(5), { memo: null }); // the x402 Concordium client sends no memo
    expect(await worker().noteDeposit(TX(5), { bountyId: 1n })).toEqual({ confirmed: true });
    expect(chain.confirmed).toEqual([[1n, TX(5)]]);
  });

  it("still checks amount and sender for a named bounty, and refuses a memo naming another bounty", async () => {
    deposit(TX(5), { memo: null, amount: 99n });
    deposit(TX(6), { memo: null, from: "stranger" });
    deposit(TX(7), { memo: "fund:2" });
    for (const tx of [TX(5), TX(6), TX(7)]) expect((await worker().noteDeposit(tx, { bountyId: 1n })).confirmed).toBe(false);
    expect(chain.confirmed).toEqual([]);
  });

  it("refuses funding once the bounty is accepted", async () => {
    chain.bounties.set(1n, bounty(1n, { type: "Accepted", worker: WORKER, at: 0n, workHash: "cd".repeat(32) }, { type: "NotFunded" }));
    deposit(TX(5));
    expect((await worker().noteDeposit(TX(5))).confirmed).toBe(false);
  });
});

describe("escrow payouts and refunds", () => {
  it("pays the worker of an accepted escrowed bounty and records it", async () => {
    chain.bounties.set(1n, bounty(1n, { type: "Accepted", worker: WORKER, at: 0n, workHash: "cd".repeat(32) }, escrowed));
    store.addCandidate(1n);
    const w = worker();
    await w.tick();
    expect(chain.sent).toEqual([{ to: WORKER, amount: 100n, memo: "bounty:1", hash: TX(100) }]);
    expect(chain.payouts).toEqual([]); // waits for finalization
    chain.finalizeAll();
    await w.tick();
    expect(chain.payouts).toEqual([[1n, [{ to: WORKER, amount: 100n, tx: TX(100) }]]]);
    await w.tick();
    expect(chain.sent).toHaveLength(1);
  });

  it("restart_after_transfer_before_record_does_not_double_pay", async () => {
    chain.bounties.set(1n, bounty(1n, { type: "Accepted", worker: WORKER, at: 0n, workHash: "cd".repeat(32) }, escrowed));
    store.addCandidate(1n);
    await worker().tick(); // transfer submitted
    chain.finalizeAll();
    chain.failRecordOnce = true;
    await worker().tick(); // transfer final, recording fails ("crash")
    expect(chain.payouts).toEqual([]);
    await worker().tick(); // a fresh worker (restart) with the same store
    expect(chain.sent).toHaveLength(1);
    expect(chain.payouts).toEqual([[1n, [{ to: WORKER, amount: 100n, tx: TX(100) }]]]);
  });

  it("payout_failure_not_allow_listed_leaves_accepted", async () => {
    chain.bounties.set(1n, bounty(1n, { type: "Accepted", worker: WORKER, at: 0n, workHash: "cd".repeat(32) }, escrowed));
    store.addCandidate(1n);
    const w = worker();
    await w.tick();
    chain.finalizeAll({ state: "failed", reason: "recipient is not on the allow list" });
    await w.tick();
    expect(chain.payouts).toEqual([]);
    expect(chain.bounties.get(1n)!.status.type).toBe("Accepted");
    expect(w.health().failures).toEqual([{ id: 1n, reason: expect.stringMatching(/allow list/), at: 1_000 }]);

    await w.tick(); // inside the back-off window: no new transfer
    expect(chain.sent).toHaveLength(1);
    now += 60_000;
    await w.tick(); // retry with a new transfer
    expect(chain.sent).toHaveLength(2);
  });

  it("keeps a failed payout visible in health after a restart", async () => {
    chain.bounties.set(1n, bounty(1n, { type: "Accepted", worker: WORKER, at: 0n, workHash: "cd".repeat(32) }, escrowed));
    store.addCandidate(1n);
    await worker().tick();
    chain.finalizeAll({ state: "failed", reason: "recipient is not on the allow list" });
    await worker().tick(); // failure recorded
    now += 10_000;
    const restarted = worker(); // inside the back-off window
    await restarted.tick();
    expect(restarted.health().failures).toEqual([{ id: 1n, reason: expect.stringMatching(/allow list/), at: 1_000 }]);
  });

  it("resends a transfer that expired without reaching the chain, but only after a safety margin", async () => {
    chain.bounties.set(1n, bounty(1n, { type: "Accepted", worker: WORKER, at: 0n, workHash: "cd".repeat(32) }, escrowed));
    store.addCandidate(1n);
    await worker().tick();
    chain.status.delete(TX(100)); // the node never saw it
    now = 20_000; // just after its expiry: it could still be propagating
    await worker().tick();
    expect(chain.sent.map((s) => s.hash)).toEqual([TX(100)]);
    now = 10_000 + 5 * 60_000 + 1; // expiry plus the margin
    await worker().tick();
    expect(chain.sent.map((s) => s.hash)).toEqual([TX(100), TX(101)]);
  });

  it("pays a contest winner", async () => {
    chain.bounties.set(2n, bounty(2n, { type: "Awarded", entryId: 1, at: 0n }, escrowed, { kind: "Contest" }));
    chain.winners.set("2:1", "winner-acct");
    store.addCandidate(2n);
    const w = worker();
    await w.tick();
    chain.finalizeAll();
    await w.tick();
    expect(chain.payouts).toEqual([[2n, [{ to: "winner-acct", amount: 100n, tx: TX(100) }]]]);
  });

  it("split_sends_n_transfers_with_remainder_to_entry0", async () => {
    chain.bounties.set(3n, bounty(3n, { type: "Splitting", at: 0n }, escrowed, { kind: "Contest" }));
    chain.splits.set(3n, [
      { to: "a", amount: 34n },
      { to: "b", amount: 33n },
      { to: "c", amount: 33n },
    ]);
    store.addCandidate(3n);
    const w = worker();
    await w.tick();
    expect(chain.sent.map((s) => [s.to, s.amount, s.memo])).toEqual([
      ["a", 34n, "bounty:3"],
      ["b", 33n, "bounty:3"],
      ["c", 33n, "bounty:3"],
    ]);
    chain.finalizeAll();
    await w.tick();
    expect(chain.payouts[0]![1].map((p) => [p.to, p.amount])).toEqual([
      ["a", 34n],
      ["b", 33n],
      ["c", 33n],
    ]);
  });

  it("refund_states: cancelled, expired and finally rejected escrowed bounties go back to the poster", async () => {
    const states: BountyStatus[] = [{ type: "Cancelled" }, { type: "Expired" }, { type: "RejectedFinal" }];
    states.forEach((s, i) => {
      chain.bounties.set(BigInt(i + 1), bounty(BigInt(i + 1), s, escrowed));
      store.addCandidate(BigInt(i + 1));
    });
    const w = worker();
    await w.tick();
    expect(chain.sent.map((s) => [s.to, s.memo])).toEqual([
      [POSTER, "refund:1"],
      [POSTER, "refund:2"],
      [POSTER, "refund:3"],
    ]);
    chain.finalizeAll();
    await w.tick();
    expect(chain.refunds.map(([id]) => id)).toEqual([1n, 2n, 3n]);
  });

  it("leaves not-funded bounties alone (they are paid on delivery through x402)", async () => {
    chain.bounties.set(1n, bounty(1n, { type: "Accepted", worker: WORKER, at: 0n, workHash: "cd".repeat(32) }, { type: "NotFunded" }));
    store.addCandidate(1n);
    await worker().tick();
    expect(chain.sent).toEqual([]);
  });
});
