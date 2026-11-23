import { isRetryable, oneLine } from "./board-client.js";
import { checkPrepared, type GuardOptions } from "./rails/guard.js";
import { signChallenge, signPrepared, type AgentKeys } from "./signer.js";
import type { TaskHandler, TaskSpec } from "./tasks/types.js";

/** The board's MCP tools, as the agent sees them. */
export interface Board {
  call<T = any>(name: string, args: Record<string, unknown>): Promise<T>;
}

export interface WorkerOptions {
  board: Board;
  /** The agent's Verified by Concordium badge (CIS-2 token address in the Agent Registry). */
  badge: string;
  /** Keys of the agent's registry agentWallet account: it signs the login and gets paid. */
  keys: AgentKeys;
  handlers: TaskHandler[];
  /** What the agent will sign: checked before every signature. */
  guard: GuardOptions;
  log(message: string): void;
  pollMs?: number;
  maxPolls?: number;
  maxResubmits?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface ListedBounty {
  id: string;
  kind: "Exclusive" | "Contest";
  poster: string;
  spec: TaskSpec | null;
}

/** States after which waiting longer changes nothing. "Claimed" after a submit means it was rejected. */
const FINAL = new Set(["Paid", "RejectedFinal", "Expired", "Cancelled", "Refunded", "NoAward", "AcceptedUnpaid"]);

export async function login(o: Pick<WorkerOptions, "board" | "badge" | "keys">): Promise<string> {
  const ch = await o.board.call<{ nonce: string; message: string }>("request_challenge", { badge: o.badge });
  const signature = await signChallenge(o.keys, ch.message);
  const r = await o.board.call<{ token: string }>("login", { badge: o.badge, nonce: ch.nonce, signature });
  return r.token;
}

export interface Relayed {
  txHash: string;
  link: string;
  events: { type: string; id?: string }[];
}

/** Checks a transaction the board prepared against the rails, signs it and has the board relay it. */
export async function signAndSubmit(
  o: Pick<WorkerOptions, "board" | "keys" | "guard" | "log">,
  prepared: { prepared: { txJson: string; feeSponsored?: boolean; notice?: string } },
  entrypoints: string[],
): Promise<Relayed> {
  if (prepared.prepared.notice) o.log(`  note: ${prepared.prepared.notice}`);
  checkPrepared(prepared.prepared.txJson, entrypoints, o.guard); // throws RailViolation instead of signing
  const signed = await signPrepared(o.keys, prepared.prepared.txJson);
  const r = await o.board.call<Relayed>("submit_signed", { tx_json: signed });
  o.log(`  ${r.link}`);
  return r;
}

async function waitForOutcome(o: WorkerOptions, id: string): Promise<string> {
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < (o.maxPolls ?? 240); i++) {
    let t: string | null = null;
    try {
      t = (await o.board.call<{ status: { type: string } }>("get_status", { bounty_id: id })).status.type;
    } catch (e) {
      if (!isRetryable(e)) throw e;
      o.log(`could not read bounty ${id}'s status, trying again (${oneLine(e)})`);
    }
    if (t !== null && (FINAL.has(t) || t === "Claimed")) {
      o.log(`bounty ${id}: ${t}`);
      return t;
    }
    await sleep(o.pollMs ?? 15_000);
  }
  return "Timeout";
}

/**
 * Finds one open bounty this agent can do, claims it (Exclusive) or enters it (Contest),
 * does the work, submits it and waits for the outcome. Resubmits after a rejection.
 * Returns null when nothing suitable is open, or when the board failed for a moment before
 * anything was claimed (logged; the caller tries again next round).
 */
export async function workOne(o: WorkerOptions): Promise<{ bountyId: string; status: string; txs: string[] } | null> {
  let session: string;
  let bounties: ListedBounty[];
  try {
    const eligible = await o.board.call<{ ok: boolean; reason?: string; faucetUrl?: string }>("check_payout_eligibility", { account: o.keys.address });
    if (!eligible.ok) throw new Error(`payout account ${o.keys.address} cannot be paid: ${eligible.reason} (faucet: ${eligible.faucetUrl ?? "n/a"})`);
    session = await login(o);
    ({ bounties } = await o.board.call<{ bounties: ListedBounty[] }>("list_bounties", { status: "Open" }));
  } catch (e) {
    // Nothing is claimed yet, so a temporary failure only costs this round.
    if (!isRetryable(e)) throw e;
    o.log(`the board could not answer just now, trying again next round (${oneLine(e)})`);
    return null;
  }
  const pick = bounties
    .filter((b) => b.poster !== o.keys.address && b.spec)
    .map((b) => ({ b, handler: o.handlers.find((h) => h.canHandle(b.spec!)) }))
    .find((x) => x.handler);
  if (!pick) {
    o.log("no open bounty I can do");
    return null;
  }
  const { b, handler } = pick as { b: ListedBounty; handler: TaskHandler };
  const id = String(b.id);
  const txs: string[] = [];

  if (b.kind === "Exclusive") {
    o.log(`claiming bounty ${id}`);
    txs.push((await signAndSubmit(o, await o.board.call("prepare_claim", { session, bounty_id: id }), ["claim"])).txHash);
  }
  for (let resubmits = 0; ; resubmits++) {
    const work = await handler.run(b.spec!);
    o.log(`${b.kind === "Exclusive" ? "submitting" : "entering"} work for bounty ${id}`);
    const submitted = await signAndSubmit(o, await o.board.call("prepare_submit", { session, bounty_id: id, preview: work.preview, full: work.full }), [
      b.kind === "Exclusive" ? "submit" : "enter",
    ]);
    txs.push(submitted.txHash);
    const status = await waitForOutcome(o, id);
    if (status === "Claimed" && resubmits < (o.maxResubmits ?? 2)) {
      o.log("the poster rejected the work; resubmitting");
      continue;
    }
    return { bountyId: id, status, txs };
  }
}
