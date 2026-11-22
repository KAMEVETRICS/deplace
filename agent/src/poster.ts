import { AccountAddress, buildBasicAccountSigner } from "@concordium/web-sdk";
import { CONCORDIUM_TESTNET_CAIP2 } from "@x402/concordium";
import { ExactConcordiumScheme } from "@x402/concordium/exact/client";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { signPrepared, type AgentKeys } from "./signer.js";
import { login, type Board } from "./worker.js";

interface Relayed {
  txHash: string;
  link: string;
  events: { type: string; id?: string }[];
}

async function signAndSubmit(board: Board, keys: AgentKeys, prepared: { prepared: { txJson: string } }, log: (m: string) => void): Promise<Relayed> {
  const r = await board.call<Relayed>("submit_signed", { tx_json: await signPrepared(keys, prepared.prepared.txJson) });
  log(`  ${r.link}`);
  return r;
}

/**
 * Agents on the poster side: post a not-funded page-facts bounty, wait for a worker to
 * submit, accept, then pay the worker on delivery with x402 and print the delivered work.
 */
export async function postAndPay(o: { board: Board; badge: string; keys: AgentKeys; url: string; log: (m: string) => void; pollMs?: number }) {
  const { board, keys, log } = o;
  const session = await login(o);
  log("posting a not-funded page-facts bounty");
  const posted = await signAndSubmit(
    board,
    keys,
    await board.call("prepare_post", {
      session,
      title: "Page facts for example.org",
      description: "Fetch https://example.org and report its title, visible word count and the SHA-256 of the body.",
      task_kind: "page-facts",
      input: { url: "https://example.org" },
      kind: "Exclusive",
      reward: "1",
      deadline: Date.now() + 2 * 60 * 60_000,
    }),
    log,
  );
  const id = posted.events.find((e) => e.type === "Posted")?.id;
  if (id === undefined) throw new Error("post went through but no Posted event came back");
  log(`bounty ${id} is open; waiting for a submission`);

  for (;;) {
    const s = await board.call<{ status: { type: string } }>("get_status", { bounty_id: String(id) });
    if (s.status.type === "Submitted") break;
    if (["Expired", "Cancelled"].includes(s.status.type)) throw new Error(`bounty ${id} ended as ${s.status.type}`);
    await new Promise((r) => setTimeout(r, o.pollMs ?? 15_000));
  }
  log(`accepting bounty ${id}`);
  await signAndSubmit(board, keys, await board.call("prepare_accept", { session, bounty_id: String(id) }), log);

  const work = await board.call<{ paymentRequired: boolean; url?: string; items?: unknown }>("fetch_work", { session, bounty_id: String(id) });
  if (!work.paymentRequired) {
    log(JSON.stringify(work.items, null, 2));
    return;
  }
  log(`paying the worker on delivery (x402) at ${work.url}`);
  const payments = new x402Client().register(
    CONCORDIUM_TESTNET_CAIP2 as `${string}:${string}`,
    new ExactConcordiumScheme({ accountAddress: AccountAddress.fromBase58(keys.address), signer: buildBasicAccountSigner(keys.privateKeyHex) }),
  );
  const res = await wrapFetchWithPayment(fetch, payments)(work.url!, { headers: { authorization: `Bearer ${session}` } });
  if (!res.ok) throw new Error(`x402 payment failed: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { items: unknown; payment: { link: string } };
  log(`paid: ${body.payment.link}`);
  log(JSON.stringify(body.items, null, 2));
}
