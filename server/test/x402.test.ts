import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Bounty, BountyStatus, Funding } from "@bounty/shared";
import { createApp } from "../src/api/app.js";
import { BoardService } from "../src/board/service.js";
import { Attestor } from "../src/identity/attestor.js";
import { BoardStore } from "../src/store/db.js";
import { x402Router, type X402Gateway } from "../src/x402/routes.js";
import { lookupOf, testAccount } from "./helpers/accounts.js";

const poster = testAccount(41);
const worker = testAccount(42);
const other = testAccount(43);
const ESCROW = testAccount(44).address;
const NOW = 1_800_000_000_000;
const FULL = '{"title":"Example Domain","words":28}';
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const WORK_HASH = sha(FULL);

let chain: Map<bigint, Bounty>;
let store: BoardStore;
let gwCalls: { payTo: string; amount: bigint }[];
let settleResult: Awaited<ReturnType<X402Gateway["settle"]>>;
let payouts: [bigint, { to: string; amount: bigint; tx: string }[]][];
let deposits: string[];
let base = "";
let close = () => {};
let service: BoardService;

function bounty(id: bigint, status: BountyStatus, funding: Funding = { type: "NotFunded" }): Bounty {
  return {
    id,
    poster: poster.address,
    posterAgent: null,
    kind: "Exclusive",
    specHash: "ab".repeat(32),
    reward: 3_000_000n,
    funding,
    deadline: BigInt(NOW + 3_600_000),
    status,
    rejections: 0,
    lastRejectedAt: null,
    entryCount: 0,
    created: BigInt(NOW),
  };
}

const gateway: X402Gateway = {
  paymentRequired: async ({ payTo, amount, resource }) => {
    gwCalls.push({ payTo, amount });
    return { header: Buffer.from(JSON.stringify({ payTo, amount: amount.toString(), resource })).toString("base64"), body: { x402Version: 2, accepts: [{ payTo }] }, requirements: { payTo } };
  },
  settle: async () => settleResult,
};

beforeEach(async () => {
  chain = new Map();
  store = new BoardStore(join(mkdtempSync(join(tmpdir(), "x402-")), "b.db"));
  gwCalls = [];
  payouts = [];
  deposits = [];
  settleResult = { ok: true, tx: "ee".repeat(32), responseHeader: "settled", payer: poster.address };
  service = new BoardService({
    config: { contract: { index: 1n, subindex: 0n }, rewardTokenId: "EUDemo", tokenDecimals: 6, escrowAccount: ESCROW, sponsorAddress: "s", faucetUrl: null, badgeApi: "x" },
    store,
    chain: { view: async (id) => chain.get(id) ?? null, entry: async () => null, stats: async () => ({}) as never, all: async () => [...chain.values()] },
    isOnAllowList: async () => true,
    accounts: lookupOf(poster, worker, other),
    idpName: () => "Concordium testnet IP",
    agentWallet: async () => null,
    fetch,
    sponsor: { prepare: async () => ({}) as never },
    attestor: new Attestor("09".repeat(32), () => BigInt(NOW)),
    txSponsor: () => null,
    relay: async () => ({ txHash: "", summary: {} }),
    outcome: async () => ({ summary: {} }),
    eventsOf: () => [],
    noteTransfer: async () => {},
    now: () => NOW,
  });
  store.putSubmission({ workHash: WORK_HASH, bountyId: 0n, worker: worker.address, preview: "Example", full: FULL });
  const app = createApp({
    service,
    extraRouters: [
      x402Router(service, gateway, {
        publicBaseUrl: "https://board.example",
        recordPayout: async (id, p) => {
          payouts.push([id, p]);
          return "dd".repeat(32);
        },
        noteDeposit: async (tx) => {
          deposits.push(tx);
          return { confirmed: true };
        },
      }),
    ],
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterEach(() => close());

async function tokenFor(acct: ReturnType<typeof testAccount>) {
  const ch = service.challenge({ account: acct.address });
  return (await service.login({ account: acct.address, nonce: ch.nonce, signature: await acct.sign(ch.message) })).token;
}

async function get(path: string, token: string, payment?: string) {
  const res = await fetch(base + path, { headers: { authorization: `Bearer ${token}`, ...(payment ? { "payment-signature": payment } : {}) } });
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

const accepted: BountyStatus = { type: "Accepted", worker: worker.address, at: BigInt(NOW), workHash: WORK_HASH };

describe("pay on delivery", () => {
  it("work_409_before_accept", async () => {
    chain.set(0n, bounty(0n, { type: "Submitted", worker: worker.address, agent: null, workHash: WORK_HASH, at: 1n }));
    expect((await get("/bounties/0/work", await tokenFor(poster))).status).toBe(409);
  });

  it("only the poster can fetch the work", async () => {
    chain.set(0n, bounty(0n, accepted));
    expect((await get("/bounties/0/work", await tokenFor(other))).status).toBe(403);
  });

  it("work_requires_payment_when_not_funded and work_402_payTo_is_worker_not_board", async () => {
    chain.set(0n, bounty(0n, accepted));
    const r = await get("/bounties/0/work", await tokenFor(poster));
    expect(r.status).toBe(402);
    expect(r.headers.get("payment-required")).toBeTruthy();
    expect(gwCalls).toEqual([{ payTo: worker.address, amount: 3_000_000n }]);
    expect(JSON.stringify(r.body)).not.toContain(FULL);
  });

  it("paid_work_hash_matches_onchain: payment settles, the payout is recorded and the full work is released", async () => {
    chain.set(0n, bounty(0n, accepted));
    const r = await get("/bounties/0/work", await tokenFor(poster), "signed-payment");
    expect(r.status).toBe(200);
    expect(r.headers.get("payment-response")).toBe("settled");
    expect(payouts).toEqual([[0n, [{ to: worker.address, amount: 3_000_000n, tx: "ee".repeat(32) }]]]);
    expect(r.body.items).toEqual([{ workHash: WORK_HASH, worker: worker.address, full: FULL, hashMatches: true }]);
    expect(r.body.payment).toMatchObject({ tx: "ee".repeat(32), link: expect.stringContaining("ee".repeat(32)) });
  });

  it("settlement_failure_does_not_record_payout", async () => {
    chain.set(0n, bounty(0n, accepted));
    settleResult = { ok: false, error: "insufficient balance" };
    const r = await get("/bounties/0/work", await tokenFor(poster), "signed-payment");
    expect(r.status).toBe(402);
    expect(r.body.error).toMatch(/insufficient/);
    expect(payouts).toEqual([]);
  });

  it("releases escrowed work after acceptance without asking for payment", async () => {
    chain.set(0n, bounty(0n, accepted, { type: "Escrowed", fundingTx: "11".repeat(32) }));
    const r = await get("/bounties/0/work", await tokenFor(poster));
    expect(r.status).toBe(200);
    expect(r.body.items[0].full).toBe(FULL);
    expect(gwCalls).toEqual([]);
  });

  it("refuses to serve work whose hash does not match the chain", async () => {
    chain.set(0n, bounty(0n, { ...accepted, workHash: "00".repeat(32) } as BountyStatus, { type: "Escrowed", fundingTx: "11".repeat(32) }));
    store.putSubmission({ workHash: "00".repeat(32), bountyId: 0n, worker: worker.address, preview: "x", full: "tampered" });
    expect((await get("/bounties/0/work", await tokenFor(poster))).status).toBe(500);
  });
});

describe("escrow funding over x402", () => {
  async function post(path: string, token: string, payment?: string) {
    const res = await fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${token}`, ...(payment ? { "payment-signature": payment } : {}) } });
    return { status: res.status, body: (await res.json()) as any };
  }

  it("fund_402_payTo_is_escrow", async () => {
    chain.set(0n, bounty(0n, { type: "Open" }));
    const r = await post("/bounties/0/fund", await tokenFor(poster));
    expect(r.status).toBe(402);
    expect(gwCalls).toEqual([{ payTo: ESCROW, amount: 3_000_000n }]);
  });

  it("confirms the deposit after settlement", async () => {
    chain.set(0n, bounty(0n, { type: "Open" }));
    const r = await post("/bounties/0/fund", await tokenFor(poster), "signed-payment");
    expect(r.status).toBe(200);
    expect(deposits).toEqual(["ee".repeat(32)]);
    expect(r.body.funded).toEqual({ confirmed: true });
  });

  it("refuses to fund an escrowed or accepted bounty", async () => {
    chain.set(0n, bounty(0n, { type: "Open" }, { type: "Escrowed", fundingTx: "11".repeat(32) }));
    chain.set(1n, bounty(1n, accepted));
    const t = await tokenFor(poster);
    expect((await post("/bounties/0/fund", t)).status).toBe(409);
    expect((await post("/bounties/1/fund", t)).status).toBe(409);
  });
});
