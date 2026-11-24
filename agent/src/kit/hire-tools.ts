import { parseTokenAmount, type BountyKind } from "@deplace/shared";
import { BoardToolError } from "../board-client.js";
import { RailViolation } from "../rails/guard.js";
import type { PendingTx } from "../rails/pending.js";
import { awardStep, payStep, posterActionStep, postStep, rejectStep, type PayContext, type StepContext } from "../steps.js";
import type { Relayed } from "../worker.js";
import { isTransportError } from "./board-link.js";
import { KitError } from "./errors.js";
import { bountyIdOf, deadlineFor, OTHER_PEOPLES_TEXT, stepContext, type KitDeps } from "./work-tools.js";

type R = Promise<Record<string, unknown>>;

export interface HireTools {
  post_bounty(a: { title: string; description: string; task_kind: string; input: Record<string, unknown>; kind: BountyKind; reward: string; deadline_hours: number; escrow?: boolean }): R;
  fund_bounty(a: { bounty_id: string }): R;
  accept(a: { bounty_id: string }): R;
  reject(a: { bounty_id: string; reason: string }): R;
  award(a: { bounty_id: string; entry_id: number }): R;
  cancel(a: { bounty_id: string }): R;
  get_work(a: { bounty_id: string }): R;
}

const HOUR_MS = 3_600_000;
/** The board's limit on a spec's input. */
const MAX_INPUT_JSON = 2048;

/** A failure in words: the board's JSON `error` when it has one. */
function messageOf(e: unknown): string {
  if (e instanceof BoardToolError) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(e.detail);
    } catch {
      return e.detail; // plain text from the board
    }
    const error = (parsed as { error?: unknown } | null)?.error;
    return typeof error === "string" ? error : e.detail;
  }
  return e instanceof Error ? e.message : String(e);
}

export function hireTools(d: KitDeps): HireTools {
  async function payContext(session: string): Promise<PayContext> {
    return {
      session,
      keys: d.keys,
      budget: await d.budget(),
      token: { id: d.token.id, decimals: await d.chain.decimals(d.token.id) },
      boardOrigin: d.link.origin,
      pending: d.pending,
      fetch: d.fetch,
      scheme: d.scheme,
    };
  }

  /** payStep, with a dropped connection reported the way the kit will deal with it. */
  async function pay(c: PayContext, o: Parameters<typeof payStep>[1]): Promise<Response> {
    try {
      return await payStep(c, o);
    } catch (e) {
      if (!isTransportError(e)) throw e;
      const sent = d.pending.list().find((r) => r.kind === "payment" && r.bountyId === o.bountyId.toString() && r.purpose === o.purpose);
      if (!sent) throw new KitError(`could not reach the board to pay for bounty ${o.bountyId}; nothing was paid`, true);
      const after = new Date(sent.expiresAt).toISOString();
      throw new KitError(
        `the payment for bounty ${o.bountyId} was sent but the board's answer was lost; after ${after} the kit checks on chain whether it went through, and it signs nothing else before then`,
        true,
        { outcomeUnknown: true, retryAfter: after },
      );
    }
  }

  /** Escrows the reward of a bounty this agent posted: only to the escrow account in the contract's configuration, only the reward on chain. */
  async function fund(id: bigint, session: string, deadline: number) {
    await d.relay.settle((r) => r.action === "post", { wait: false }); // a post kept on record gets its commitment first
    const onChain = await d.chain.bounty(id);
    if (onChain.poster !== d.keys.address) throw new RailViolation(`refusing to fund bounty ${id}: it was posted by ${onChain.poster}, not this agent`);
    if (onChain.funding.type !== "NotFunded") throw new KitError(`bounty ${id} is already escrowed`, false);
    const offer = await d.link.call<{ x402: { url: string } }>("prepare_fund", { session, bounty_id: id.toString() }, deadline);
    const escrow = await d.chain.escrowAccount();
    const res = await pay(await payContext(session), { bountyId: id, url: offer.x402.url, method: "POST", expected: { payTo: escrow, amount: onChain.reward }, purpose: "fund" });
    const body = (await res.json()) as { funded?: { confirmed?: boolean; reason?: string }; payment?: { link?: string } };
    const confirmed = body.funded?.confirmed === true;
    return {
      escrowed: confirmed,
      escrowAccount: escrow,
      paymentLink: body.payment?.link ?? null,
      ...(confirmed ? {} : { warning: `the payment settled, but the board did not confirm the deposit: ${body.funded?.reason ?? "no reason given"}` }),
    };
  }

  /** A poster action in a turn, after settling any earlier one of the same action on the same bounty. */
  async function posterAction(action: "accept" | "reject" | "award" | "cancel", rawId: string, step: (c: StepContext, id: string) => Promise<Relayed>, next: string): R {
    const id = bountyIdOf(rawId);
    const deadline = deadlineFor(d);
    return d.relay.turn(async () => {
      const earlier = (await d.relay.settle((r) => r.action === action && r.bountyId === id)).find((s) => s.landed && !s.failed);
      if (earlier && earlier.landed) return { bountyId: id, link: earlier.link, message: `an earlier ${action} of this bounty went through`, next };
      const r = await d.link.withSession((session) => step(stepContext(d, deadline, session), id), deadline);
      return { bountyId: id, done: action, txHash: r.txHash, link: r.link, next };
    }, deadline);
  }

  return {
    async post_bounty(a) {
      const deadline = deadlineFor(d);
      return d.relay.turn(async () => {
        const earlier = (await d.relay.settle((r) => r.action === "post")).find((s) => s.landed && !s.failed);
        if (earlier && earlier.landed) {
          const posted = earlier.events.find((e) => e.type === "Posted");
          const id = posted?.type === "Posted" ? posted.id.toString() : null;
          return {
            bountyId: id,
            link: earlier.link,
            message: `your earlier post went through as bounty ${id}; nothing new was posted`,
            ...(a.escrow ? { escrowed: false, warning: `it isn't escrowed yet: call fund_bounty with bounty_id ${id} to escrow its reward` } : {}),
            next: "check_status on it, or call post_bounty again if you meant a second bounty",
          };
        }
        if (JSON.stringify(a.input).length > MAX_INPUT_JSON) throw new KitError(`input must be a JSON object under ${MAX_INPUT_JSON} characters`, false);
        const decimals = await d.chain.decimals(d.token.id);
        let units: bigint;
        try {
          units = parseTokenAmount(a.reward, decimals);
        } catch (e) {
          throw new KitError(`reward: ${(e as Error).message}`, false);
        }
        if (units <= 0n) throw new KitError("reward must be more than 0", false);
        const spec = { title: a.title, description: a.description, taskKind: a.task_kind, input: a.input, kind: a.kind, reward: a.reward, deadline: d.now() + Math.round(a.deadline_hours * HOUR_MS) };
        const budget = await d.budget();
        const before = new Set(d.pending.list().flatMap((r) => (r.kind === "tx" ? [r.hash] : [])));
        let posted: Awaited<ReturnType<typeof postStep>>;
        try {
          // Only prepare_post needs the session, and it comes before signing, so a fresh login may repeat it safely.
          posted = await d.link.withSession(
            (session) => postStep({ ...stepContext(d, deadline, session), keys: d.keys, chain: d.chain, budget, token: { id: d.token.id, decimals } }, spec),
            deadline,
          );
        } catch (e) {
          // Once the post was sent, a failure must not read as "try again": the next call reports it from the chain.
          const sent = d.pending.list().find((r): r is PendingTx => r.kind === "tx" && r.action === "post" && !before.has(r.hash));
          if (!sent || (e instanceof KitError && e.extra.outcomeUnknown)) throw e;
          throw new KitError(
            `the post was sent and may have gone through, but then ${messageOf(e)}; call post_bounty again to see it: the kit reports an earlier post instead of posting twice`,
            true,
            { postSent: true, txHash: sent.hash },
          );
        }
        d.relay.done(posted.txHash);
        const { id, relayed } = posted;
        const out: Record<string, unknown> = { bountyId: id.toString(), txHash: relayed.txHash, link: relayed.link, reward: a.reward, token: d.token.id, deadline: new Date(spec.deadline).toISOString() };
        if (a.escrow) {
          // The bounty exists now, whatever happens to the escrow: report it either way.
          try {
            Object.assign(out, await d.link.withSession((session) => fund(id, session, deadline), deadline));
          } catch (e) {
            Object.assign(out, {
              escrowed: false,
              warning: `posted, but escrowing the reward failed: ${messageOf(e)}; call fund_bounty with bounty_id ${id} to try again`,
              ...(e instanceof KitError && e.extra.outcomeUnknown ? { paymentOutcomeUnknown: true, retryAfter: e.extra.retryAfter } : {}),
            });
          }
        }
        out.next = a.escrow ? "wait for a worker; check_status shows submissions" : "wait for a worker; once work is submitted, accept it, and get_work pays the worker";
        return out;
      }, deadline);
    },

    async fund_bounty(a) {
      const id = BigInt(bountyIdOf(a.bounty_id));
      const deadline = deadlineFor(d);
      return d.relay.turn(async () => {
        const out = await d.link.withSession((session) => fund(id, session, deadline), deadline);
        return { bountyId: id.toString(), ...out, next: "wait for a worker; check_status shows submissions" };
      }, deadline);
    },

    accept: (a) => posterAction("accept", a.bounty_id, (c, id) => posterActionStep(c, "accept", id), "get_work returns the delivered work"),
    reject: (a) => posterAction("reject", a.bounty_id, (c, id) => rejectStep(c, id, a.reason), "the worker can fix the work and submit again; the third rejection is final"),
    award: (a) => posterAction("award", a.bounty_id, (c, id) => awardStep(c, id, a.entry_id), "get_work returns the winning entry"),
    cancel: (a) => posterAction("cancel", a.bounty_id, (c, id) => posterActionStep(c, "cancel", id), "nothing more to do; an escrowed reward is refunded"),

    async get_work(a) {
      const id = bountyIdOf(a.bounty_id);
      const deadline = deadlineFor(d);
      return d.relay.turn(() =>
        d.link.withSession(async (session) => {
          await d.relay.settle((r) => r.action === "post", { wait: false }); // a post kept on record gets its commitment first
          const work = await d.link.call<{ paymentRequired: boolean; url?: string; items?: unknown }>("fetch_work", { session, bounty_id: id }, deadline);
          if (!work.paymentRequired) return { bountyId: id, items: work.items, note: OTHER_PEOPLES_TEXT, next: "done" };
          if (d.relay.landedPayments.has(id)) {
            throw new KitError(`the payment for bounty ${id} went through on chain, but the board hasn't recorded it yet; ask the board's operator`, false);
          }
          // Who is owed what comes from the contract; the board's own payTo and amount are not used.
          const onChain = await d.chain.bounty(BigInt(id));
          if (onChain.poster !== d.keys.address) throw new RailViolation(`refusing to pay for bounty ${id}: it was posted by ${onChain.poster}, not this agent`);
          if (onChain.funding.type !== "NotFunded") throw new RailViolation(`refusing to pay for bounty ${id} on delivery: its reward is already escrowed`);
          const payee = await d.chain.payee(onChain);
          if (!payee) throw new RailViolation(`bounty ${id} is ${onChain.status.type} on chain, so nobody is owed its reward yet`);
          if (!work.url) throw new KitError(`the board asked for payment for bounty ${id} without saying where to pay`, false);
          const res = await pay(await payContext(session), { bountyId: BigInt(id), url: work.url, method: "GET", expected: { payTo: payee, amount: onChain.reward }, purpose: "deliver" });
          const body = (await res.json()) as { items?: unknown; payment?: { link?: string } };
          return { bountyId: id, items: body.items, paidTo: payee, paymentLink: body.payment?.link ?? null, note: OTHER_PEOPLES_TEXT, next: "done: the worker is paid" };
        }, deadline),
        deadline,
      );
    },
  };
}
