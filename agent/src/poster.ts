import { parseTokenAmount } from "@deplace/shared";
import { isRetryable, oneLine } from "./board-client.js";
import type { ChainReads } from "./chain.js";
import type { SpendBudget } from "./rails/budget.js";
import { RailViolation, type GuardOptions } from "./rails/guard.js";
import type { GuardedPaymentOptions } from "./rails/payments.js";
import type { PendingStore } from "./rails/pending.js";
import type { AgentKeys } from "./signer.js";
import { directSend, payStep, posterActionStep, postStep, type PayContext, type PostContext } from "./steps.js";
import { login, type Board } from "./worker.js";

export interface PosterOptions {
  board: Board;
  badge: string;
  /** The agent's token id, read from its badge: the agent its posts must name. */
  agentTokenId: bigint;
  keys: AgentKeys;
  /** The agent's own chain reads: the payee, the reward and the escrow account come from the contract, not the board. */
  chain: ChainReads;
  /** What the agent will sign. */
  guard: GuardOptions;
  /** Caps each reward and the daily total; every payment is booked against the bounty's committed reward. */
  budget: SpendBudget;
  token: { id: string; decimals: number };
  /** The board's origin: the agent pays only there. */
  boardOrigin: string;
  /** Payments on record until the board answers. */
  pending: PendingStore;
  /** Reward as a decimal amount of the token. Default "1". */
  reward?: string;
  /** Escrow the reward over x402 right after posting, instead of paying the worker on delivery. */
  escrow?: boolean;
  log(m: string): void;
  pollMs?: number;
  /** Test seams: the fetch the x402 client wraps, and the scheme that signs payments. */
  fetch?: typeof fetch;
  scheme?: GuardedPaymentOptions["scheme"];
}

/**
 * Agents on the poster side: post a page-facts bounty, escrow its reward or leave it not
 * funded, wait for a worker to submit, accept, then (not funded) pay the worker on delivery
 * with x402 and print the delivered work. The rails decide what the agent signs and pays:
 * it posts only within its budget, signs only the Deplace actions it asked for, and pays
 * only the escrow account or the worker the contract names, only the committed reward, once.
 */
export async function postAndPay(o: PosterOptions) {
  const { board, log } = o;
  const reward = o.reward ?? "1";
  const units = parseTokenAmount(reward, o.token.decimals);
  o.budget.check(units); // before anything is posted

  const session = (await login(o, o.agentTokenId)).token;
  log(`posting a${o.escrow ? "n escrowed" : " not-funded"} page-facts bounty for ${reward} ${o.token.id}`);
  const c: PostContext = { board, session, agent: o.agentTokenId, send: directSend(o), keys: o.keys, chain: o.chain, budget: o.budget, token: o.token };
  const { id } = await postStep(c, {
    title: "Page facts for example.org",
    description: "Fetch https://example.org and report its title, visible word count and the SHA-256 of the body.",
    taskKind: "page-facts",
    input: { url: "https://example.org" },
    kind: "Exclusive",
    reward,
    deadline: Date.now() + 2 * 60 * 60_000,
  });
  const idText = id.toString();
  const pay: PayContext = { session, keys: o.keys, budget: o.budget, token: o.token, boardOrigin: o.boardOrigin, pending: o.pending, fetch: o.fetch, scheme: o.scheme };

  if (o.escrow) {
    // The board also prepares a fallback transfer; the agent never signs it and pays only through its own client.
    const fund = await board.call<{ x402: { url: string } }>("prepare_fund", { session, bounty_id: idText });
    const escrow = await o.chain.escrowAccount();
    log(`escrowing the reward over x402 to ${escrow}, the escrow account on chain`);
    const res = await payStep(pay, { bountyId: id, url: fund.x402.url, method: "POST", expected: { payTo: escrow, amount: units }, purpose: "fund" });
    const body = (await res.json()) as { funded: { confirmed: boolean; reason?: string }; payment: { link: string } };
    log(`  ${body.payment.link}`);
    if (!body.funded.confirmed) throw new Error(`the deposit for bounty ${id} settled but the board did not confirm it: ${body.funded.reason}`);
  }

  log(`bounty ${id} is open; waiting for a submission`);
  for (;;) {
    let status: string | null = null;
    try {
      status = (await board.call<{ status: { type: string } }>("get_status", { bounty_id: idText })).status.type;
    } catch (e) {
      if (!isRetryable(e)) throw e;
      log(`could not read bounty ${id}'s status, trying again (${oneLine(e)})`);
    }
    if (status === "Submitted") break;
    if (status !== null && ["Expired", "Cancelled"].includes(status)) throw new Error(`bounty ${id} ended as ${status}`);
    await new Promise((r) => setTimeout(r, o.pollMs ?? 15_000));
  }
  log(`accepting bounty ${id}`);
  await posterActionStep(c, "accept", idText);

  const work = await board.call<{ paymentRequired: boolean; url?: string; items?: unknown }>("fetch_work", { session, bounty_id: idText });
  if (!work.paymentRequired) {
    log(JSON.stringify(work.items, null, 2));
    return;
  }
  // Who is owed what comes from the contract; the board's own payTo and amount are not used.
  const accepted = await o.chain.bounty(id);
  const payee = await o.chain.payee(accepted);
  if (!payee) throw new RailViolation(`bounty ${id} is ${accepted.status.type} on chain, so nobody is owed its reward yet`);
  log(`paying ${payee}, the worker on chain, on delivery over x402`);
  const res = await payStep(pay, { bountyId: id, url: work.url!, method: "GET", expected: { payTo: payee, amount: accepted.reward }, purpose: "deliver" });
  const body = (await res.json()) as { items: unknown; payment: { link: string } };
  log(`paid: ${body.payment.link}`);
  log(JSON.stringify(body.items, null, 2));
}
