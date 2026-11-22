import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeIdHash, type Bounty, type BoardEvent } from "@bounty/shared";
import { createApp } from "../src/api/app.js";
import { BoardService, type BoardDeps } from "../src/board/service.js";
import { challengeMessage } from "../src/identity/challenge.js";
import { Attestor } from "../src/identity/attestor.js";
import { BoardStore } from "../src/store/db.js";
import type { Intent } from "../src/sponsor/policy.js";
import { lookupOf, testAccount } from "./helpers/accounts.js";

const poster = testAccount(31, 0);
const company = testAccount(32, 4);
const worker = testAccount(33, 0);
const agentWallet = testAccount(34, 0);
const ESCROW = testAccount(35).address;
const SPONSOR = testAccount(36).address;
const CONTRACT = { index: 13001n, subindex: 0n };
const NOW = 1_800_000_000_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function bounty(id: bigint, over: Partial<Bounty> = {}): Bounty {
  return {
    id,
    poster: poster.address,
    posterAgent: null,
    kind: "Exclusive",
    specHash: "ab".repeat(32),
    reward: 2_000_000n,
    funding: { type: "NotFunded" },
    deadline: BigInt(NOW + 3_600_000),
    status: { type: "Open" },
    rejections: 0,
    lastRejectedAt: null,
    entryCount: 0,
    created: BigInt(NOW),
    ...over,
  };
}

let chainBounties: Map<bigint, Bounty>;
let intents: { intent: Intent; sender: string; badge?: string }[];
let allowList: Set<string>;
let submitted: string[];
let relayOutcome: { txHash: string; summary: unknown; sponsor: string | null };
let deposits: string[];
let observed: string[];
let base = "";
let service: BoardService;
let close = () => {};
let unsponsored = false;
let badgeResponse: () => Response;

const badgeVerdict = (owner: string) => ({
  token_id: 9,
  agent_uri: "https://board.example/agents/w.json",
  on_chain: { owner_account: owner, status: "Active" },
  badge_valid: true,
  issues: [],
});

function deps(): BoardDeps {
  return {
    config: {
      contract: CONTRACT,
      rewardTokenId: "EUDemo",
      tokenDecimals: 6,
      escrowAccount: ESCROW,
      sponsorAddress: SPONSOR,
      faucetUrl: "https://faucet.example",
      badgeApi: "https://badge.example",
    },
    store: new BoardStore(join(mkdtempSync(join(tmpdir(), "api-")), "b.db")),
    chain: {
      view: async (id) => chainBounties.get(id) ?? null,
      entry: async () => null,
      stats: async () => ({ posted: 1, paidAsPoster: 0, unpaid: 0, rejectedFinal: 0, noAward: 0, paidAsWorker: 0 }),
      all: async () => [...chainBounties.values()],
    },
    isOnAllowList: async (a) => allowList.has(a),
    accounts: lookupOf(poster, company, worker, agentWallet),
    idpName: (i) => ({ 0: "Concordium testnet IP", 4: "Global FinReg Testnet" })[i],
    agentWallet: async () => agentWallet.address,
    fetch: (async () => badgeResponse()) as unknown as typeof fetch,
    sponsor: {
      prepare: async (intent, sender, badge) => {
        intents.push({ intent, sender, badge });
        return unsponsored
          ? { txJson: "{}", sender, expiresAt: NOW, feeSponsored: false, notice: "Network fee applies: test" }
          : { txJson: "{}", sender, expiresAt: NOW, feeSponsored: true };
      },
    },
    attestor: new Attestor("09".repeat(32), () => BigInt(NOW)),
    txSponsor: () => relayOutcome.sponsor,
    relay: async (txJson) => {
      submitted.push(txJson);
      return { txHash: relayOutcome.txHash, summary: relayOutcome.summary };
    },
    outcome: async (txHash) => {
      observed.push(txHash);
      return { summary: relayOutcome.summary };
    },
    eventsOf: (summary) => ((summary as { __events?: BoardEvent[] }).__events ?? []),
    noteTransfer: async (tx) => {
      deposits.push(tx);
    },
    now: () => NOW,
  };
}

beforeEach(async () => {
  chainBounties = new Map();
  intents = [];
  allowList = new Set([worker.address, agentWallet.address]);
  submitted = [];
  deposits = [];
  observed = [];
  unsponsored = false;
  badgeResponse = () => new Response(JSON.stringify(badgeVerdict(poster.address)), { status: 200 });
  relayOutcome = { txHash: "aa".repeat(32), summary: {}, sponsor: SPONSOR };
  service = new BoardService(deps());
  const app = createApp({ service });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterEach(() => close());

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function loginAccount(acct = poster) {
  const ch = await call("POST", "/auth/challenge", { account: acct.address });
  const signature = await acct.sign(ch.body.message);
  const r = await call("POST", "/auth/login", { account: acct.address, nonce: ch.body.nonce, signature });
  expect(r.status).toBe(200);
  return r.body;
}

const spec = { title: "Facts about a page", description: "Title, word count and hash", taskKind: "page-facts", input: { url: "https://example.org" }, kind: "Exclusive", reward: "2", deadline: NOW + 3_600_000 };

describe("auth", () => {
  it("logs a person in with a signed challenge and labels the identity provider", async () => {
    const r = await loginAccount();
    expect(r.identity).toEqual({ kind: "person", label: "Verified person (Concordium testnet IP)", account: poster.address });
    expect(typeof r.token).toBe("string");
  });

  it("labels company accounts", async () => {
    expect((await loginAccount(company)).identity.kind).toBe("company");
  });

  it("refuses a signature by someone else, and a reused nonce", async () => {
    const ch = await call("POST", "/auth/challenge", { account: poster.address });
    const bad = await call("POST", "/auth/login", { account: poster.address, nonce: ch.body.nonce, signature: await worker.sign(ch.body.message) });
    expect(bad.status).toBe(401);
    const again = await call("POST", "/auth/login", { account: poster.address, nonce: ch.body.nonce, signature: await poster.sign(ch.body.message) });
    expect(again.status).toBe(401);
  });

  it("logs an agent in with its badge and the agent wallet's signature", async () => {
    const ch = await call("POST", "/auth/challenge", { badge: "JyP9Badge" });
    expect(ch.body.message).toBe(challengeMessage(ch.body.nonce));
    const r = await call("POST", "/auth/login", { badge: "JyP9Badge", nonce: ch.body.nonce, signature: await agentWallet.sign(ch.body.message) });
    expect(r.status).toBe(200);
    expect(r.body.identity).toMatchObject({ kind: "agent", account: agentWallet.address, tokenId: "9", badge: "JyP9Badge" });
  });

  it("re-checks an agent's badge before attesting a claim, so a revoked agent stops at once", async () => {
    chainBounties.set(0n, bounty(0n));
    const ch = await call("POST", "/auth/challenge", { badge: "JyP9Badge" });
    const login = await call("POST", "/auth/login", { badge: "JyP9Badge", nonce: ch.body.nonce, signature: await agentWallet.sign(ch.body.message) });
    badgeResponse = () => new Response(JSON.stringify({ error: "revoked", message: "agent revoked" }), { status: 409 });
    expect((await call("POST", "/bounties/0/claim", {}, login.body.token)).status).toBe(401);
    badgeResponse = () => new Response("{}", { status: 429, headers: { "retry-after": "7" } });
    const busy = await call("POST", "/bounties/0/claim", {}, login.body.token);
    expect(busy.status).toBe(503);
    expect(busy.body.retryAfter).toBe(7);
    expect(intents).toEqual([]);
  });
});

describe("posting and working", () => {
  it("post_returns_spec_hash_matching_body", async () => {
    const { token } = await loginAccount();
    const r = await call("POST", "/bounties", spec, token);
    expect(r.status).toBe(200);
    const stored = await call("GET", `/specs/${r.body.specHash}`);
    expect(sha(JSON.stringify(stored.body))).toBe(r.body.specHash);
    expect(stored.body).toMatchObject({ title: spec.title, taskKind: "page-facts", reward: "2", rewardToken: "EUDemo", poster: poster.address });
    expect(intents[0]).toMatchObject({ sender: poster.address, intent: { type: "contract", entrypoint: "post" } });
    const param = Buffer.from((intents[0]!.intent as { parameter: Uint8Array }).parameter).toString("hex");
    expect(param).toContain(r.body.specHash);
    expect(param).toContain("80841e0000000000"); // reward 2 EUDemo = 2_000_000 base units
    expect(r.body.prepared.feeSponsored).toBe(true);
  });

  it("rejects an invalid spec with a reason", async () => {
    const { token } = await loginAccount();
    for (const bad of [{ ...spec, title: "" }, { ...spec, reward: "0" }, { ...spec, reward: "1.0000001" }, { ...spec, deadline: NOW - 1 }, { ...spec, kind: "Lottery" }]) {
      const r = await call("POST", "/bounties", bad, token);
      expect(r.status).toBe(400);
      expect(typeof r.body.error).toBe("string");
    }
  });

  it("claim_without_session_401", async () => {
    chainBounties.set(0n, bounty(0n));
    expect((await call("POST", "/bounties/0/claim")).status).toBe(401);
    expect((await call("POST", "/bounties/0/claim", {}, "made-up")).status).toBe(401);
  });

  it("claim_ineligible_returns_reason", async () => {
    chainBounties.set(0n, bounty(0n));
    allowList.clear();
    const { token } = await loginAccount(worker);
    const r = await call("POST", "/bounties/0/claim", {}, token);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: expect.stringMatching(/allow list/), faucetUrl: "https://faucet.example" });
    expect(intents).toEqual([]);
  });

  it("prepares a claim with a fresh attestation", async () => {
    chainBounties.set(0n, bounty(0n));
    const { token } = await loginAccount(worker);
    const r = await call("POST", "/bounties/0/claim", {}, token);
    expect(r.status).toBe(200);
    expect(intents[0]).toMatchObject({ sender: worker.address, intent: { entrypoint: "claim" } });
  });

  it("refuses to claim a contest or a bounty that is not open", async () => {
    chainBounties.set(0n, bounty(0n, { kind: "Contest" }));
    chainBounties.set(1n, bounty(1n, { status: { type: "Claimed", worker: worker.address, agent: null } }));
    const { token } = await loginAccount(worker);
    expect((await call("POST", "/bounties/0/claim", {}, token)).status).toBe(409);
    expect((await call("POST", "/bounties/1/claim", {}, token)).status).toBe(409);
    expect((await call("POST", "/bounties/7/claim", {}, token)).status).toBe(404);
  });

  it("submit_stores_work_and_hash_matches", async () => {
    chainBounties.set(0n, bounty(0n, { status: { type: "Claimed", worker: worker.address, agent: null } }));
    const { token } = await loginAccount(worker);
    const r = await call("POST", "/bounties/0/submit", { preview: "title: Example", full: '{"title":"Example","words":42}' }, token);
    expect(r.status).toBe(200);
    expect(r.body.workHash).toBe(sha('{"title":"Example","words":42}'));
    const param = Buffer.from((intents[0]!.intent as { parameter: Uint8Array }).parameter).toString("hex");
    expect(param).toBe(Buffer.from(encodeIdHash(0n, r.body.workHash)).toString("hex"));
  });

  it("only the claimed worker can submit", async () => {
    chainBounties.set(0n, bounty(0n, { status: { type: "Claimed", worker: agentWallet.address, agent: null } }));
    const { token } = await loginAccount(worker);
    expect((await call("POST", "/bounties/0/submit", { preview: "p", full: "f" }, token)).status).toBe(403);
  });

  it("contest submissions are entries with their own attestation", async () => {
    chainBounties.set(0n, bounty(0n, { kind: "Contest" }));
    const { token } = await loginAccount(worker);
    const r = await call("POST", "/bounties/0/submit", { preview: "p", full: "f" }, token);
    expect(r.status).toBe(200);
    expect(intents[0]!.intent).toMatchObject({ entrypoint: "enter" });
  });

  it("only the poster can accept, reject, award or cancel", async () => {
    chainBounties.set(0n, bounty(0n, { status: { type: "Submitted", worker: worker.address, agent: null, workHash: "cd".repeat(32), at: 1n } }));
    const w = await loginAccount(worker);
    expect((await call("POST", "/bounties/0/accept", {}, w.token)).status).toBe(403);
    const p = await loginAccount(poster);
    expect((await call("POST", "/bounties/0/accept", {}, p.token)).status).toBe(200);
    expect((await call("POST", "/bounties/0/reject", { reason: "missing word count" }, p.token)).status).toBe(200);
    expect(intents.map((i) => (i.intent as { entrypoint: string }).entrypoint)).toEqual(["accept", "reject"]);
  });

  it("fee_fallback_flag_surfaces_in_response", async () => {
    unsponsored = true;
    const { token } = await loginAccount();
    const r = await call("POST", "/bounties", spec, token);
    expect(r.body.prepared).toMatchObject({ feeSponsored: false, notice: expect.stringMatching(/network fee applies/i) });
  });
});

describe("relay and reads", () => {
  it("relays a signed transaction, records its events and refreshes the bounty", async () => {
    chainBounties.set(0n, bounty(0n, { status: { type: "Claimed", worker: worker.address, agent: null } }));
    relayOutcome = {
      txHash: "aa".repeat(32),
      sponsor: SPONSOR,
      summary: { __events: [{ type: "Claimed", id: 0n, worker: worker.address, agent: null } satisfies BoardEvent] },
    };
    const r = await call("POST", "/tx/submit", { txJson: '{"signed":true}' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ txHash: "aa".repeat(32), link: `https://ccdexplorer.io/testnet/transaction/${"aa".repeat(32)}` });
    const detail = await call("GET", "/bounties/0");
    expect(detail.body.bounty.status.type).toBe("Claimed");
    expect(detail.body.events[0]).toMatchObject({ tx: "aa".repeat(32), link: expect.stringContaining("/transaction/") });
  });

  it("refuses to relay a transaction our sponsor did not co-sign, without sending it", async () => {
    relayOutcome = { txHash: "aa".repeat(32), sponsor: null, summary: {} };
    expect((await call("POST", "/tx/submit", { txJson: "{}" })).status).toBe(400);
    expect(submitted).toEqual([]);
  });

  it("observes a transaction the browser wallet submitted itself", async () => {
    chainBounties.set(0n, bounty(0n, { status: { type: "Claimed", worker: worker.address, agent: null } }));
    relayOutcome = { txHash: "cc".repeat(32), sponsor: SPONSOR, summary: { __events: [{ type: "Claimed", id: 0n, worker: worker.address, agent: null }] } };
    const r = await call("POST", "/tx/observe", { txHash: "cc".repeat(32) });
    expect(r.status).toBe(200);
    expect(observed).toEqual(["cc".repeat(32)]);
    expect(submitted).toEqual([]); // nothing re-sent
    expect((await call("GET", "/bounties/0")).body.events[0]).toMatchObject({ tx: "cc".repeat(32) });
    expect((await call("POST", "/tx/observe", { txHash: "nope" })).status).toBe(400);
  });

  it("records the operator's own payout transactions in the bounty's trail", async () => {
    chainBounties.set(0n, bounty(0n, { status: { type: "Paid" } }));
    await service.noteOperatorTransaction("dd".repeat(32), { __events: [{ type: "PayoutRecorded", id: 0n, to: worker.address, amount: 2_000_000n, tx: "ee".repeat(32) }] });
    const detail = await call("GET", "/bounties/0");
    expect(detail.body.events.map((e: any) => e.event.type)).toEqual(["PayoutRecorded"]);
    expect(detail.body.bounty.status.type).toBe("Paid");
  });

  it("notes a funding transfer for the escrow worker", async () => {
    relayOutcome = { txHash: "bb".repeat(32), sponsor: SPONSOR, summary: { transactionType: "tokenUpdate", events: [] } };
    await call("POST", "/tx/submit", { txJson: "{}" });
    expect(deposits).toEqual(["bb".repeat(32)]);
  });

  it("bounty_detail_includes_explorer_links", async () => {
    chainBounties.set(0n, bounty(0n));
    const r = await call("GET", "/bounties/0");
    expect(r.status).toBe(200);
    expect(r.body.links).toMatchObject({
      contract: "https://ccdexplorer.io/testnet/instance/13001/0",
      poster: `https://ccdexplorer.io/testnet/account/${poster.address}`,
    });
    expect(r.body.bounty.reward).toBe("2000000"); // bigints as strings
    expect(r.body.posterProfile.identity.kind).toBe("person");
  });

  it("publishes the board's public configuration", async () => {
    const r = await call("GET", "/config");
    expect(r.body).toEqual({
      rewardToken: "EUDemo",
      decimals: 6,
      contract: { index: "13001", subindex: "0" },
      escrowAccount: ESCROW,
      sponsorAccount: SPONSOR,
      faucetUrl: "https://faucet.example",
    });
  });

  it("lists bounties with filters", async () => {
    chainBounties.set(0n, bounty(0n));
    chainBounties.set(1n, bounty(1n, { kind: "Contest", funding: { type: "Escrowed", fundingTx: "11".repeat(32) } }));
    expect((await call("GET", "/bounties")).body.bounties).toHaveLength(2);
    expect((await call("GET", "/bounties?kind=Contest")).body.bounties.map((b: any) => b.id)).toEqual(["1"]);
    expect((await call("GET", "/bounties?funding=NotFunded")).body.bounties.map((b: any) => b.id)).toEqual(["0"]);
  });
});
