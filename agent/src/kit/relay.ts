import { Transaction } from "@concordium/web-sdk";
import { txLink, type BoardEvent } from "@deplace/shared";
import type { KitChain } from "../chain.js";
import type { SpendBudget } from "../rails/budget.js";
import { checkPrepared, RailViolation, type GuardOptions } from "../rails/guard.js";
import { LockHeld, type AccountLock } from "../rails/lock.js";
import type { PendingStore, PendingTx } from "../rails/pending.js";
import { signPrepared, transactionHash, type AgentKeys } from "../signer.js";
import type { Send, SendStep } from "../steps.js";
import type { Relayed } from "../worker.js";
import type { BoardConfigView } from "./board-link.js";
import { KitError } from "./errors.js";

export interface RelayBoard {
  relay(txJson: string): Promise<Relayed>;
  config(deadline?: number): Promise<BoardConfigView>;
}

export interface RelayOptions {
  board: RelayBoard;
  keys: AgentKeys;
  guard: GuardOptions;
  chain: Pick<KitChain, "txOutcome" | "finalizedNonce">;
  pending: PendingStore;
  lock: AccountLock;
  budget: () => Promise<SpendBudget>;
  now?: () => number;
  log: (m: string) => void;
}

export type Settled = { record: PendingTx; landed: true; failed: boolean; events: BoardEvent[]; link: string } | { record: PendingTx; landed: false };

/** How soon to look again at a transaction the node has but not yet finalized. */
const PENDING_RECHECK_MS = 10_000;

/** The contract event that shows each action happened. The board answers a transaction the contract rejected like any other, with no events. */
const PROOF: Record<SendStep["expected"]["entrypoint"], string[]> = {
  claim: ["Claimed"],
  enter: ["Entered"],
  submit: ["Submitted"],
  post: ["Posted"],
  accept: ["Accepted"],
  reject: ["Rejected", "RejectedFinal"],
  award: ["Awarded"],
  cancel: ["Cancelled"],
};

const asRelayed = (events: BoardEvent[]): Relayed["events"] => events.map((e) => ({ type: e.type, ...("id" in e ? { id: e.id.toString() } : {}) }));

const iso = (ms: number) => new Date(ms).toISOString();
const what = (r: { action: string; bountyId: string | null }) => `${r.action}${r.bountyId ? ` of bounty ${r.bountyId}` : ""}`;

/**
 * How the kit signs. One turn at a time, because the board prepares every transaction with the
 * account's next nonce. A transaction is written down before it is sent, and never sent again
 * blind: when an answer is lost, the next turn for the same action looks it up on chain by hash.
 */
export class Relay {
  readonly send: Send;
  /** Bounties whose lost payment went through by the nonce rule (the board may not have recorded it yet). */
  readonly landedPayments = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private stopped: string | null = null;
  private readonly now: () => number;

  constructor(private readonly o: RelayOptions) {
    this.now = o.now ?? Date.now;
    this.send = (prepared, step) => this.sendNow(prepared, step);
  }

  turn<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      try {
        this.o.lock.acquire();
      } catch (e) {
        if (e instanceof LockHeld) throw new KitError(e.message, false, { lockHolderPid: e.holderPid });
        throw e;
      }
      const board = await this.o.board.config();
      const { index, subindex } = this.o.guard.contract;
      if (board.contract.index !== index.toString() || board.contract.subindex !== subindex.toString()) {
        throw new RailViolation(`the board says its contract is <${board.contract.index},${board.contract.subindex}>; this kit signs only for <${index},${subindex}>, so it signs nothing`);
      }
      await this.settlePayments();
      return fn();
    });
    this.queue = run.catch(() => undefined); // the next turn runs whatever happened to this one
    return run;
  }

  private async sendNow(prepared: { prepared: { txJson: string; notice?: string } }, step: SendStep): Promise<Relayed> {
    if (this.stopped) throw new RailViolation(this.stopped);
    if (prepared.prepared.notice) this.o.log(`note: ${prepared.prepared.notice}`);
    checkPrepared(prepared.prepared.txJson, [step.expected.entrypoint], this.o.guard, step.expected); // RailViolation instead of signing
    const signed = await signPrepared(this.o.keys, prepared.prepared.txJson);
    const hash = transactionHash(signed);
    const commitRef = step.onSigned?.(hash) || undefined;
    const expiresAt = Number(Transaction.signableFromJSON(JSON.parse(signed)).header.expiry.expiryEpochSeconds) * 1000;
    this.o.pending.add({ kind: "tx", action: step.action, bountyId: step.bountyId, hash, expiresAt, ...(commitRef ? { commitRef } : {}) });
    let r = await this.o.board.relay(signed); // any failure keeps the record: the transaction may still land
    if (r.txHash !== hash) {
      // It went through, but lost answers could no longer be looked up: stop before the next one.
      this.stopped = `the board names transaction ${r.txHash} what the kit hashed as ${hash}, so the kit could not find its own transactions after a lost answer; it signs nothing more until restarted (check ${r.link})`;
      this.o.log(this.stopped);
    }
    const proof = PROOF[step.expected.entrypoint];
    if (!r.events.some((e) => proof.includes(e.type))) {
      // No proof in the board's answer: the chain decides whether it failed, went through, or isn't known yet.
      const out = await this.o.chain.txOutcome(hash);
      if (out.state === "finalized" && out.failed) {
        this.o.pending.remove((x) => x.kind === "tx" && x.hash === hash);
        if (commitRef) {
          const budget = await this.o.budget();
          if (budget.has(commitRef)) budget.remove(commitRef);
        }
        throw new KitError(`the contract rejected the ${what(step)}, so nothing changed (${r.link})`, false, { rejectedOnChain: true, txHash: hash, link: r.link });
      }
      if (out.state !== "finalized" || !out.events.some((e) => proof.includes(e.type))) {
        throw new KitError(`the ${what(step)} was sent, but neither the board nor the chain shows its outcome yet (${r.link}); call the same tool again to see what happened`, true, {
          outcomeUnknown: true,
          txHash: hash,
          link: r.link,
        });
      }
      r = { ...r, events: asRelayed(out.events) };
    }
    this.o.pending.remove((x) => x.kind === "tx" && x.hash === hash);
    this.o.log(`${what(step)}: ${r.link}`);
    return r;
  }

  async settle(match: (r: PendingTx) => boolean): Promise<Settled[]> {
    const settled: Settled[] = [];
    let waitUntil: number | null = null;
    let waitingFor = "";
    for (const r of this.o.pending.list()) {
      if (r.kind !== "tx" || !match(r)) continue;
      const out = await this.o.chain.txOutcome(r.hash);
      if (out.state === "finalized") {
        if (r.commitRef) await this.applyPost(r.commitRef, out.failed, out.events);
        this.o.pending.remove((x) => x.kind === "tx" && x.hash === r.hash);
        settled.push({ record: r, landed: true, failed: out.failed, events: out.events, link: txLink(r.hash) });
      } else if (out.state === "absent" && this.now() > r.expiresAt) {
        if (r.commitRef) (await this.o.budget()).remove(r.commitRef);
        this.o.pending.remove((x) => x.kind === "tx" && x.hash === r.hash);
        settled.push({ record: r, landed: false });
      } else {
        const until = out.state === "pending" ? this.now() + PENDING_RECHECK_MS : r.expiresAt;
        if (waitUntil === null || until > waitUntil) waitUntil = until;
        waitingFor = what(r);
      }
    }
    if (waitUntil !== null) {
      throw new KitError(`an earlier ${waitingFor} may still go through; the kit sends nothing new for it before ${iso(waitUntil)}`, true, { retryAfter: iso(waitUntil) });
    }
    return settled;
  }

  /** A landed post's reward moves to its bounty; a post that failed on chain frees it. */
  private async applyPost(commitRef: string, failed: boolean, events: BoardEvent[]) {
    const budget = await this.o.budget();
    if (failed) return budget.remove(commitRef);
    const posted = events.find((e) => e.type === "Posted");
    if (posted && posted.type === "Posted") budget.rename(commitRef, `bounty:${posted.id}`);
  }

  async settlePayments(): Promise<{ landed: string[]; released: string[] }> {
    const landed: string[] = [];
    const released: string[] = [];
    let waitUntil: number | null = null;
    for (const r of this.o.pending.list()) {
      if (r.kind !== "payment") continue;
      if (this.now() <= r.expiresAt) {
        if (waitUntil === null || r.expiresAt > waitUntil) waitUntil = r.expiresAt;
        continue;
      }
      // Expired: if the account's nonce never got past the payment's, it never landed and never can.
      const next = await this.o.chain.finalizedNonce(this.o.keys.address);
      if (next <= BigInt(r.nonce)) {
        (await this.o.budget()).unbook(r.ref, BigInt(r.amount));
        released.push(r.bountyId);
        this.o.log(`the payment for bounty ${r.bountyId} never landed; its booking is released`);
      } else {
        landed.push(r.bountyId);
        this.landedPayments.add(r.bountyId);
        this.o.log(`the payment for bounty ${r.bountyId} went through on chain`);
      }
      this.o.pending.remove((x) => x.kind === "payment" && x.bountyId === r.bountyId && x.nonce === r.nonce);
    }
    if (waitUntil !== null) {
      throw new KitError(`a payment the kit sent has not been seen through yet, so it signs nothing for this account before ${iso(waitUntil)}`, true, {
        retryAfter: iso(waitUntil),
      });
    }
    return { landed, released };
  }
}
