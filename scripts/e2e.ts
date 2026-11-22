// End-to-end run on testnet against a running board (npm start -w server).
//   npx tsx scripts/e2e.ts [A,B,C]
// A  escrowed Exclusive: post, fund over x402, agent claims and submits, poster accepts,
//    the escrow worker pays the agent, the poster fetches the work.
// B  not-funded Exclusive: post, agent claims and submits, poster accepts and pays on
//    delivery over x402; the payment is recorded as the payout.
// C  escrowed Contest with two entries (agent + human) that the poster never awards: the
//    keeper splits it after the review window and escrow pays both entrants.
//    Run C against an instance deployed with `scripts/deploy.ts --demo` (short windows).
// Every transaction link is written to docs/e2e-run.md.
import "../server/src/env-init.js";
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { AccountAddress, Transaction, buildAccountSigner, buildBasicAccountSigner, parseWallet, signMessage, type AccountSigner } from "@concordium/web-sdk";
import { CONCORDIUM_TESTNET_CAIP2 } from "@x402/concordium";
import { ExactConcordiumScheme } from "@x402/concordium/exact/client";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { pageFacts } from "../agent/src/tasks/page-facts.js";

const BOARD = (process.env.PUBLIC_BASE_URL ?? "http://localhost:8787").replace(/\/$/, "");
const scenarios = (process.argv[2] ?? "A,B,C").split(",");
const rows: string[] = [];
const record = (step: string, actor: string, link = "") => {
  console.log(`${step.padEnd(44)} ${actor.padEnd(8)} ${link}`);
  rows.push(`| ${step} | ${actor} | ${link ? `[transaction](${link})` : ""} |`);
};

interface Actor {
  name: string;
  address: string;
  signer: AccountSigner;
  key: string;
  badge?: string;
  token?: string;
}

function actor(name: string, file: string, badge?: string): Actor {
  const w = parseWallet(readFileSync(file, "utf8"));
  const key = w.value.accountKeys.keys[0]?.keys[0]?.signKey;
  if (!key) throw new Error(`${file}: no key at credential 0, index 0`);
  return { name, address: w.value.address, signer: buildAccountSigner(w), key, badge };
}

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

async function login(a: Actor) {
  const subject = a.badge ? { badge: a.badge } : { account: a.address };
  const ch = await http("POST", "/auth/challenge", subject);
  const signature = await signMessage(AccountAddress.fromBase58(a.address), ch.message, a.signer);
  const r = await http("POST", "/auth/login", { ...subject, nonce: ch.nonce, signature });
  a.token = r.token;
  record(`${a.name} logs in: ${r.identity.label}`, a.name);
}

/** Asks the board for a prepared (sponsored) transaction, signs it as `a` and relays it. */
async function step(a: Actor, label: string, method: string, path: string, body?: unknown) {
  const p = await http(method, path, body, a.token);
  if (!p.prepared.feeSponsored) console.log(`  note: ${p.prepared.notice}`);
  const signed = await Transaction.sign(Transaction.signableFromJSON(JSON.parse(p.prepared.txJson)), a.signer);
  const r = await http("POST", "/tx/submit", { txJson: Transaction.toJSONString(signed) });
  record(label, a.name, r.link);
  return { ...p, ...r } as { events: { type: string; id?: string }[]; link: string; workHash?: string };
}

const paying = (a: Actor) =>
  wrapFetchWithPayment(
    fetch,
    new x402Client().register(
      CONCORDIUM_TESTNET_CAIP2 as `${string}:${string}`,
      new ExactConcordiumScheme({ accountAddress: AccountAddress.fromBase58(a.address), signer: buildBasicAccountSigner(a.key) }),
    ),
  );

async function waitStatus(id: string, want: string[], timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const d = await http(`GET`, `/bounties/${id}`);
    if (want.includes(d.bounty.status.type)) return d;
    if (Date.now() > until) throw new Error(`bounty ${id} is ${d.bounty.status.type}, waited for ${want.join("/")}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

async function recordPayouts(id: string, label: string) {
  const d = await http(`GET`, `/bounties/${id}`);
  for (const e of d.events.filter((x: any) => x.event.type === "PayoutRecorded")) {
    record(`${label}: payout to ${String(e.event.to).slice(0, 8)}…`, "escrow", `https://ccdexplorer.io/testnet/transaction/${e.event.tx}`);
    record(`${label}: payout recorded on chain`, "operator", e.link);
  }
}

const spec = (title: string, kind: "Exclusive" | "Contest", reward: string, minutes: number, url: string) => ({
  title,
  description: `Fetch ${url} and report its title, visible word count and the SHA-256 of the body.`,
  taskKind: "page-facts",
  input: { url },
  kind,
  reward,
  deadline: Date.now() + minutes * 60_000,
});
const posted = (r: { events: { type: string; id?: string }[] }) => {
  const id = r.events.find((e) => e.type === "Posted")?.id;
  if (id === undefined) throw new Error("no Posted event in the post transaction");
  return String(id);
};

const poster = actor("poster", process.env.POSTER_KEY_FILE ?? "secrets/poster.export");
const agent = actor("agent", process.env.AGENT_KEY_FILE ?? "secrets/worker-agent.export", process.env.AGENT_BADGE);
const human = actor("human", process.env.WORKER_HUMAN_KEY_FILE ?? "secrets/worker-human.export");
if (!agent.badge) throw new Error("set AGENT_BADGE in .env (npm run register -w agent)");

const config = await http("GET", "/config");
console.log(`Board ${BOARD}, contract <${config.contract.index},${config.contract.subindex}>\n`);
await login(poster);
await login(agent);
await login(human);

if (scenarios.includes("A")) {
  const id = posted(await step(poster, "A1 post Exclusive bounty", "POST", "/bounties", spec("E2E A: page facts for example.org", "Exclusive", "1", 30, "https://example.org")));
  const res = await paying(poster)(`${BOARD}/bounties/${id}/fund`, { method: "POST", headers: { authorization: `Bearer ${poster.token}` } });
  if (!res.ok) throw new Error(`x402 funding failed: HTTP ${res.status} ${await res.text()}`);
  const fund = (await res.json()) as { payment: { link: string }; funded: unknown };
  record("A2 fund escrow over x402", "poster", fund.payment.link);
  await step(agent, "A3 claim (badge + attestation)", "POST", `/bounties/${id}/claim`);
  const work = await pageFacts.run({ taskKind: "page-facts", input: { url: "https://example.org" } });
  await step(agent, "A4 submit work (hash on chain)", "POST", `/bounties/${id}/submit`, work);
  await step(poster, "A5 accept", "POST", `/bounties/${id}/accept`);
  await waitStatus(id, ["Paid"], 5 * 60_000);
  await recordPayouts(id, "A6");
  const w = await http("GET", `/bounties/${id}/work`, undefined, poster.token);
  record(`A7 work released, hash matches chain: ${w.items[0]?.hashMatches}`, "poster");
}

if (scenarios.includes("B")) {
  const id = posted(await step(poster, "B1 post not-funded bounty", "POST", "/bounties", spec("E2E B: page facts for concordium.com", "Exclusive", "1", 30, "https://www.concordium.com")));
  await step(agent, "B2 claim", "POST", `/bounties/${id}/claim`);
  const work = await pageFacts.run({ taskKind: "page-facts", input: { url: "https://www.concordium.com" } });
  await step(agent, "B3 submit work", "POST", `/bounties/${id}/submit`, work);
  await step(poster, "B4 accept", "POST", `/bounties/${id}/accept`);
  const res = await paying(poster)(`${BOARD}/bounties/${id}/work`, { headers: { authorization: `Bearer ${poster.token}` } });
  if (!res.ok) throw new Error(`x402 pay on delivery failed: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { items: { hashMatches: boolean }[]; payment: { link: string } };
  record(`B5 pay on delivery over x402, work hash matches: ${body.items[0]?.hashMatches}`, "poster", body.payment.link);
  await waitStatus(id, ["Paid"], 2 * 60_000);
  await recordPayouts(id, "B6");
}

if (scenarios.includes("C")) {
  const minutes = Number(process.env.E2E_CONTEST_MINUTES ?? 4);
  const id = posted(await step(poster, "C1 post Contest", "POST", "/bounties", spec("E2E C: contest, page facts for example.com", "Contest", "1", minutes, "https://example.com")));
  await step(poster, "C2 fund escrow (direct sponsored transfer)", "POST", `/bounties/${id}/fund-transfer`);
  const work = await pageFacts.run({ taskKind: "page-facts", input: { url: "https://example.com" } });
  await step(agent, "C3 agent enters", "POST", `/bounties/${id}/submit`, work);
  await step(human, "C4 human enters", "POST", `/bounties/${id}/submit`, { ...work, preview: `${work.preview} (human)` });
  console.log(`waiting for the deadline and the review window; the keeper then splits the reward…`);
  await waitStatus(id, ["Paid"], (minutes + 15) * 60_000);
  const d = await http("GET", `/bounties/${id}`);
  const split = d.events.find((e: any) => e.event.type === "SplitStarted");
  if (split) record("C5 keeper splits the unawarded contest", "keeper", split.link);
  await recordPayouts(id, "C6");
}

const md = `# End-to-end run on Concordium testnet

Board: ${BOARD}
Contract: [<${config.contract.index},${config.contract.subindex}>](https://ccdexplorer.io/testnet/instance/${config.contract.index}/${config.contract.subindex})
Run at: ${new Date().toISOString()}

| Step | Actor | CCDExplorer |
|---|---|---|
${rows.join("\n")}
`;
writeFileSync("docs/e2e-run.md", md);
console.log("\nwrote docs/e2e-run.md");
