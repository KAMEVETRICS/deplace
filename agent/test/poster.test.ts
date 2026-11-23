import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AccountAddress,
  CcdAmount,
  ContractAddress,
  Energy,
  Parameter,
  ReceiveName,
  SequenceNumber,
  Transaction,
  TransactionExpiry,
  buildBasicAccountSigner,
} from "@concordium/web-sdk";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { Bounty } from "@deplace/shared";
import { BoardToolError } from "../src/board-client.js";
import type { ChainReads } from "../src/chain.js";
import { postAndPay } from "../src/poster.js";
import { SpendBudget } from "../src/rails/budget.js";
import { RailViolation } from "../src/rails/guard.js";
import type { AgentKeys } from "../src/signer.js";
import type { Board } from "../src/worker.js";

const addr = (fill: number) => AccountAddress.fromBuffer(new Uint8Array(32).fill(fill).buffer).address;
function keys(fill: number): AgentKeys {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyHex = privateKey.export({ format: "der", type: "pkcs8" }).subarray(16).toString("hex");
  return { address: addr(fill), privateKeyHex, signer: buildBasicAccountSigner(privateKeyHex) };
}
const me = keys(1);
const WORKER = addr(7);
const ESCROW = addr(4);
const ATTACKER = addr(6);
const DEPLACE = { index: 13001n, subindex: 0n };
const NETWORK = "ccd:4221332d34e1694168c2a0c0b3fd0f27";
const REWARD = 1_000_000n; // "1" with 6 decimals

/** A sponsored Deplace contract call for the agent, as the board's prepare_* tools return. */
function prepared(entrypoint: string) {
  const tx = Transaction.updateContract(
    { amount: CcdAmount.zero(), address: ContractAddress.create(DEPLACE.index, DEPLACE.subindex), receiveName: ReceiveName.fromString(`deplace.${entrypoint}`), message: Parameter.fromHexString("00") },
    Energy.create(30_000n),
  )
    .addMetadata({ sender: AccountAddress.fromBase58(me.address), nonce: SequenceNumber.create(1), expiry: TransactionExpiry.futureMinutes(5) })
    .addSponsor(AccountAddress.fromBase58(addr(3)))
    .build();
  return { prepared: { txJson: Transaction.toJSONString(tx), feeSponsored: true } };
}

interface Scenario {
  /** Who the board's x402 terms name as payee (default: the honest one). */
  payTo?: string;
  /** What the board relays as the post's outcome. */
  postEntrypoint?: string;
  /** The reward the contract records for the posted bounty. */
  chainReward?: bigint;
  /** A board that asks to be paid on delivery although the reward was escrowed. */
  askDeliveryAfterEscrow?: boolean;
  /** Errors get_status throws, one per call, before it answers. */
  statusFailures?: Error[];
}

function world(s: Scenario = {}) {
  const calls: string[] = [];
  const signatures: string[] = [];
  let accepted = false;
  let escrowed = false;

  const chain: ChainReads = {
    async bounty(id) {
      const b: Bounty = {
        id,
        poster: me.address,
        posterAgent: null,
        kind: "Exclusive",
        specHash: "00".repeat(32),
        reward: s.chainReward ?? REWARD,
        funding: escrowed ? { type: "Escrowed", fundingTx: "bb".repeat(32) } : { type: "NotFunded" },
        deadline: 0n,
        status: accepted ? { type: "Accepted", worker: WORKER, at: 0n, workHash: "00".repeat(32) } : { type: "Open" },
        rejections: 0,
        lastRejectedAt: null,
        entryCount: 0,
        created: 0n,
      };
      return b;
    },
    async payee(b) {
      return b.status.type === "Accepted" ? b.status.worker : null;
    },
    async escrowAccount() {
      return ESCROW;
    },
  };

  const board: Board = {
    async call(name: string, args: Record<string, unknown>): Promise<any> {
      calls.push(name);
      switch (name) {
        case "request_challenge":
          return { nonce: "n1", message: "Deplace/v1/login:n1" };
        case "login":
          return { token: "tok" };
        case "prepare_post":
          return prepared(s.postEntrypoint ?? "post");
        case "submit_signed":
          return { txHash: "aa".repeat(32), link: "https://ccdexplorer.io/testnet/transaction/aa", events: [{ type: "Posted", id: "9" }] };
        case "prepare_fund":
          return { x402: { method: "POST", url: "http://board.test/bounties/9/fund" }, fallback: { prepared: { txJson: "{}" } } };
        case "get_status": {
          const failure = s.statusFailures?.shift();
          if (failure) throw failure;
          return { status: { type: "Submitted" } };
        }
        case "prepare_accept":
          accepted = true;
          return prepared("accept");
        case "fetch_work":
          if (escrowed && !s.askDeliveryAfterEscrow) return { paymentRequired: false, items: [{ preview: "p" }] };
          return { paymentRequired: true, url: "http://board.test/bounties/9/work", payTo: s.payTo ?? WORKER, amount: REWARD.toString() };
        default:
          throw new Error(`unexpected tool ${name} ${JSON.stringify(args)}`);
      }
    },
  };

  /** The board's x402 endpoints: terms first, then the paid response. */
  const fetchStub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const funding = req.url.endsWith("/fund");
    const signature = req.headers.get("PAYMENT-SIGNATURE");
    if (!signature) {
      const terms = {
        x402Version: 2,
        resource: { url: req.url, description: "x", mimeType: "application/json" },
        accepts: [{ scheme: "exact", network: NETWORK, asset: "EUDemo", amount: REWARD.toString(), payTo: s.payTo ?? (funding ? ESCROW : WORKER), maxTimeoutSeconds: 300, extra: {} }],
      };
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(terms as never) } });
    }
    signatures.push(req.url);
    if (funding) escrowed = true;
    const body = funding ? { funded: { confirmed: true }, payment: { link: "fund-link" } } : { items: [{ full: "work" }], payment: { link: "pay-link" } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };

  const budget = new SpendBudget(join(mkdtempSync(join(tmpdir(), "poster-")), "budget.json"), { maxPerBounty: 5_000_000n, dailyCap: 20_000_000n });
  const log: string[] = [];
  const opts = (over: { reward?: string; escrow?: boolean } = {}) => ({
    board,
    badge: "JyP9Badge",
    keys: me,
    chain,
    guard: { account: me.address, contract: DEPLACE, allowFees: false },
    budget,
    token: { id: "EUDemo", decimals: 6 },
    log: (m: string) => log.push(m),
    pollMs: 0,
    fetch: fetchStub as typeof fetch,
    scheme: { scheme: "exact", createPaymentPayload: async (v: number) => ({ x402Version: v, payload: { signed: true } }) } as never,
    ...over,
  });
  return { calls, signatures, budget, log, opts };
}

describe("poster agent rails", () => {
  it("pays the worker the contract names, the committed reward, once", async () => {
    const w = world();
    await postAndPay(w.opts());
    expect(w.signatures).toEqual(["http://board.test/bounties/9/work"]);
    expect(() => w.budget.reserve("bounty:9", 1n)).toThrow(/already paid/);
  });

  it("stops before posting when the reward is over its per-bounty cap", async () => {
    const w = world();
    await expect(postAndPay(w.opts({ reward: "6" }))).rejects.toBeInstanceOf(RailViolation);
    expect(w.calls).not.toContain("prepare_post");
  });

  it("refuses to pay when the board's terms name someone other than the worker on chain", async () => {
    const w = world({ payTo: ATTACKER });
    await expect(postAndPay(w.opts())).rejects.toThrow();
    expect(w.signatures).toEqual([]);
    expect(() => w.budget.reserve("bounty:9", REWARD)).not.toThrow(); // nothing was booked
  });

  it("refuses to sign a post that is some other contract action", async () => {
    const w = world({ postEntrypoint: "cancel" });
    await expect(postAndPay(w.opts())).rejects.toBeInstanceOf(RailViolation);
    expect(w.calls).not.toContain("submit_signed");
  });

  it("stops when the bounty on chain does not carry the reward it asked for", async () => {
    const w = world({ chainReward: 4_000_000n });
    await expect(postAndPay(w.opts())).rejects.toThrow(/reward/);
    expect(w.calls).not.toContain("prepare_accept");
  });

  it("escrows the reward to the escrow account on chain, and is then not paid out a second time", async () => {
    const w = world();
    await postAndPay(w.opts({ escrow: true }));
    expect(w.signatures).toEqual(["http://board.test/bounties/9/fund"]);
  });

  it("will not also pay on delivery for a reward it already escrowed", async () => {
    const w = world({ askDeliveryAfterEscrow: true });
    await expect(postAndPay(w.opts({ escrow: true }))).rejects.toThrow(/already paid/);
    expect(w.signatures).toEqual(["http://board.test/bounties/9/fund"]);
  });

  it("keeps waiting for a submission when a status read fails for a moment", async () => {
    const blip = new BoardToolError("get_status", JSON.stringify({ error: "the board lost its network connection (read ECONNRESET), retry later", retryable: true }));
    const w = world({ statusFailures: [blip] });
    await postAndPay(w.opts());
    expect(w.calls.filter((c) => c === "get_status")).toHaveLength(2);
    expect(w.signatures).toEqual(["http://board.test/bounties/9/work"]);
  });

  it("stops waiting for a submission when a status read fails in a way retrying will not fix", async () => {
    const w = world({ statusFailures: [new BoardToolError("get_status", "MCP error -32603: boom")] });
    await expect(postAndPay(w.opts())).rejects.toThrow(/boom/);
    expect(w.calls).not.toContain("prepare_accept");
  });
});
