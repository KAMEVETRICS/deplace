// A scripted Deplace world for the kit's tests, with no network: the board's MCP tools and HTTP
// routes (x402 included), the chain the kit reads, and an x402 scheme that signs like the real one.
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { CborAccountAddress, TokenAmount, TokenId, createTokenUpdatePayload } from "@concordium/web-sdk/plt";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { encodeClaim, encodeEnter, encodeIdEntry, encodeIdHash, encodePost, encodeU64, parseTokenAmount, txLink, type BoardEvent, type Bounty, type BountyKind, type BountyStatus, type Funding } from "@deplace/shared";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { BoardToolError } from "../../src/board-client.js";
import type { KitChain, TxOutcome } from "../../src/chain.js";
import { BoardLink } from "../../src/kit/board-link.js";
import { hireTools } from "../../src/kit/hire-tools.js";
import { Relay } from "../../src/kit/relay.js";
import { buildKitServer } from "../../src/kit/server.js";
import { workTools, type KitDeps } from "../../src/kit/work-tools.js";
import { SpendBudget } from "../../src/rails/budget.js";
import { reasonHash } from "../../src/rails/guard.js";
import { AccountLock } from "../../src/rails/lock.js";
import { PendingStore } from "../../src/rails/pending.js";
import { transactionHash, type AgentKeys } from "../../src/signer.js";
import type { Board } from "../../src/worker.js";

export const addr = (fill: number) => AccountAddress.fromBuffer(new Uint8Array(32).fill(fill).buffer).address;
export function testKeys(fill: number): AgentKeys {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyHex = privateKey.export({ format: "der", type: "pkcs8" }).subarray(16).toString("hex");
  return { address: addr(fill), privateKeyHex, signer: buildBasicAccountSigner(privateKeyHex) };
}

export const me = testKeys(1);
export const POSTER = addr(2);
export const SPONSOR = addr(3);
export const ESCROW = addr(4);
export const ATTACKER = addr(6);
export const WORKER = addr(7);
export const DEPLACE = { index: 13001n, subindex: 0n };
export const BADGE = "JyP9WVTtVnRuL8JUmLKZH"; // token 1418 of the registry <12802,0>
export const ORIGIN = "http://board.test";
export const FAUCET = "https://allowlist.testnet.concordium.com";
const NETWORK = "ccd:4221332d34e1694168c2a0c0b3fd0f27";
/** The board's attestation signature in claims, entries and posts: the kit never compares it. */
const SIG = "11".repeat(64);
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
const board403 = (tool: string, error: string) => new BoardToolError(tool, JSON.stringify({ error }));

/** A sponsored Deplace call from the agent, as a prepare_* tool returns it: honest by default, bent by `o`. */
export function preparedCall(
  entrypoint: string,
  parameter: Uint8Array,
  o: { contract?: { index: bigint; subindex: bigint }; entrypoint?: string; sender?: string; ccd?: bigint; sponsored?: boolean; tokenTransfer?: boolean } = {},
) {
  const meta = { sender: AccountAddress.fromBase58(o.sender ?? me.address), nonce: SequenceNumber.create(1), expiry: TransactionExpiry.futureMinutes(5) };
  if (o.tokenTransfer) {
    const tx = Transaction.tokenUpdate(
      createTokenUpdatePayload(TokenId.fromString("EUDemo"), {
        transfer: { amount: TokenAmount.create(5_000_000n, 6), recipient: CborAccountAddress.fromAccountAddress(AccountAddress.fromBase58(ATTACKER)) },
      }),
    )
      .addMetadata(meta)
      .addSponsor(AccountAddress.fromBase58(SPONSOR))
      .build();
    return { prepared: { txJson: Transaction.toJSONString(tx), feeSponsored: true } };
  }
  const c = o.contract ?? DEPLACE;
  const tx = Transaction.updateContract(
    {
      amount: CcdAmount.fromMicroCcd(o.ccd ?? 0n),
      address: ContractAddress.create(c.index, c.subindex),
      receiveName: ReceiveName.fromString(`deplace.${o.entrypoint ?? entrypoint}`),
      message: Parameter.fromBuffer(parameter.slice().buffer),
    },
    Energy.create(30_000n),
  ).addMetadata(meta);
  const built = o.sponsored === false ? tx.build() : tx.addSponsor(AccountAddress.fromBase58(SPONSOR)).build();
  return { prepared: { txJson: Transaction.toJSONString(built), feeSponsored: o.sponsored !== false } };
}

/** What the real x402 scheme puts in a payment: a sponsored EUDemo transfer from the agent, signed by it. */
async function signedTransfer(payTo: string, amount: bigint, nonce: bigint, expirySeconds: number) {
  const tx = Transaction.tokenUpdate(
    createTokenUpdatePayload(TokenId.fromString("EUDemo"), {
      transfer: { amount: TokenAmount.create(amount, 6), recipient: CborAccountAddress.fromAccountAddress(AccountAddress.fromBase58(payTo)) },
    }),
  )
    .addMetadata({ sender: AccountAddress.fromBase58(me.address), nonce: SequenceNumber.create(nonce), expiry: TransactionExpiry.fromEpochSeconds(expirySeconds) })
    .addSponsor(AccountAddress.fromBase58(SPONSOR))
    .build();
  return JSON.parse(Transaction.toJSONString(await Transaction.sign(tx, me.signer)));
}

export interface ScriptedBounty {
  id: bigint;
  kind: BountyKind;
  poster: string;
  posterAgent: bigint | null;
  reward: bigint;
  deadline: bigint;
  status: BountyStatus;
  funding: Funding;
  specHash: string;
  spec: Record<string, unknown> | null;
  rejections: number;
  entries: { worker: string; agent: bigint | null; workHash: string }[];
  events: (BoardEvent & { tx: string })[];
  /** The accepted or awarded work, which the board still releases once the bounty is Paid. */
  acceptedWork?: { workHash: string; worker: string };
}

export interface WorldOptions {
  /** Errors a tool throws, one per call, before it answers. */
  fail?: Record<string, Error[]>;
  /** A compromised board's answer for a tool. */
  replace?: Record<string, (args: any) => unknown>;
  /** submit_signed applies the transaction, then the answer is lost (this many times). */
  loseRelay?: number;
  /** submit_signed never reaches the board (this many times). */
  dropRelay?: number;
  /** Whom the board's x402 terms name, instead of the honest payee. */
  x402PayTo?: string;
  /** Paid x402 requests that never reach the board (this many times). */
  loseX402?: number;
  eligible?: boolean;
  contract?: { index: string; subindex: string };
  /** Entrypoints the contract rejects: the transaction lands as failed and the board still answers normally, with no events. */
  rejectOnChain?: string[];
}

export type World = ReturnType<typeof world>;

export function world(o: WorldOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kit-"));
  let t = Date.now();
  const clock = { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => void (t += ms) };
  const deadline = BigInt(t + 2 * 3_600_000);
  const specs = new Map<string, string>();
  const submissions = new Map<string, { preview: string; full: string }>();
  const txs = new Map<string, TxOutcome>();
  const state = {
    bounties: new Map<string, ScriptedBounty>(),
    names: { [POSTER]: "@alice" } as Record<string, string>,
    calls: [] as { name: string; args: any }[],
    requests: [] as { method: string; url: string }[],
    relayed: [] as string[],
    paid: [] as string[],
    /** The agent account's next nonce as of the last finalized block. */
    nonce: 7n,
    nextId: 9n,
    loseRelay: o.loseRelay ?? 0,
    dropRelay: o.dropRelay ?? 0,
    loseX402: o.loseX402 ?? 0,
  };

  /** A bounty as the board would have it, its spec stored under its hash. */
  function add(b: { id: bigint; kind: BountyKind; poster: string; taskKind: string; input: Record<string, unknown>; reward?: string; funding?: Funding; title?: string }) {
    const reward = b.reward ?? "1";
    const spec = {
      title: b.title ?? `Task ${b.id}`,
      description: `Do task ${b.id}.`,
      taskKind: b.taskKind,
      input: b.input,
      kind: b.kind,
      reward,
      rewardToken: "EUDemo",
      deadline: Number(deadline),
      poster: b.poster,
      posterAgent: null,
    };
    const json = JSON.stringify(spec);
    specs.set(sha(json), json);
    state.bounties.set(b.id.toString(), {
      id: b.id,
      kind: b.kind,
      poster: b.poster,
      posterAgent: null,
      reward: parseTokenAmount(reward, 6),
      deadline,
      status: { type: "Open" },
      funding: b.funding ?? { type: "Escrowed", fundingTx: "bb".repeat(32) },
      specHash: sha(json),
      spec,
      rejections: 0,
      entries: [],
      events: [],
    });
  }
  add({ id: 3n, kind: "Exclusive", poster: me.address, taskKind: "page-facts", input: { url: "https://example.org" } }); // its own: never offered
  add({ id: 4n, kind: "Exclusive", poster: POSTER, taskKind: "translate", input: { text: "hej" } });
  add({ id: 5n, kind: "Exclusive", poster: POSTER, taskKind: "page-facts", input: { url: "https://example.org" }, title: "Page facts for example.org" });

  const bountyOf = (tool: string, id: unknown) => {
    const b = state.bounties.get(String(id));
    if (!b) throw new BoardToolError(tool, JSON.stringify({ error: `no bounty ${id}` }));
    return b;
  };
  const event = (b: ScriptedBounty, e: BoardEvent, tx: string) => {
    b.events.push({ ...e, tx });
    return e;
  };
  const payeeOf = (b: ScriptedBounty) => (b.status.type === "Accepted" || b.status.type === "AcceptedUnpaid" ? b.status.worker : b.status.type === "Awarded" ? b.entries[b.status.entryId]!.worker : null);
  const itemsOf = (b: ScriptedBounty) => {
    const work = b.acceptedWork;
    const sub = work ? submissions.get(work.workHash) : undefined;
    return work && sub ? [{ workHash: work.workHash, worker: work.worker, full: sub.full, hashMatches: true }] : [];
  };

  /** What the contract does with a transaction the agent signed. */
  function apply(txJson: string): { type: string; id?: string }[] {
    const tx = Transaction.signableFromJSON(JSON.parse(txJson));
    const p = tx.payload as { receiveName?: ReceiveName.Type; message?: Parameter.Type };
    if (!p.receiveName || !p.message) throw new BoardToolError("submit_signed", JSON.stringify({ error: "not a Deplace call" }));
    const entrypoint = p.receiveName.value.split(".")[1]!;
    const param = Buffer.from(Parameter.toBuffer(p.message));
    const sender = tx.header.sender.address;
    const hash = transactionHash(txJson);
    const now = BigInt(t);
    const out: BoardEvent[] = [];
    /** The contract refuses: the transaction is final but failed, and the real board answers it like any other, with no events. */
    const rejected = () => {
      state.relayed.push(txJson);
      txs.set(hash, { state: "finalized", failed: true, events: [] });
      return [];
    };
    if (o.rejectOnChain?.includes(entrypoint)) return rejected();
    if (entrypoint === "post") {
      let at = 0;
      const kind: BountyKind = param[at++] === 0 ? "Exclusive" : "Contest";
      const posterAgent = param[at++] === 1 ? param.readBigUInt64LE((at += 8) - 8) : null;
      const specHash = param.subarray(at, (at += 32)).toString("hex");
      const reward = param.readBigUInt64LE((at += 8) - 8);
      const dl = param.readBigUInt64LE((at += 8) - 8);
      const id = state.nextId++;
      const specJson = specs.get(specHash);
      state.bounties.set(id.toString(), {
        id,
        kind,
        poster: sender,
        posterAgent,
        reward,
        deadline: dl,
        status: { type: "Open" },
        funding: { type: "NotFunded" },
        specHash,
        spec: specJson ? JSON.parse(specJson) : null,
        rejections: 0,
        entries: [],
        events: [],
      });
      out.push(event(state.bounties.get(id.toString())!, { type: "Posted", id, poster: sender, posterAgent, kind, reward, specHash, deadline: dl }, hash));
    } else {
      const id = param.readBigUInt64LE(0);
      const b = bountyOf("submit_signed", id);
      if (entrypoint === "claim") {
        b.status = { type: "Claimed", worker: sender, agent: 1418n };
        out.push(event(b, { type: "Claimed", id, worker: sender, agent: 1418n }, hash));
      } else if (entrypoint === "submit") {
        const workHash = param.subarray(8, 40).toString("hex");
        b.status = { type: "Submitted", worker: sender, agent: 1418n, workHash, at: now };
        out.push(event(b, { type: "Submitted", id, worker: sender, workHash }, hash));
      } else if (entrypoint === "enter") {
        const at = param[8] === 1 ? 17 : 9;
        const workHash = param.subarray(at, at + 32).toString("hex");
        b.entries.push({ worker: sender, agent: 1418n, workHash });
        out.push(event(b, { type: "Entered", id, entryId: b.entries.length - 1, worker: sender, agent: 1418n, workHash }, hash));
      } else if (entrypoint === "accept") {
        if (b.status.type !== "Submitted") return rejected();
        b.status = { type: "Accepted", worker: b.status.worker, at: now, workHash: b.status.workHash };
        b.acceptedWork = { workHash: b.status.workHash, worker: b.status.worker };
        out.push(event(b, { type: "Accepted", id, worker: b.status.worker, auto: false }, hash));
      } else if (entrypoint === "reject") {
        if (b.status.type !== "Submitted") return rejected();
        const rh = param.subarray(8, 40).toString("hex");
        b.rejections++;
        b.status = { type: "Claimed", worker: b.status.worker, agent: b.status.agent };
        out.push(event(b, { type: "Rejected", id, count: b.rejections, reasonHash: rh }, hash));
      } else if (entrypoint === "award") {
        const entryId = param.readUInt32LE(8);
        b.status = { type: "Awarded", entryId, at: now };
        b.acceptedWork = { workHash: b.entries[entryId]!.workHash, worker: b.entries[entryId]!.worker };
        out.push(event(b, { type: "Awarded", id, entryId, worker: b.entries[entryId]!.worker }, hash));
      } else if (entrypoint === "cancel") {
        b.status = { type: "Cancelled" };
        out.push(event(b, { type: "Cancelled", id }, hash));
      } else {
        throw new BoardToolError("submit_signed", JSON.stringify({ error: `unknown action ${entrypoint}` }));
      }
    }
    state.relayed.push(txJson);
    txs.set(hash, { state: "finalized", failed: false, events: out });
    return out.map((e) => ({ type: e.type, ...("id" in e ? { id: e.id.toString() } : {}) }));
  }

  const session = (tool: string, args: any) => {
    if (args.session !== "tok") throw board403(tool, "log in first (POST /auth/challenge, then /auth/login)");
  };

  const tools: Record<string, (args: any) => unknown> = {
    request_challenge: () => ({ nonce: "n1", message: "Deplace/v1/login:n1" }),
    login: () => ({ token: "tok", identity: { kind: "agent", account: me.address, tokenId: "1418", badge: BADGE, label: "Agent #1418" } }),
    check_payout_eligibility: () => ((o.eligible ?? true) ? { ok: true } : { ok: false, reason: "not on the EUDemo allow list", faucetUrl: FAUCET }),
    get_status: (a) => {
      const b = bountyOf("get_status", a.bounty_id);
      return { id: b.id, status: b.status, funding: b.funding, reward: b.reward, kind: b.kind };
    },
    get_bounty: (a) => {
      const b = bountyOf("get_bounty", a.bounty_id);
      const preview = (h: string) => submissions.get(h)?.preview ?? null;
      return {
        names: state.names,
        bounty: { ...b, spec: undefined, events: undefined, entries: undefined, entryCount: b.entries.length },
        spec: b.spec,
        submission: b.status.type === "Submitted" ? { workHash: b.status.workHash, preview: preview(b.status.workHash) } : null,
        entries: b.entries.map((e, i) => ({ ...e, entryId: i, preview: preview(e.workHash) })),
        events: b.events.map((e) => ({ ...e, link: txLink(e.tx) })),
        posterProfile: { account: b.poster },
        links: {},
      };
    },
    prepare_claim: (a) => {
      session("prepare_claim", a);
      const b = bountyOf("prepare_claim", a.bounty_id);
      if (b.kind !== "Exclusive") throw board403("prepare_claim", "contests have no claims: submit an entry instead");
      if (b.status.type !== "Open") throw board403("prepare_claim", `bounty ${b.id} is ${b.status.type}, not Open`);
      return preparedCall("claim", encodeClaim({ id: b.id, agent: 1418n, attestationExpiry: 1n, signature: SIG }));
    },
    prepare_submit: (a) => {
      session("prepare_submit", a);
      const b = bountyOf("prepare_submit", a.bounty_id);
      const workHash = sha(a.full);
      submissions.set(workHash, { preview: a.preview, full: a.full });
      if (b.kind === "Exclusive") {
        if (b.status.type !== "Claimed" || b.status.worker !== me.address) throw board403("prepare_submit", `bounty ${b.id} is ${b.status.type}, not Claimed by you`);
        return preparedCall("submit", encodeIdHash(b.id, workHash));
      }
      return preparedCall("enter", encodeEnter({ id: b.id, agent: 1418n, workHash, attestationExpiry: 1n, signature: SIG }));
    },
    prepare_post: (a) => {
      session("prepare_post", a);
      const json = JSON.stringify({
        title: a.title.trim(),
        description: a.description,
        taskKind: a.task_kind,
        input: a.input,
        kind: a.kind,
        reward: a.reward,
        rewardToken: "EUDemo",
        deadline: a.deadline,
        poster: me.address,
        posterAgent: "1418",
      });
      specs.set(sha(json), json);
      return preparedCall(
        "post",
        encodePost({ kind: a.kind, posterAgent: 1418n, specHash: sha(json), reward: parseTokenAmount(a.reward, 6), deadline: BigInt(a.deadline), attestationExpiry: 1n, signature: SIG }),
      );
    },
    prepare_fund: (a) => {
      session("prepare_fund", a);
      const b = bountyOf("prepare_fund", a.bounty_id);
      return { x402: { method: "POST", url: `${ORIGIN}/bounties/${b.id}/fund` }, fallback: { prepared: { txJson: "{}" } } };
    },
    prepare_accept: (a) => (session("prepare_accept", a), preparedCall("accept", encodeU64(bountyOf("prepare_accept", a.bounty_id).id))),
    prepare_cancel: (a) => (session("prepare_cancel", a), preparedCall("cancel", encodeU64(bountyOf("prepare_cancel", a.bounty_id).id))),
    prepare_reject: (a) => {
      session("prepare_reject", a);
      const b = bountyOf("prepare_reject", a.bounty_id);
      const reason = String(a.reason).slice(0, 2000);
      specs.set(reasonHash(reason), JSON.stringify({ reason }));
      return preparedCall("reject", encodeIdHash(b.id, reasonHash(reason)));
    },
    prepare_award: (a) => (session("prepare_award", a), preparedCall("award", encodeIdEntry(bountyOf("prepare_award", a.bounty_id).id, a.entry_id))),
    submit_signed: (a) => {
      if (state.dropRelay > 0) {
        state.dropRelay--;
        throw new TypeError("fetch failed");
      }
      const events = apply(a.tx_json);
      if (state.loseRelay > 0) {
        state.loseRelay--;
        throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      }
      const hash = transactionHash(a.tx_json);
      return { txHash: hash, link: txLink(hash), events };
    },
    fetch_work: (a) => {
      session("fetch_work", a);
      const b = bountyOf("fetch_work", a.bounty_id);
      if (b.poster !== me.address) throw board403("fetch_work", "only the bounty's poster can fetch the work");
      if (b.funding.type === "NotFunded" && b.status.type !== "Paid") {
        return { paymentRequired: true, url: `${ORIGIN}/bounties/${b.id}/work`, payTo: payeeOf(b), amount: b.reward, token: "EUDemo" };
      }
      return { paymentRequired: false, items: itemsOf(b) };
    },
  };

  const connection: Board & { close(): Promise<void> } = {
    async call(name: string, args: Record<string, any>): Promise<any> {
      state.calls.push({ name, args });
      const failure = o.fail?.[name]?.shift();
      if (failure) throw failure;
      const answer = o.replace?.[name] ?? tools[name];
      if (!answer) throw new Error(`unexpected tool ${name}`);
      return wire(answer(args)); // as the board's JSON over MCP: bigints become strings
    },
    async close() {},
  };

  const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(wire(v)), { status, headers: { "content-type": "application/json", ...headers } });

  /** The board's HTTP routes, x402 included. */
  async function http(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const req = new Request(input, init);
    const url = new URL(req.url);
    state.requests.push({ method: req.method, url: req.url });
    if (url.origin !== ORIGIN) throw new TypeError("fetch failed"); // nothing else exists in this world
    if (url.pathname === "/config") {
      return json({ rewardToken: "EUDemo", decimals: 6, contract: o.contract ?? { index: "13001", subindex: "0" }, escrowAccount: ESCROW, sponsorAccount: SPONSOR, faucetUrl: FAUCET });
    }
    if (url.pathname === "/bounties") {
      const status = url.searchParams.get("status");
      const kind = url.searchParams.get("kind");
      const list = [...state.bounties.values()]
        .filter((b) => (!status || b.status.type === status) && (!kind || b.kind === kind))
        .sort((a, b) => Number(b.id - a.id))
        .map((b) => ({ ...b, events: undefined, entries: undefined }));
      return json({ bounties: list, names: state.names });
    }
    const spec = /^\/specs\/([0-9a-f]{64})$/.exec(url.pathname);
    if (spec) {
      const text = specs.get(spec[1]!);
      return text ? new Response(text, { status: 200, headers: { "content-type": "application/json" } }) : json({ error: "no such spec" }, 404);
    }
    const paid = /^\/bounties\/(\d+)\/(fund|work)$/.exec(url.pathname);
    if (paid) {
      const b = bountyOf("x402", paid[1]);
      const purpose = paid[2] as "fund" | "work";
      if (purpose === "work" && (b.funding.type !== "NotFunded" || b.status.type === "Paid")) return json({ bountyId: b.id, items: itemsOf(b) });
      if (purpose === "fund" && b.funding.type !== "NotFunded") return json({ error: `bounty ${b.id} is already escrowed` }, 409);
      const payTo = o.x402PayTo ?? (purpose === "fund" ? ESCROW : payeeOf(b));
      if (!payTo) return json({ error: `nothing is owed for bounty ${b.id}` }, 409);
      const terms = {
        x402Version: 2,
        resource: { url: req.url, description: "x", mimeType: "application/json" },
        accepts: [{ scheme: "exact", network: NETWORK, asset: "EUDemo", amount: b.reward.toString(), payTo, maxTimeoutSeconds: 300, extra: { feePayer: SPONSOR } }],
      };
      if (!req.headers.get("PAYMENT-SIGNATURE")) return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(terms as never) } });
      if (state.loseX402 > 0) {
        state.loseX402--;
        throw new TypeError("fetch failed"); // the paid request never reaches the board
      }
      state.paid.push(req.url);
      state.nonce++; // the payment used the account's nonce
      const payment = { tx: "cc".repeat(32), link: txLink("cc".repeat(32)) };
      if (purpose === "fund") {
        b.funding = { type: "Escrowed", fundingTx: "cc".repeat(32) };
        return json({ bountyId: b.id, funded: { confirmed: true }, payment });
      }
      const items = itemsOf(b);
      b.status = { type: "Paid" };
      return json({ bountyId: b.id, items, payment });
    }
    return json({ error: `no route ${req.method} ${url.pathname}` }, 404);
  }

  const chain: KitChain = {
    async bounty(id) {
      const b = bountyOf("chain", id);
      const out: Bounty = {
        id: b.id,
        poster: b.poster,
        posterAgent: b.posterAgent,
        kind: b.kind,
        specHash: b.specHash,
        reward: b.reward,
        funding: b.funding,
        deadline: b.deadline,
        status: b.status,
        rejections: b.rejections,
        lastRejectedAt: null,
        entryCount: b.entries.length,
        created: 0n,
      };
      return out;
    },
    async payee(b) {
      return payeeOf(bountyOf("chain", b.id));
    },
    async escrowAccount() {
      return ESCROW;
    },
    async decimals() {
      return 6;
    },
    async txOutcome(hash) {
      return txs.get(hash) ?? { state: "absent" };
    },
    async finalizedNonce() {
      return state.nonce;
    },
  };

  const scheme = {
    scheme: "exact",
    createPaymentPayload: async (v: number, req: { payTo: string; amount: string }) => ({
      x402Version: v,
      payload: { signedTransaction: await signedTransfer(req.payTo, BigInt(req.amount), state.nonce, Math.floor(t / 1000) + 295) },
    }),
  };

  return {
    dir,
    clock,
    state,
    chain,
    scheme,
    fetch: http as typeof fetch,
    connect: async () => connection,
    /** Adds an open contest by @alice as bounty 8. */
    contest() {
      add({ id: 8n, kind: "Contest", poster: POSTER, taskKind: "page-facts", input: { url: "https://example.org" } });
    },
    /** The poster sends bounty `id`'s submitted work back with `reason`, as the board and contract would. */
    reject(id: string, reason: string) {
      const b = bountyOf("reject", id);
      if (b.status.type !== "Submitted") throw new Error(`bounty ${id} is ${b.status.type}`);
      specs.set(reasonHash(reason), JSON.stringify({ reason }));
      b.rejections++;
      b.status = { type: "Claimed", worker: b.status.worker, agent: b.status.agent };
      event(b, { type: "Rejected", id: b.id, count: b.rejections, reasonHash: reasonHash(reason) }, "dd".repeat(32));
    },
    /** WORKER claims and submits `full` for bounty `id` (someone else working the agent's bounty). */
    workerSubmits(id: string, full: string) {
      const b = bountyOf("work", id);
      submissions.set(sha(full), { preview: full.slice(0, 40), full });
      b.status = { type: "Submitted", worker: WORKER, agent: null, workHash: sha(full), at: BigInt(t) };
    },
    /** WORKER enters `full` in contest `id`. */
    workerEnters(id: string, full: string) {
      const b = bountyOf("enter", id);
      submissions.set(sha(full), { preview: full.slice(0, 40), full });
      b.entries.push({ worker: WORKER, agent: null, workHash: sha(full) });
    },
  };
}

/** The kit's MCP server over an in-memory transport, wired to `w` on temp files. */
export async function kitClient(w: World, over: { maxPerBounty?: bigint; dailyCap?: bigint } = {}) {
  const log: string[] = [];
  const say = (m: string) => void log.push(m);
  const budget = new SpendBudget(join(w.dir, "budget.json"), { maxPerBounty: over.maxPerBounty ?? 5_000_000n, dailyCap: over.dailyCap ?? 20_000_000n }, w.clock.now);
  const pending = new PendingStore(join(w.dir, "pending.json"));
  const lock = new AccountLock(join(w.dir, `agent-${me.address}.lock`));
  const link = new BoardLink({ connect: w.connect, origin: ORIGIN, fetch: w.fetch, badge: BADGE, keys: me, agentTokenId: 1418n, now: w.clock.now, sleep: w.clock.sleep, log: say });
  const relay = new Relay({
    board: link,
    keys: me,
    guard: { account: me.address, contract: DEPLACE, allowFees: false, maxEnergy: 30_000n },
    chain: w.chain,
    pending,
    lock,
    budget: async () => budget,
    now: w.clock.now,
    log: say,
  });
  const deps: KitDeps = {
    keys: me,
    badge: BADGE,
    agentTokenId: 1418n,
    contract: DEPLACE,
    token: { id: "EUDemo" },
    link,
    chain: w.chain,
    relay,
    budget: async () => budget,
    pending,
    fetch: w.fetch,
    scheme: w.scheme as never,
    now: w.clock.now,
    log: say,
  };
  const server = buildKitServer(workTools(deps), hireTools(deps));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "kit-test", version: "0.0.0" });
  await client.connect(clientSide);
  const texts: string[] = [];
  return {
    budget,
    pending,
    relay,
    log,
    /** Every result text the model has seen so far. */
    texts,
    async call(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; body: any }> {
      let r: { isError?: boolean; content?: { type: string; text?: string }[] };
      try {
        r = (await client.callTool({ name, arguments: args })) as typeof r;
      } catch (e) {
        texts.push((e as Error).message);
        return { isError: true, body: { error: (e as Error).message } };
      }
      const text = r.content?.find((c) => c.type === "text")?.text ?? "";
      texts.push(text);
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: text };
      }
      return { isError: r.isError === true, body };
    },
    async tools(): Promise<string[]> {
      return (await client.listTools()).tools.map((t) => t.name);
    },
    /** A tool's description, as the model reads it. */
    async description(name: string): Promise<string> {
      return (await client.listTools()).tools.find((t) => t.name === name)?.description ?? "";
    },
    async close() {
      await client.close();
      await server.close();
      lock.release();
    },
  };
}
