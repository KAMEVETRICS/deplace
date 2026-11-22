// Registers the reference worker in the Agent Registry (CIS-8004 <12802,0>, testnet) and
// gives it a valid "Verified by Concordium" badge. Idempotent: run it again after each step.
//
//   npm run register -w agent
//
// The Agent Card must be served publicly, byte for byte, at AGENT_CARD_URL (the badge check
// fetches it and compares its SHA-256 with the on-chain metadata_hash). The script writes the
// card to server/public/agents/bounty-worker.json; publish that file at AGENT_CARD_URL.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { credentials } from "@grpc/grpc-js";
import { ConcordiumGRPCNodeClient } from "@concordium/web-sdk/nodejs";
import { AccountAddress, CcdAmount, ContractAddress, Energy, Parameter, ReceiveName, Transaction, TransactionExpiry, TransactionHash } from "@concordium/web-sdk";
import { agentLink } from "@deplace/shared";
import { env, fromRoot } from "./env.js";
import { loadAgentKeys } from "./signer.js";

const REGISTRY_MCP = "https://agent-registry-mcp.concordium.com/mcp";
const CARD_FILE = fromRoot("server/public/agents/bounty-worker.json");
const CARD_URL = env("AGENT_CARD_URL");
const keys = loadAgentKeys(fromRoot(env("AGENT_KEY_FILE", "secrets/worker-agent.export")));
const owner = keys.address;
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Calls a hosted Agent Registry MCP tool on testnet (it defaults to mainnet). Retries network errors. */
async function tool<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: { network: "testnet", ...args } } });
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(REGISTRY_MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body });
      const json = (await res.json()) as { error?: unknown; result?: { isError?: boolean; content?: { text: string }[] } };
      if (json.error) throw new Error(`${name}: ${JSON.stringify(json.error)}`);
      const text = json.result?.content?.[0]?.text ?? "";
      if (json.result?.isError) throw new Error(`${name}: ${text}`);
      return JSON.parse(text) as T;
    } catch (e) {
      if (attempt >= 4 || !(e instanceof TypeError)) throw e; // TypeError = network failure
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

/** Signs a build_* result as the agent's account and waits for finalization (the agent pays this one-time fee). */
async function submit(built: { contract_address: { index: number; subindex: number }; receive_name: string; parameter_hex: string; suggested_energy?: number }) {
  const client = new ConcordiumGRPCNodeClient(env("GRPC_HOST", "grpc.testnet.concordium.com"), Number(env("GRPC_PORT", "20000")), credentials.createSsl(), { timeout: 30_000 });
  const sender = AccountAddress.fromBase58(owner);
  const { nonce } = await client.getNextAccountNonce(sender);
  const tx = Transaction.updateContract(
    {
      amount: CcdAmount.zero(),
      address: ContractAddress.create(built.contract_address.index, built.contract_address.subindex),
      receiveName: ReceiveName.fromString(built.receive_name),
      message: Parameter.fromHexString(built.parameter_hex),
    },
    Energy.create(built.suggested_energy ?? 30_000),
  )
    .addMetadata({ sender, nonce, expiry: TransactionExpiry.futureMinutes(5) })
    .build();
  const hash = await client.sendTransaction(await Transaction.signAndFinalize(tx, keys.signer));
  console.log(`  https://ccdexplorer.io/testnet/transaction/${TransactionHash.toHexString(hash)}`);
  const out = (await client.waitForTransactionFinalization(hash)).summary as { transactionType?: string; rejectReason?: unknown };
  if (out.transactionType === "failed") throw new Error(`${built.receive_name} failed: ${JSON.stringify(out.rejectReason, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
}

async function myAgent(): Promise<{ token_id: number | string; metadata_hash?: string | null; metadata_hash_hex?: string | null } | null> {
  const r = await tool<{ agents?: any[] } | any[]>("agents_by_owner", { owner_account: owner });
  const agents = Array.isArray(r) ? r : (r.agents ?? []);
  const mine = agents.filter((a) => a.agent_uri === CARD_URL && a.status !== "Revoked");
  return mine.length ? mine[mine.length - 1] : null;
}

const cardText = (r: any): string => (typeof r.card_json === "string" ? r.card_json : JSON.stringify(r.card ?? r.card_json, null, 2));

// 1. The card, without a badge yet.
if (!existsSync(CARD_FILE)) {
  const r = await tool("build_agent_card", {
    name: "Deplace reference worker",
    description: "Reference worker agent for Deplace: claims page-facts bounties, fetches the page and reports its title, visible word count and SHA-256.",
    agent_uri: CARD_URL,
    owner_account: owner,
    skills: [{ id: "page-facts", name: "Page facts", description: "Fetch a public URL and report its title, visible word count and SHA-256.", tags: ["bounty", "web"] }],
  });
  mkdirSync(dirname(CARD_FILE), { recursive: true });
  writeFileSync(CARD_FILE, cardText(r));
  console.log(`1. wrote ${CARD_FILE}`);
}

// 2. Register (mints the agent NFT to this account; agentWallet = this account).
let agent = await myAgent();
if (!agent) {
  console.log(`2. registering ${owner} with agent_uri ${CARD_URL}`);
  await submit(await tool("build_register", { sender: owner, agent_uri: CARD_URL }));
  agent = await myAgent();
  if (!agent) throw new Error("registered, but the registry indexer does not list the agent yet; run again in a minute");
}
const tokenId = String(agent.token_id);
console.log(`   agent token id ${tokenId}`);

// 3. Badge the card (needs the token id).
const local = readFileSync(CARD_FILE);
if (!local.toString("utf8").includes("concordium-badge")) {
  writeFileSync(CARD_FILE, cardText(await tool("build_agent_badge", { card_json: local.toString("utf8"), owner_account: owner, token_id: tokenId })));
  console.log(`3. added the badge to ${CARD_FILE}. Publish it at ${CARD_URL}, then run this again.`);
  process.exit(0);
}

// 4. The served bytes must equal the local file.
const served = Buffer.from(await (await fetch(CARD_URL)).arrayBuffer());
if (!served.equals(readFileSync(CARD_FILE))) {
  console.log(`4. ${CARD_URL} does not serve the current card yet (sha256 ${sha256(served)} vs ${sha256(readFileSync(CARD_FILE))}). Publish it, then run again.`);
  process.exit(1);
}

// 5. Pin the card hash on chain.
const onChain = agent.metadata_hash_hex ?? agent.metadata_hash ?? null;
if (onChain !== sha256(served)) {
  console.log(`5. pinning metadata_hash ${sha256(served)}`);
  await submit(await tool("build_set_agent_uri", { token_id: tokenId, metadata_hash_hex: sha256(served), sender: owner }));
}

// 6. Check the badge.
const { token_address: badge } = await tool<{ token_address: string }>("token_address", { contract_index: 12802, contract_subindex: 0, token_id: tokenId });
const verdict = await tool<{ badge_valid: boolean; issues?: { message: string }[] }>("check_badge", { id: badge });
console.log(`6. badge ${badge}: ${verdict.badge_valid ? "VALID" : "not valid"}`);
for (const i of verdict.issues ?? []) console.log(`   - ${i.message}`);
console.log(`   ${agentLink(BigInt(tokenId))}`);
if (verdict.badge_valid) console.log(`\nAdd to .env:\nAGENT_BADGE=${badge}`);
