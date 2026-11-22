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

async function signAndSubmit(o: WorkerOptions, prepared: { prepared: { txJson: string; feeSponsored?: boolean; notice?: string } }): Promise<string> {
  if (prepared.prepared.notice) o.log(`  note: ${prepared.prepared.notice}`);
  const signed = await signPrepared(o.keys, prepared.prepared.txJson);
  const r = await o.board.call<{ txHash: string; link: string }>("submit_signed", { tx_json: signed });
  o.log(`  ${r.link}`);
  return r.txHash;
}

async function waitForOutcome(o: WorkerOptions, id: string): Promise<string> {
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < (o.maxPolls ?? 240); i++) {
    const s = await o.board.call<{ status: { type: string } }>("get_status", { bounty_id: id });
    const t = s.status.type;
    if (FINAL.has(t) || t === "Claimed") {
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
 * Returns null when nothing suitable is open.
 */
export async function workOne(o: WorkerOptions): Promise<{ bountyId: string; status: string; txs: string[] } | null> {
  const eligible = await o.board.call<{ ok: boolean; reason?: string; faucetUrl?: string }>("check_payout_eligibility", { account: o.keys.address });
  if (!eligible.ok) throw new Error(`payout account ${o.keys.address} cannot be paid: ${eligible.reason} (faucet: ${eligible.faucetUrl ?? "n/a"})`);
  const session = await login(o);

  const { bounties } = await o.board.call<{ bounties: ListedBounty[] }>("list_bounties", { status: "Open" });
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
    txs.push(await signAndSubmit(o, await o.board.call("prepare_claim", { session, bounty_id: id })));
  }
  for (let resubmits = 0; ; resubmits++) {
    const work = await handler.run(b.spec!);
    o.log(`${b.kind === "Exclusive" ? "submitting" : "entering"} work for bounty ${id}`);
    txs.push(await signAndSubmit(o, await o.board.call("prepare_submit", { session, bounty_id: id, preview: work.preview, full: work.full })));
    const status = await waitForOutcome(o, id);
    if (status === "Claimed" && resubmits < (o.maxResubmits ?? 2)) {
      o.log("the poster rejected the work; resubmitting");
      continue;
    }
    return { bountyId: id, status, txs };
  }
}
