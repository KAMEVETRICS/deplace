// Registering an agent in the Agent Registry (CIS-8004, testnet) and giving it a valid "Verified by
// Concordium" badge, for the reference agent (src/register.ts) and for anyone's agent (the kit's
// `register` command). Idempotent: run it again after each step.
//
// The flow the registry itself describes: register first, then build the card for the minted
// token id, publish it byte for byte at the card URL, pin its SHA-256 on chain, and check the
// badge (the registry fetches the card and compares the hash).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { credentials } from "@grpc/grpc-js";
import { ConcordiumGRPCNodeClient } from "@concordium/web-sdk/nodejs";
import { AccountAddress, CcdAmount, ContractAddress, Energy, Parameter, ReceiveName, Transaction, TransactionExpiry, TransactionHash } from "@concordium/web-sdk";
import type { AgentKeys } from "./signer.js";

export const REGISTRY_MCP = "https://agent-registry-mcp.concordium.com/mcp";

/** The reference agent's card input: the registry builds the same bytes from it every time, and those bytes are pinned on chain. */
export const REFERENCE_AGENT_CARD = {
  name: "Deplace reference worker",
  description: "Reference worker agent for Deplace: claims page-facts bounties, fetches the page and reports its title, visible word count and SHA-256.",
  skills: [{ id: "page-facts", name: "Page facts", description: "Fetch a public URL and report its title, visible word count and SHA-256.", tags: ["bounty", "web"] }],
};

export interface RegistryTools {
  call<T = any>(name: string, args: Record<string, unknown>): Promise<T>;
}

/** The hosted registry MCP. It defaults to mainnet, so every call says network "testnet". Network failures are retried. */
export function hostedRegistry(url = REGISTRY_MCP, fetchImpl: typeof fetch = fetch): RegistryTools {
  return {
    async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      const body = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: { network: "testnet", ...args } } });
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body });
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
    },
  };
}

/** A registry build_* result: a contract call for the owner to sign. */
export interface BuiltTx {
  contract_address: { index: number; subindex: number };
  receive_name: string;
  parameter_hex: string;
  suggested_energy?: number;
}

export interface RegisterOptions {
  /** The account that owns the agent; its agentWallet is this account too. */
  owner: string;
  /** Signs a build_* result as the owner and waits for it to finalize. */
  submit: (built: BuiltTx, onSent?: (txHash: string) => void) => Promise<void>;
  registry: RegistryTools;
  fetch: typeof fetch;
  card: { name: string; description: string; url: string; file: string; skills: unknown[] };
  /** Written as soon as the register transaction is sent, so a re-run never registers twice while the indexer catches up. */
  registeredFile: string;
  registryContract: { index: bigint; subindex: bigint };
  log: (m: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export type RegisterOutcome =
  | { step: "indexer-behind"; tx: string }
  | { step: "card-written"; file: string; url: string; tokenId: string }
  | { step: "card-not-served"; url: string; served: string; expected: string }
  | { step: "badge"; badge: string; valid: boolean; issues: string[]; tokenId: string };

interface ListedAgent {
  token_id: number | string;
  agent_uri?: string;
  status?: string;
  metadata_hash?: string | null;
  metadata_hash_hex?: string | null;
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const INDEXER_POLLS = 12;
const INDEXER_POLL_MS = 10_000;

/** Runs the registration as far as it can go now, and says where it stopped. */
export async function registerAgent(o: RegisterOptions): Promise<RegisterOutcome> {
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const { card } = o;

  async function myAgent(): Promise<ListedAgent | null> {
    const r = await o.registry.call<{ agents?: ListedAgent[] } | ListedAgent[]>("agents_by_owner", { owner_account: o.owner });
    const agents = Array.isArray(r) ? r : (r.agents ?? []);
    const mine = agents.filter((a) => a.agent_uri === card.url && a.status !== "Revoked");
    return mine.length ? mine[mine.length - 1]! : null;
  }
  async function waitForIndexer(): Promise<ListedAgent | null> {
    for (let i = 0; i < INDEXER_POLLS; i++) {
      const agent = await myAgent();
      if (agent) return agent;
      await sleep(INDEXER_POLL_MS);
    }
    return null;
  }

  // 1. Register (mints the agent NFT to this account; agentWallet = this account).
  let agent = await myAgent();
  if (!agent && existsSync(o.registeredFile)) {
    // Registered before, but the indexer does not list it yet. Registering again would mint a second agent.
    agent = await waitForIndexer();
    if (!agent) return { step: "indexer-behind", tx: readFileSync(o.registeredFile, "utf8").trim() };
  }
  if (!agent) {
    o.log(`1. registering ${o.owner} with agent_uri ${card.url}`);
    mkdirSync(dirname(o.registeredFile), { recursive: true });
    let sent = "";
    await o.submit(await o.registry.call<BuiltTx>("build_register", { sender: o.owner, agent_uri: card.url }), (tx) => {
      sent = tx;
      writeFileSync(o.registeredFile, tx + "\n");
    });
    agent = await waitForIndexer();
    if (!agent) return { step: "indexer-behind", tx: sent };
  }
  const tokenId = String(agent.token_id);
  o.log(`1. agent token id ${tokenId}`);

  // 2. The card for this token id. The registry builds it deterministically, badge block included.
  const built = await o.registry.call<{ agent_card_json?: unknown }>("build_agent_card", {
    name: card.name,
    description: card.description,
    agent_uri: card.url,
    owner_account: o.owner,
    token_id: tokenId,
    skills: card.skills,
  });
  if (typeof built?.agent_card_json !== "string") throw new Error(`the registry returned no agent_card_json (got: ${Object.keys(built ?? {}).join(", ")})`);
  const cardText = built.agent_card_json;
  if (!existsSync(card.file) || readFileSync(card.file, "utf8") !== cardText) {
    mkdirSync(dirname(card.file), { recursive: true });
    writeFileSync(card.file, cardText);
    o.log(`2. wrote the card for token ${tokenId} to ${card.file}. Publish it at ${card.url} byte for byte, then run this again.`);
    return { step: "card-written", file: card.file, url: card.url, tokenId };
  }

  // 3. The served bytes must equal the local file.
  const served = Buffer.from(await (await o.fetch(card.url)).arrayBuffer());
  const local = readFileSync(card.file);
  if (!served.equals(local)) {
    o.log(`3. ${card.url} does not serve the current card yet (sha256 ${sha256(served)} vs ${sha256(local)}). Publish it, then run again.`);
    return { step: "card-not-served", url: card.url, served: sha256(served), expected: sha256(local) };
  }

  // 4. Pin the card hash on chain.
  const onChain = agent.metadata_hash_hex ?? agent.metadata_hash ?? null;
  if (onChain !== sha256(served)) {
    o.log(`4. pinning metadata_hash ${sha256(served)}`);
    await o.submit(await o.registry.call<BuiltTx>("build_set_agent_uri", { token_id: tokenId, metadata_hash_hex: sha256(served), sender: o.owner }));
  }

  // 5. Check the badge.
  const { token_address: badge } = await o.registry.call<{ token_address: string }>("token_address", {
    contract_index: Number(o.registryContract.index),
    contract_subindex: Number(o.registryContract.subindex),
    token_id: tokenId,
  });
  const verdict = await o.registry.call<{ badge_valid: boolean; issues?: { message: string }[] }>("check_badge", { id: badge });
  const issues = (verdict.issues ?? []).map((i) => i.message);
  o.log(`5. badge ${badge}: ${verdict.badge_valid ? "VALID" : "not valid"}`);
  for (const i of issues) o.log(`   - ${i}`);
  return { step: "badge", badge, valid: verdict.badge_valid === true, issues, tokenId };
}

/** Signs a build_* result as the owner and waits for finalization; the owner pays this one-time fee in CCD. */
export function chainSubmitter(keys: AgentKeys, grpc: { host: string; port: number }, log: (m: string) => void = (m) => console.log(m)): RegisterOptions["submit"] {
  return async (built, onSent = () => {}) => {
    const client = new ConcordiumGRPCNodeClient(grpc.host, grpc.port, credentials.createSsl(), { timeout: 30_000 });
    const sender = AccountAddress.fromBase58(keys.address);
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
    log(`  https://ccdexplorer.io/testnet/transaction/${TransactionHash.toHexString(hash)}`);
    const out = (await client.waitForTransactionFinalization(hash)).summary as { transactionType?: string; rejectReason?: unknown };
    if (out.transactionType === "failed") throw new Error(`${built.receive_name} failed: ${JSON.stringify(out.rejectReason, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  };
}
