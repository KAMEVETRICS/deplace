import { createHash } from "node:crypto";
import { AccountAddress, Transaction, buildBasicAccountSigner } from "@concordium/web-sdk";
import { parseTokenAmount, type BountyKind } from "@deplace/shared";
import type { PaymentPayload } from "@x402/core/types";
import { CONCORDIUM_TESTNET_CAIP2 } from "@x402/concordium";
import { ExactConcordiumScheme } from "@x402/concordium/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import type { ChainReads } from "./chain.js";
import type { SpendBudget } from "./rails/budget.js";
import { RailViolation, reasonHash, type ExpectedCall } from "./rails/guard.js";
import { guardedPaymentClient, type GuardedPaymentOptions } from "./rails/payments.js";
import type { PendingPayment, PendingStore } from "./rails/pending.js";
import { specHashFor, type SpecFields } from "./rails/spec-hash.js";
import type { AgentKeys } from "./signer.js";
import { signAndSubmit, type Board, type Relayed, type WorkerOptions } from "./worker.js";

// The board sequences, each held once: the reference agent sends through directSend, the kit
// through its relay (which adds a signing queue, an account lock and pending records).

type Prepared = { prepared: { txJson: string; notice?: string } };

/** onSigned runs after signing and before sending; it returns the budget ref it committed, if any (the relay keeps it with the pending record). */
export interface SendStep {
  action: string;
  bountyId: string | null;
  expected: ExpectedCall;
  onSigned?: (hash: string) => string | void;
  /** Keep the pending record after a normal answer, until the caller has reported the result (the kit's relay.done). */
  keep?: boolean;
}

/** Checks a prepared transaction against the rails and what was asked, signs it and has the board relay it. */
export type Send = (prepared: Prepared, step: SendStep) => Promise<Relayed>;

export interface StepContext {
  board: Board;
  session: string;
  /** The agent's own token id: the agent a claim, entry or post must name. */
  agent: bigint | null;
  send: Send;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The reference agent's Send: check, sign and relay at once. */
export function directSend(o: Pick<WorkerOptions, "board" | "keys" | "guard" | "log">): Send {
  return (prepared, step) => signAndSubmit(o, prepared, [step.expected.entrypoint], step.expected, step.onSigned);
}

export async function claimStep(c: StepContext, id: string): Promise<Relayed> {
  const prepared = await c.board.call<Prepared>("prepare_claim", { session: c.session, bounty_id: id });
  return c.send(prepared, { action: "claim", bountyId: id, expected: { entrypoint: "claim", bountyId: BigInt(id), agent: c.agent } });
}

/** Submits for an Exclusive bounty the agent claimed, or enters a contest. */
export async function submitStep(c: StepContext, id: string, kind: BountyKind, work: { preview: string; full: string }): Promise<Relayed> {
  const prepared = await c.board.call<Prepared>("prepare_submit", { session: c.session, bounty_id: id, preview: work.preview, full: work.full });
  const workHash = sha256(work.full);
  const expected: ExpectedCall =
    kind === "Exclusive" ? { entrypoint: "submit", bountyId: BigInt(id), workHash } : { entrypoint: "enter", bountyId: BigInt(id), agent: c.agent, workHash };
  return c.send(prepared, { action: expected.entrypoint, bountyId: id, expected });
}

export async function posterActionStep(c: StepContext, action: "accept" | "cancel", id: string): Promise<Relayed> {
  const prepared = await c.board.call<Prepared>(`prepare_${action}`, { session: c.session, bounty_id: id });
  return c.send(prepared, { action, bountyId: id, expected: { entrypoint: action, bountyId: BigInt(id) } });
}

export async function rejectStep(c: StepContext, id: string, reason: string): Promise<Relayed> {
  const prepared = await c.board.call<Prepared>("prepare_reject", { session: c.session, bounty_id: id, reason });
  return c.send(prepared, { action: "reject", bountyId: id, expected: { entrypoint: "reject", bountyId: BigInt(id), reasonHash: reasonHash(reason) } });
}

export async function awardStep(c: StepContext, id: string, entryId: number): Promise<Relayed> {
  const prepared = await c.board.call<Prepared>("prepare_award", { session: c.session, bounty_id: id, entry_id: entryId });
  return c.send(prepared, { action: "award", bountyId: id, expected: { entrypoint: "award", bountyId: BigInt(id), entryId } });
}

export interface PostContext extends StepContext {
  keys: AgentKeys;
  chain: ChainReads;
  budget: SpendBudget;
  token: { id: string; decimals: number };
}

/**
 * Posts within the budget. The reward is committed before the post is sent (as post-tx:<hash>)
 * and moved to the bounty once it is final; the bounty on chain must then be what was asked.
 */
export async function postStep(c: PostContext, spec: SpecFields): Promise<{ id: bigint; units: bigint; relayed: Relayed; txHash: string }> {
  const units = parseTokenAmount(spec.reward, c.token.decimals);
  c.budget.check(units); // before anything is prepared
  const specHash = specHashFor(spec, c.keys.address, c.agent, c.token.id);
  const prepared = await c.board.call<Prepared>("prepare_post", {
    session: c.session,
    title: spec.title,
    description: spec.description,
    task_kind: spec.taskKind,
    input: spec.input,
    kind: spec.kind,
    reward: spec.reward,
    deadline: spec.deadline,
  });
  let ref: string | null = null;
  let txHash = "";
  const relayed = await c.send(prepared, {
    action: "post",
    bountyId: null,
    expected: { entrypoint: "post", kind: spec.kind, posterAgent: c.agent, specHash, reward: units, deadline: BigInt(spec.deadline) },
    onSigned: (hash) => {
      txHash = hash;
      ref = `post-tx:${hash}`;
      c.budget.commit(ref, units);
      return ref;
    },
    // A post that landed stays on record until it has been reported, so a failure after this point
    // never lets a second post through.
    keep: true,
  });
  const idText = relayed.events.find((e) => e.type === "Posted")?.id;
  if (idText === undefined) throw new Error("post went through but no Posted event came back");
  const id = BigInt(idText);
  if (ref === null) throw new Error("the post was relayed without being signed by this agent");
  // The id comes from the board's answer, so the chain must confirm it before the commitment moves
  // there: otherwise a board could put this reward's commitment on someone else's bounty.
  const onChain = await c.chain.bounty(id);
  if (onChain.poster !== c.keys.address || onChain.reward !== units || onChain.specHash !== specHash) {
    throw new RailViolation(
      `bounty ${id} on chain is not what the agent posted (poster ${onChain.poster}, reward ${onChain.reward} instead of ${units}, spec hash ${onChain.specHash}); stopping, cancel it if it is yours`,
    );
  }
  c.budget.rename(ref, `bounty:${id}`);
  return { id, units, relayed, txHash };
}

export interface PayContext {
  session: string;
  keys: AgentKeys;
  budget: SpendBudget;
  token: { id: string; decimals: number };
  /** The board's origin: the only place the agent pays (and sends its session to). */
  boardOrigin: string;
  pending: PendingStore;
  fetch?: typeof fetch;
  scheme?: GuardedPaymentOptions["scheme"];
}

/** The payment written down before it is sent: the board's sponsor signs it after the agent, so it is known by its nonce. */
function pendingPayment(account: string, payload: PaymentPayload, o: { bountyId: bigint; purpose: "fund" | "deliver" }, ref: string): PendingPayment {
  let tx: Transaction.Signable;
  try {
    tx = Transaction.signableFromJSON((payload.payload as { signedTransaction?: unknown }).signedTransaction as never);
  } catch (e) {
    throw new RailViolation(`refusing to send a payment the agent cannot read back (${(e as Error).message})`);
  }
  if (tx.header.sender.address !== account) throw new RailViolation(`refusing to send a payment from ${tx.header.sender.address}; this agent's account is ${account}`);
  return {
    kind: "payment",
    purpose: o.purpose,
    bountyId: o.bountyId.toString(),
    ref,
    nonce: tx.header.nonce.value.toString(),
    amount: payload.accepted.amount,
    expiresAt: Number(tx.header.expiry.expiryEpochSeconds) * 1000,
  };
}

/**
 * Pays over x402 with the guarded client: only at the board's own address, only `expected.payTo`,
 * only `expected.amount`, booked against the bounty's commitment before it is signed. The payment
 * is on record until the board answers, so a lost answer can be checked by its nonce.
 */
export async function payStep(
  c: PayContext,
  o: { bountyId: bigint; url: string; method: "GET" | "POST"; expected: { payTo: string; amount: bigint }; purpose: "fund" | "deliver" },
): Promise<Response> {
  let origin: string;
  try {
    origin = new URL(o.url).origin;
  } catch {
    throw new RailViolation(`refusing to pay at "${o.url}": not a URL`);
  }
  if (origin !== c.boardOrigin) throw new RailViolation(`refusing to pay at ${origin}: the board is ${c.boardOrigin}`);
  const ref = `bounty:${o.bountyId}`;
  const client = guardedPaymentClient({
    network: CONCORDIUM_TESTNET_CAIP2 as `${string}:${string}`,
    scheme: c.scheme ?? new ExactConcordiumScheme({ accountAddress: AccountAddress.fromBase58(c.keys.address), signer: buildBasicAccountSigner(c.keys.privateKeyHex) }),
    asset: c.token.id,
    maxAtomic: c.budget.limits.maxPerBounty,
    expected: () => ({ payTo: o.expected.payTo, amount: o.expected.amount.toString() }),
    book: (amount) => c.budget.reserve(ref, amount),
    onCreated: (payload) => c.pending.add(pendingPayment(c.keys.address, payload, o, ref)),
  });
  const res = await wrapFetchWithPayment(c.fetch ?? fetch, client)(o.url, { method: o.method, headers: { authorization: `Bearer ${c.session}` } });
  if (!res.ok) throw new Error(`x402 payment failed: HTTP ${res.status} ${await res.text()}`);
  c.pending.remove((r) => r.kind === "payment" && r.bountyId === o.bountyId.toString() && r.purpose === o.purpose);
  return res;
}
