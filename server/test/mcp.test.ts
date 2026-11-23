import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer, TOOL_NAMES } from "../src/mcp/server.js";
import { testAccount } from "./helpers/accounts.js";
import { fakeBoard, openBounty } from "./helpers/board.js";

const poster = testAccount(51);
const worker = testAccount(52);

async function connect() {
  const board = fakeBoard([poster, worker]);
  const server = buildMcpServer(board.service, { publicBaseUrl: "https://board.example" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test-agent", version: "0" });
  await client.connect(b);
  return { client, ...board };
}

const json = (r: any) => JSON.parse(r.content[0].text);

describe("board MCP server", () => {
  it("lists every tool, each with a description", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) expect(t.description?.length).toBeGreaterThan(20);
    expect(tools.find((t) => t.name === "prepare_claim")?.description).toMatch(/fee/i);
  });

  it("lists bounties", async () => {
    const { client, chain } = await connect();
    chain.set(0n, openBounty(0n, poster.address));
    const r = await client.callTool({ name: "list_bounties", arguments: { status: "Open" } });
    expect(json(r).bounties.map((b: any) => b.id)).toEqual(["0"]);
  });

  it("refuses work tools without a session, as a tool error", async () => {
    const { client, chain } = await connect();
    chain.set(0n, openBounty(0n, poster.address));
    const r: any = await client.callTool({ name: "prepare_claim", arguments: { session: "nope", bounty_id: "0" } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/log in/);
    expect(json(r)).not.toHaveProperty("retryable");
  });

  it("marks a login the badge service could not check as worth retrying", async () => {
    const { client, deps } = await connect();
    deps.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const ch = json(await client.callTool({ name: "request_challenge", arguments: { badge: "JyP9Badge" } }));
    const r: any = await client.callTool({ name: "login", arguments: { badge: "JyP9Badge", nonce: ch.nonce, signature: { "0": { "0": "00" } } } });
    expect(r.isError).toBe(true);
    expect(json(r)).toMatchObject({ error: expect.stringMatching(/unavailable/), retryable: true });
  });

  it("marks a chain read that failed on the network as worth retrying", async () => {
    const { client, deps } = await connect();
    deps.isOnAllowList = async () => {
      throw new Error("read ECONNRESET");
    };
    const r: any = await client.callTool({ name: "check_payout_eligibility", arguments: { account: worker.address } });
    expect(r.isError).toBe(true);
    expect(json(r)).toMatchObject({ error: expect.stringContaining("ECONNRESET"), retryable: true });
  });

  it("does not mark a crash inside the board as worth retrying", async () => {
    const { client, deps } = await connect();
    deps.isOnAllowList = async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'state')");
    };
    const r: any = await client.callTool({ name: "check_payout_eligibility", arguments: { account: worker.address } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).not.toMatch(/retryable/);
  });

  it("logs in with a signed challenge and prepares a sponsored claim", async () => {
    const { client, chain, intents } = await connect();
    chain.set(0n, openBounty(0n, poster.address));
    const ch = json(await client.callTool({ name: "request_challenge", arguments: { account: worker.address } }));
    const signature = await worker.sign(ch.message);
    const login = json(await client.callTool({ name: "login", arguments: { account: worker.address, nonce: ch.nonce, signature } }));
    expect(login.identity.account).toBe(worker.address);
    const prepared = json(await client.callTool({ name: "prepare_claim", arguments: { session: login.token, bounty_id: "0" } }));
    expect(prepared.prepared.feeSponsored).toBe(true);
    expect(intents[0]).toMatchObject({ sender: worker.address, intent: { entrypoint: "claim" } });
  });

  it("reports payout eligibility with the faucet link", async () => {
    const { client, allowList } = await connect();
    allowList.delete(worker.address);
    const r = json(await client.callTool({ name: "check_payout_eligibility", arguments: { account: worker.address } }));
    expect(r).toMatchObject({ ok: false, faucetUrl: "https://faucet.example" });
  });

  it("fetch_work points not-funded deliveries at the x402 endpoint", async () => {
    const { client, chain, store } = await connect();
    const full = "the work";
    const hash = (await import("node:crypto")).createHash("sha256").update(full).digest("hex");
    store.putSubmission({ workHash: hash, bountyId: 0n, worker: worker.address, preview: "p", full });
    chain.set(0n, openBounty(0n, poster.address, { status: { type: "Accepted", worker: worker.address, at: 1n, workHash: hash } }));
    const ch = json(await client.callTool({ name: "request_challenge", arguments: { account: poster.address } }));
    const login = json(await client.callTool({ name: "login", arguments: { account: poster.address, nonce: ch.nonce, signature: await poster.sign(ch.message) } }));
    const r = json(await client.callTool({ name: "fetch_work", arguments: { session: login.token, bounty_id: "0" } }));
    expect(r).toMatchObject({ paymentRequired: true, url: "https://board.example/bounties/0/work", payTo: worker.address, amount: "1000000" });
  });
});
