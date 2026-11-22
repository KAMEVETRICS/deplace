import type { Bounty } from "@deplace/shared";

/**
 * The escrow worker moves escrowed EUDemo only when deplace's state says so:
 * it confirms exact deposits, pays accepted or awarded work, splits unawarded contests
 * and refunds cancelled, expired or finally rejected bounties. It is custodial (the
 * escrow is an account the board runs), so every transfer it makes is checkable
 * against the contract; Protocol-Level Locks will replace it.
 */

export interface DepositInfo {
  tx: string;
  /** False when the transaction was rejected on chain. */
  success: boolean;
  token: string;
  from: string;
  to: string;
  amount: bigint;
  memo: string | null;
}

export type TxState = { state: "success" } | { state: "failed"; reason: string } | { state: "pending" } | { state: "absent" };

export interface PreparedTransfer {
  /** Hash of the signed transaction, known before it is sent. */
  hash: string;
  /** Unix ms after which the transaction can no longer be included. */
  expiresAt: number;
  /** Sends it; resolves to the hash the node reports for it. */
  submit(): Promise<string>;
}

export interface EscrowChain {
  bounty(id: bigint): Promise<Bounty | null>;
  split(id: bigint): Promise<{ to: string; amount: bigint }[]>;
  entryWorker(id: bigint, entryId: number): Promise<string | null>;
  /** The PLT transfer inside a finalized transaction, or null if not finalized or not a transfer. */
  transferInfo(tx: string): Promise<DepositInfo | null>;
  prepareTransfer(to: string, amount: bigint, memo: string): Promise<PreparedTransfer>;
  txStatus(hash: string): Promise<TxState>;
  confirmFunding(id: bigint, tx: string): Promise<void>;
  recordPayout(id: bigint, payouts: { to: string; amount: bigint; tx: string }[]): Promise<void>;
  recordRefund(id: bigint, tx: string): Promise<void>;
}

export interface StoredTransfer {
  key: string;
  hash: string;
  amount: bigint;
  expiresAt: number;
  failedAt?: number;
  failure?: string;
}

export type DepositOutcome = { confirmed: true } | { confirmed: false; reason: string };

export interface EscrowStore {
  candidates(): bigint[];
  addCandidate(id: bigint): void;
  removeCandidate(id: bigint): void;
  getTransfer(key: string): StoredTransfer | undefined;
  /** Must be durable before the transfer is submitted (write-ahead). */
  putTransfer(t: StoredTransfer): void;
  depositOutcome(tx: string): DepositOutcome | undefined;
  markDeposit(tx: string, outcome: DepositOutcome): void;
  unmatchedDeposits(): { tx: string; reason: string }[];
}

export class MemoryEscrowStore implements EscrowStore {
  private readonly ids = new Set<bigint>();
  private readonly transfers = new Map<string, StoredTransfer>();
  private readonly deposits = new Map<string, DepositOutcome>();
  candidates() {
    return [...this.ids];
  }
  addCandidate(id: bigint) {
    this.ids.add(id);
  }
  removeCandidate(id: bigint) {
    this.ids.delete(id);
  }
  getTransfer(key: string) {
    return this.transfers.get(key);
  }
  putTransfer(t: StoredTransfer) {
    this.transfers.set(t.key, { ...t });
  }
  depositOutcome(tx: string) {
    return this.deposits.get(tx);
  }
  markDeposit(tx: string, outcome: DepositOutcome) {
    this.deposits.set(tx, outcome);
  }
  unmatchedDeposits() {
    return [...this.deposits].flatMap(([tx, o]) => (o.confirmed ? [] : [{ tx, reason: o.reason }]));
  }
}

export interface EscrowWorkerOptions {
  chain: EscrowChain;
  store: EscrowStore;
  escrowAccount: string;
  rewardToken: string;
  now?: () => number;
  /** Wait this long before retrying a transfer the chain rejected. */
  retryBackoffMs?: number;
}

interface Plan {
  kind: "payout" | "refund";
  transfers: { to: string; amount: bigint }[];
}

const FUNDABLE = new Set(["Open", "Claimed", "Submitted"]);
/** Wait this long past a transfer's expiry before concluding it never reached the chain. */
const EXPIRY_GRACE_MS = 5 * 60_000;
const FINISHED = new Set(["Paid", "Refunded", "NoAward"]);

export class EscrowWorker {
  private readonly now: () => number;
  private readonly backoff: number;
  private readonly failures = new Map<bigint, { id: bigint; reason: string; at: number }>();

  constructor(private readonly o: EscrowWorkerOptions) {
    this.now = o.now ?? Date.now;
    this.backoff = o.retryBackoffMs ?? 5 * 60_000;
  }

  health() {
    return { failures: [...this.failures.values()], unmatchedDeposits: this.o.store.unmatchedDeposits() };
  }

  /**
   * Confirms a deposit into escrow if it exactly funds a fundable bounty; otherwise records it
   * as unmatched. A memo `fund:<id>` names the bounty; x402 payments carry no memo, so the
   * funding route passes the bounty id it set the payment terms for.
   */
  async noteDeposit(tx: string, opts: { bountyId?: bigint } = {}): Promise<DepositOutcome> {
    const previous = this.o.store.depositOutcome(tx);
    if (previous) return previous;
    const info = await this.o.chain.transferInfo(tx);
    if (!info) return { confirmed: false, reason: "transaction not finalized yet, or not a token transfer" };

    const checked = await this.checkDeposit(info, opts.bountyId);
    if ("reason" in checked) {
      const outcome: DepositOutcome = { confirmed: false, reason: checked.reason };
      this.o.store.markDeposit(tx, outcome);
      return outcome;
    }
    await this.o.chain.confirmFunding(checked.id, tx);
    const outcome: DepositOutcome = { confirmed: true };
    this.o.store.markDeposit(tx, outcome);
    this.o.store.addCandidate(checked.id);
    return outcome;
  }

  /** One pass over every bounty that may need an escrow transfer. Errors are recorded per bounty. */
  async tick(): Promise<void> {
    for (const id of this.o.store.candidates()) {
      try {
        await this.handle(id);
      } catch (e) {
        this.fail(id, `escrow step failed: ${(e as Error).message}`);
      }
    }
  }

  /** The bounty this deposit exactly funds, or why it funds none. */
  private async checkDeposit(info: DepositInfo, expectedId?: bigint): Promise<{ id: bigint } | { reason: string }> {
    if (!info.success) return { reason: "transfer was rejected on chain" };
    if (info.token !== this.o.rewardToken) return { reason: `token ${info.token} is not the reward token` };
    if (info.to !== this.o.escrowAccount) return { reason: "not sent to the escrow account" };
    let id: bigint;
    if (info.memo === null && expectedId !== undefined) {
      id = expectedId;
    } else {
      const m = /^fund:(\d{1,20})$/.exec(info.memo ?? "");
      if (!m) return { reason: `memo ${JSON.stringify(info.memo)} is not fund:<id>` };
      id = BigInt(m[1]!);
      if (expectedId !== undefined && id !== expectedId) return { reason: `memo names bounty ${id}, but the payment was for bounty ${expectedId}` };
    }
    const b = await this.o.chain.bounty(id);
    if (!b) return { reason: `no bounty ${id}` };
    if (b.funding.type === "Escrowed") return { reason: `bounty ${id} is already escrowed` };
    if (!FUNDABLE.has(b.status.type)) return { reason: `bounty ${id} can no longer be funded (status ${b.status.type})` };
    if (info.from !== b.poster) return { reason: "deposit is not from the bounty's poster" };
    if (info.amount !== b.reward) return { reason: `amount ${info.amount} does not equal the reward ${b.reward}` };
    return { id };
  }

  private async plan(b: Bounty): Promise<Plan | null> {
    const s = b.status;
    switch (s.type) {
      case "Accepted":
        return { kind: "payout", transfers: [{ to: s.worker, amount: b.reward }] };
      case "Awarded": {
        const winner = await this.o.chain.entryWorker(b.id, s.entryId);
        if (!winner) throw new Error(`entry ${s.entryId} of bounty ${b.id} not found`);
        return { kind: "payout", transfers: [{ to: winner, amount: b.reward }] };
      }
      case "Splitting":
        return { kind: "payout", transfers: await this.o.chain.split(b.id) };
      case "Cancelled":
      case "Expired":
      case "RejectedFinal":
        return { kind: "refund", transfers: [{ to: b.poster, amount: b.reward }] };
      default:
        return null;
    }
  }

  private async handle(id: bigint) {
    const b = await this.o.chain.bounty(id);
    if (!b || FINISHED.has(b.status.type)) {
      this.o.store.removeCandidate(id);
      return;
    }
    if (b.funding.type !== "Escrowed") return; // not-funded bounties are paid on delivery (x402)
    const plan = await this.plan(b);
    if (!plan || plan.transfers.length === 0) return;

    const memo = plan.kind === "payout" ? `bounty:${id}` : `refund:${id}`;
    const hashes: (string | null)[] = [];
    for (const t of plan.transfers) hashes.push(await this.ensureTransfer(id, plan.kind, t.to, t.amount, memo));
    if (hashes.some((h) => h === null)) return; // some transfer is still on its way

    if (plan.kind === "payout") {
      await this.o.chain.recordPayout(
        id,
        plan.transfers.map((t, i) => ({ to: t.to, amount: t.amount, tx: hashes[i]! })),
      );
    } else {
      await this.o.chain.recordRefund(id, hashes[0]!);
    }
    this.failures.delete(id);
    this.o.store.removeCandidate(id);
  }

  /**
   * Returns the hash of a successful transfer for (kind, bounty, recipient), or null while
   * one is pending. The hash is stored before submitting, so a restart finds and reuses
   * it instead of paying twice.
   */
  private async ensureTransfer(id: bigint, kind: Plan["kind"], to: string, amount: bigint, memo: string): Promise<string | null> {
    const key = `${kind}:${id}:${to}`;
    const stored = this.o.store.getTransfer(key);
    if (stored) {
      const st = await this.o.chain.txStatus(stored.hash);
      if (st.state === "success") return stored.hash;
      if (st.state === "pending") return null;
      // An unknown hash may still be propagating or the local clock may be ahead: only treat it
      // as never landed once its expiry is well past, or a late arrival would pay twice.
      if (st.state === "absent" && this.now() < stored.expiresAt + EXPIRY_GRACE_MS) return null;
      if (st.state === "failed") {
        if (stored.failedAt === undefined) {
          const reason = `transfer ${stored.hash} failed: ${st.reason}`;
          this.o.store.putTransfer({ ...stored, failedAt: this.now(), failure: reason });
          this.fail(id, reason);
          return null;
        }
        if (this.now() - stored.failedAt < this.backoff) {
          // Keep it visible in health, also after a restart (failures are kept in memory).
          this.fail(id, stored.failure ?? `transfer ${stored.hash} failed`, stored.failedAt);
          return null;
        }
      }
      // Failed and backed off, or expired without ever reaching the chain: send a new one.
    }
    const p = await this.o.chain.prepareTransfer(to, amount, memo);
    this.o.store.putTransfer({ key, hash: p.hash, amount, expiresAt: p.expiresAt });
    const named = await p.submit();
    if (named !== p.hash) {
      // Track the transfer by the node's name for it: under the computed hash it would look
      // lost once expired, and be sent a second time.
      this.o.store.putTransfer({ key, hash: named, amount, expiresAt: p.expiresAt });
      this.fail(id, `the node named transfer ${named}, not the computed ${p.hash}; tracking the node's hash`);
    }
    return null;
  }

  private fail(id: bigint, reason: string, at = this.now()) {
    this.failures.set(id, { id, reason, at });
  }
}
