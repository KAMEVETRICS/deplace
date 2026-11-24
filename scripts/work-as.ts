// Works one bounty as a person, over the board's REST API: logs in with the account's key, claims
// the bounty (Exclusive), and submits the work. Any task: the work is the text of a file you give;
// without one, only a page-facts bounty can be done, by running the page-facts task. Used to play
// the worker when an agent posts a bounty through the agent kit.
//
//   npx tsx scripts/work-as.ts secrets/worker-human.export <bountyId> [<file with the work>]
//
// The preview the poster sees first is the work's first 300 characters. PUBLIC_BASE_URL defaults
// to the hosted board, https://deplace.space. The board's sponsor pays the fees.
import { readFileSync } from "node:fs";
import { AccountAddress, Transaction, buildAccountSigner, parseWallet, signMessage } from "@concordium/web-sdk";
import { pageFacts } from "../agent/src/tasks/page-facts.js";
import type { TaskSpec } from "../agent/src/tasks/types.js";

const [keyFile, id, workFile] = process.argv.slice(2);
if (!keyFile || !id || !/^\d{1,20}$/.test(id)) throw new Error("usage: npx tsx scripts/work-as.ts <keyFile> <bountyId> [<file with the work>]");
const BOARD = (process.env.PUBLIC_BASE_URL?.trim() || "https://deplace.space").replace(/\/$/, "");

const wallet = parseWallet(readFileSync(keyFile, "utf8"));
const address = wallet.value.address;
const signer = buildAccountSigner(wallet);

async function http<T = any>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(BOARD + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${data.error ?? ""}`);
  return data as T;
}

const detail = await http<{ bounty: { kind: string; status: { type: string } }; spec: (TaskSpec & { title?: string }) | null }>("GET", `/bounties/${id}`);
if (!detail.spec) throw new Error(`bounty ${id} has no spec on this board`);
let work: { preview: string; full: string };
if (workFile) {
  const full = readFileSync(workFile, "utf8");
  if (!full.trim()) throw new Error(`${workFile} is empty`);
  work = { preview: full.slice(0, 300), full };
} else if (pageFacts.canHandle(detail.spec)) {
  work = await pageFacts.run(detail.spec);
} else {
  throw new Error(`bounty ${id} ("${detail.spec.title ?? detail.spec.taskKind}") is a ${detail.spec.taskKind} task: give a file with the work as the third argument`);
}

const challenge = await http<{ nonce: string; message: string }>("POST", "/auth/challenge", { account: address });
const signature = await signMessage(AccountAddress.fromBase58(address), challenge.message, signer);
const { token, identity } = await http<{ token: string; identity: { label: string } }>("POST", "/auth/login", { account: address, nonce: challenge.nonce, signature });
console.log(`logged in as ${identity.label} (${address})`);

/** Asks the board for a prepared (sponsored) transaction, signs it as this account and relays it. */
async function step(label: string, path: string, body?: unknown) {
  const p = await http<{ prepared: { txJson: string; feeSponsored: boolean; notice?: string } }>("POST", path, body, token);
  if (!p.prepared.feeSponsored) console.log(`  note: ${p.prepared.notice}`);
  const signed = await Transaction.sign(Transaction.signableFromJSON(JSON.parse(p.prepared.txJson)), signer);
  const r = await http<{ link: string }>("POST", "/tx/submit", { txJson: Transaction.toJSONString(signed) });
  console.log(`${label}: ${r.link}`);
}

if (detail.bounty.kind === "Exclusive") await step(`claimed bounty ${id}`, `/bounties/${id}/claim`);
await step(`submitted work for bounty ${id}`, `/bounties/${id}/submit`, work);
console.log(work.preview);
