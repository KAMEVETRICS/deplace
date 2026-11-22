// Spike 03 (also covers spike 02: a sponsored *contract update*): register worker-agent in the
// Agent Registry with our own sponsor paying, give it a badge, pin the card hash, check the badge.
//
// The card must be publicly reachable at AGENT_CARD_URL (the badge check fetches it).
// Steps, run in order:
//   npx tsx spikes/03-register-agent.ts card      # write the initial card file
//   (publish the file at AGENT_CARD_URL)
//   npx tsx spikes/03-register-agent.ts register  # sponsored CIS-8004.register
//   npx tsx spikes/03-register-agent.ts badge     # add the badge to the card (needs token id)
//   (publish the updated file again)
//   npx tsx spikes/03-register-agent.ts pin       # sponsored setAgentURI with the card's SHA-256
//   npx tsx spikes/03-register-agent.ts check     # hosted badge check (testnet)
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CcdAmount, ContractAddress, Energy, Parameter, ReceiveName, Transaction } from "@concordium/web-sdk";
import { describeOutcome, grpc, loadWallet, sponsoredSend } from "./lib.ts";

const MCP = "https://agent-registry-mcp.concordium.com/mcp";
const CARD_FILE = "server/public/agents/bounty-worker.json";
const CARD_URL = process.env.AGENT_CARD_URL;
if (!CARD_URL) throw new Error("set AGENT_CARD_URL to the public URL the card is served at");

async function mcp(name: string, args: Record<string, unknown>): Promise<any> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: { network: "testnet", ...args } } });
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body });
      const json: any = await res.json();
      if (json.error) throw new Error(`${name}: ${JSON.stringify(json.error)}`);
      const text = json.result?.content?.[0]?.text;
      if (json.result?.isError) throw new Error(`${name}: ${text}`);
      return JSON.parse(text);
    } catch (e) {
      if (attempt >= 4 || !(e instanceof TypeError)) throw e; // TypeError = network failure (flaky DNS here)
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

const worker = loadWallet("worker-agent");
const sponsor = loadWallet("sponsor");
const owner = worker.address.address;
const step = process.argv[2];
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function submitBuilt(built: any) {
  const client = grpc();
  const tx = Transaction.updateContract(
    {
      amount: CcdAmount.zero(),
      address: ContractAddress.create(built.contract_address.index, built.contract_address.subindex),
      receiveName: ReceiveName.fromString(built.receive_name),
      message: Parameter.fromHexString(built.parameter_hex),
    },
    Energy.create(built.suggested_energy ?? 30000),
  );
  const { outcome } = await sponsoredSend(client, tx, worker, sponsor);
  console.log(describeOutcome(outcome).slice(0, 4000));
}

async function tokenId(): Promise<string> {
  const r = await mcp("agents_by_owner", { owner_account: owner });
  const agents = (r.agents ?? r) as any[];
  const mine = agents.filter((a) => a.agent_uri === CARD_URL);
  if (mine.length === 0) throw new Error(`no agent of ${owner} with agent_uri ${CARD_URL}: ${JSON.stringify(r).slice(0, 500)}`);
  return String(mine[mine.length - 1].token_id);
}

if (step === "card") {
  const r = await mcp("build_agent_card", {
    name: "Deplace reference worker",
    description: "Reference worker agent for Deplace. It claims page-facts bounties, fetches the page and reports its title, word count and SHA-256.",
    agent_uri: CARD_URL,
    owner_account: owner,
    skills: [{ id: "page-facts", name: "Page facts", description: "Fetch a public URL and report its title, word count and SHA-256.", tags: ["bounty", "web"] }],
  });
  const json: string = typeof r.card_json === "string" ? r.card_json : JSON.stringify(r.card ?? r.card_json ?? r, null, 2);
  mkdirSync(dirname(CARD_FILE), { recursive: true });
  writeFileSync(CARD_FILE, json);
  console.log(`wrote ${CARD_FILE} sha256=${sha256(Buffer.from(json))} (tool keys: ${Object.keys(r).join(",")})`);
} else if (step === "register") {
  await submitBuilt(await mcp("build_register", { sender: owner, agent_uri: CARD_URL }));
} else if (step === "badge") {
  const id = await tokenId();
  const r = await mcp("build_agent_badge", { card_json: readFileSync(CARD_FILE, "utf8"), owner_account: owner, token_id: id });
  const json: string = typeof r.card_json === "string" ? r.card_json : JSON.stringify(r.card ?? r, null, 2);
  writeFileSync(CARD_FILE, json);
  console.log(`token_id=${id}; wrote badged card sha256=${sha256(Buffer.from(json))} (tool keys: ${Object.keys(r).join(",")})`);
} else if (step === "pin") {
  const id = await tokenId();
  // Hash what is actually served, not the local file, so a mismatch shows up here.
  const served = Buffer.from(await (await fetch(CARD_URL)).arrayBuffer());
  const local = readFileSync(CARD_FILE);
  if (!served.equals(local)) throw new Error("served card differs from the local file; publish it first");
  await submitBuilt(await mcp("build_set_agent_uri", { token_id: id, metadata_hash_hex: sha256(served), sender: owner }));
} else if (step === "check") {
  const id = await tokenId();
  const addr = await mcp("token_address", { contract_index: 12802, contract_subindex: 0, token_id: id });
  console.log("token address:", JSON.stringify(addr));
  const badge = addr.token_address ?? addr;
  console.log(JSON.stringify(await mcp("check_badge", { id: badge }), null, 2).slice(0, 4000));
} else {
  throw new Error("step must be one of: card, register, badge, pin, check");
}
