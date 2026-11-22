// Registers the reference worker in the Agent Registry (CIS-8004 <12802,0>, testnet) and
// gives it a valid "Verified by Concordium" badge. Idempotent: run it again after each step.
//
//   npm run register -w agent
//
// The flow the registry itself describes: register first, then build the card for the minted
// token id, publish it byte for byte at AGENT_CARD_URL, pin its SHA-256 on chain, and check
// the badge (it fetches the card and compares the hash). The script writes the card to
// server/public/agents/bounty-worker.json; publish that file at AGENT_CARD_URL.
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
/** Written as soon as the register transaction is sent, so a re-run never registers twice while the indexer catches up. */
const REGISTERED_FILE = fromRoot("data/agent-register-tx.txt");
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
async function submit(
  built: { contract_address: { index: number; subindex: number }; receive_name: string; parameter_hex: string; suggested_energy?: number },
  onSent: (txHash: string) => void = () => {},
) {
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
  onSent(TransactionHash.toHexString(hash));
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

/** The registry returns the card as `agent_card_json`: the exact text to host. */
function cardText(r: { agent_card_json?: unknown }): string {
  if (typeof r?.agent_card_json !== "string") throw new Error(`the registry returned no agent_card_json (got: ${Object.keys(r ?? {}).join(", ")})`);
  return r.agent_card_json;
}

// 1. Register (mints the agent NFT to this account; agentWallet = this account).
let agent = await myAgent();
if (!agent && existsSync(REGISTERED_FILE)) {
  // Registered before, but the indexer does not list it yet. Registering again would mint a second agent.
  for (let i = 0; i < 12 && !agent; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    agent = await myAgent();
  }
  if (!agent) {
    const tx = readFileSync(REGISTERED_FILE, "utf8").trim();
    throw new Error(`registered in https://ccdexplorer.io/testnet/transaction/${tx} but the registry indexer does not list the agent yet; run again later (delete ${REGISTERED_FILE} only if that transaction failed)`);
  }
}
if (!agent) {
  console.log(`1. registering ${owner} with agent_uri ${CARD_URL}`);
  mkdirSync(dirname(REGISTERED_FILE), { recursive: true });
  await submit(await tool("build_register", { sender: owner, agent_uri: CARD_URL }), (tx) => writeFileSync(REGISTERED_FILE, tx + "\n"));
  for (let i = 0; i < 12 && !agent; i++) {
    agent = await myAgent();
    if (!agent) await new Promise((r) => setTimeout(r, 10_000));
  }
  if (!agent) throw new Error("registered, but the registry indexer does not list the agent yet; run again in a few minutes");
}
const tokenId = String(agent.token_id);
console.log(`1. agent token id ${tokenId}`);

// 2. The card for this token id. The registry builds it deterministically, badge block included.
const card = cardText(
  await tool("build_agent_card", {
    name: "Deplace reference worker",
    description: "Reference worker agent for Deplace: claims page-facts bounties, fetches the page and reports its title, visible word count and SHA-256.",
    agent_uri: CARD_URL,
    owner_account: owner,
    token_id: tokenId,
    skills: [{ id: "page-facts", name: "Page facts", description: "Fetch a public URL and report its title, visible word count and SHA-256.", tags: ["bounty", "web"] }],
  }),
);
if (!existsSync(CARD_FILE) || readFileSync(CARD_FILE, "utf8") !== card) {
  mkdirSync(dirname(CARD_FILE), { recursive: true });
  writeFileSync(CARD_FILE, card);
  console.log(`2. wrote the card for token ${tokenId} to ${CARD_FILE}. Publish it at ${CARD_URL} byte for byte, then run this again.`);
  process.exit(0);
}

// 3. The served bytes must equal the local file.
const served = Buffer.from(await (await fetch(CARD_URL)).arrayBuffer());
if (!served.equals(readFileSync(CARD_FILE))) {
  console.log(`3. ${CARD_URL} does not serve the current card yet (sha256 ${sha256(served)} vs ${sha256(readFileSync(CARD_FILE))}). Publish it, then run again.`);
  process.exit(1);
}

// 4. Pin the card hash on chain.
const onChain = agent.metadata_hash_hex ?? agent.metadata_hash ?? null;
if (onChain !== sha256(served)) {
  console.log(`4. pinning metadata_hash ${sha256(served)}`);
  await submit(await tool("build_set_agent_uri", { token_id: tokenId, metadata_hash_hex: sha256(served), sender: owner }));
}

// 5. Check the badge.
const { token_address: badge } = await tool<{ token_address: string }>("token_address", { contract_index: 12802, contract_subindex: 0, token_id: tokenId });
const verdict = await tool<{ badge_valid: boolean; issues?: { message: string }[] }>("check_badge", { id: badge });
console.log(`5. badge ${badge}: ${verdict.badge_valid ? "VALID" : "not valid"}`);
for (const i of verdict.issues ?? []) console.log(`   - ${i.message}`);
console.log(`   ${agentLink(BigInt(tokenId))}`);
if (verdict.badge_valid) console.log(`\nAdd to .env:\nAGENT_BADGE=${badge}`);
