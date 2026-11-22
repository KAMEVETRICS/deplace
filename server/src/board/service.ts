import { createHash, randomBytes } from "node:crypto";
import type { AccountTransactionSignature } from "@concordium/web-sdk";
import {
  accountLink,
  agentLink,
  encodeClaim,
  encodeEnter,
  encodeIdEntry,
  encodeIdHash,
  encodePost,
  encodeU64,
  instanceLink,
  txLink,
  type BoardEvent,
  type Bounty,
  type BountyKind,
  type ContractRef,
  type Entry,
  type Stats,
} from "@bounty/shared";
import { classifyAccount, verifyAccountSignature, type AccountInfoLookup } from "../identity/account.js";
import { verifyAgent } from "../identity/agent.js";
import type { Attestor } from "../identity/attestor.js";
import { ChallengeStore, challengeMessage } from "../identity/challenge.js";
import { checkPayoutEligible } from "../identity/eligibility.js";
import type { Intent } from "../sponsor/policy.js";
import type { PreparedTx } from "../sponsor/sponsor.js";
import type { BoardStore, BountyFilter } from "../store/db.js";
import { syncFromChain } from "../store/sync.js";

/** An error the API and MCP layers report to the caller as-is. */
export class BoardError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "BoardError";
  }
}

export interface BoardDeps {
  config: {
    contract: ContractRef;
    rewardTokenId: string;
    tokenDecimals: number;
    escrowAccount: string;
    sponsorAddress: string;
    faucetUrl: string | null;
    badgeApi: string;
  };
  store: BoardStore;
  chain: {
    view(id: bigint): Promise<Bounty | null>;
    entry(id: bigint, entryId: number): Promise<Entry | null>;
    stats(account: string): Promise<Stats>;
    all(): Promise<Bounty[]>;
  };
  isOnAllowList(account: string): Promise<boolean>;
  accounts: AccountInfoLookup;
  idpName(index: number): string | undefined;
  agentWallet(tokenId: bigint): Promise<string | null>;
  fetch: typeof fetch;
  sponsor: { prepare(intent: Intent, sender: string, badge?: string): Promise<PreparedTx> };
  attestor: Attestor;
  /** The sponsor account named in a prepared transaction's header, or null if unsponsored. */
  txSponsor(txJson: string): string | null;
  /** Finalizes a sender-signed transaction, sends it and waits for finalization. */
  relay(txJson: string): Promise<{ txHash: string; summary: unknown }>;
  eventsOf(summary: unknown): BoardEvent[];
  /** A finalized token transfer the board relayed: escrow funding (fund:<id>) or a direct payment (bounty:<id>). */
  noteTransfer(txHash: string): Promise<void>;
  now(): number;
}

export interface Identity {
  kind: "person" | "company" | "agent";
  label: string;
  account: string;
  tokenId?: bigint;
  badge?: string;
}

interface Session extends Identity {
  expiresAt: number;
}

export interface SpecInput {
  title: string;
  description: string;
  taskKind: string;
  input: Record<string, unknown>;
  kind: BountyKind;
  /** Decimal amount of the reward token, e.g. "2" or "0.5". */
  reward: string;
  /** Unix ms. */
  deadline: number;
}

const SESSION_TTL_MS = 12 * 60 * 60_000;
const ATTESTATION_TTL_MS = 10n * 60_000n;
const MAX_DEADLINE_MS = 90 * 24 * 60 * 60_000;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface Prepared {
  action: string;
  bountyId?: string;
  prepared: PreparedTx;
}

export class BoardService {
  private readonly challenges: ChallengeStore;
  private readonly sessions = new Map<string, Session>();
  private lastSync = 0;

  constructor(private readonly d: BoardDeps) {
    this.challenges = new ChallengeStore(5 * 60_000, d.now);
  }

  get config() {
    return this.d.config;
  }

  // --- auth -------------------------------------------------------------------

  challenge(subject: { account?: string; badge?: string }) {
    const key = subject.account ?? subject.badge;
    if (!key) throw new BoardError(400, "give an account or a badge");
    return this.challenges.issue(key);
  }

  async login(input: { account?: string; badge?: string; nonce: string; signature: AccountTransactionSignature }): Promise<{ token: string; identity: Identity }> {
    const subject = input.account ?? input.badge;
    if (!subject || !input.nonce || !input.signature) throw new BoardError(400, "account or badge, nonce and signature are required");
    if (!this.challenges.consume(subject, input.nonce)) throw new BoardError(401, "unknown, used or expired challenge");
    const message = challengeMessage(input.nonce);

    let identity: Identity;
    if (input.account) {
      if (!(await verifyAccountSignature(this.d.accounts, input.account, message, input.signature))) throw new BoardError(401, "signature does not match the account's keys");
      const who = await classifyAccount(this.d.accounts, this.d.idpName, input.account);
      identity = { kind: who.kind, account: input.account, label: `Verified ${who.kind} (${who.idpName})` };
    } else {
      const v = await verifyAgent(
        { fetch: this.d.fetch, badgeApi: this.d.config.badgeApi, lookup: this.d.accounts, agentWallet: this.d.agentWallet },
        { badge: input.badge!, message, signature: input.signature },
      );
      if (!v.ok) throw new BoardError(v.unavailable ? 503 : 401, v.reason, v.retryAfter ? { retryAfter: v.retryAfter } : {});
      identity = { kind: "agent", account: v.payoutAccount, tokenId: v.tokenId, badge: input.badge!, label: `Agent #${v.tokenId} (Verified by Concordium badge)` };
    }
    const token = randomBytes(24).toString("base64url");
    this.sessions.set(token, { ...identity, expiresAt: this.d.now() + SESSION_TTL_MS });
    return { token, identity };
  }

  /** Resolves an `Authorization: Bearer <token>` header to the caller's identity. */
  session(authorization: string | undefined): Identity {
    const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
    const s = token ? this.sessions.get(token) : undefined;
    if (!s || s.expiresAt < this.d.now()) throw new BoardError(401, "log in first (POST /auth/challenge, then /auth/login)");
    return s;
  }

  // --- posting ----------------------------------------------------------------

  private parseReward(reward: string): bigint {
    const decimals = this.d.config.tokenDecimals;
    const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(String(reward ?? ""));
    if (!m) throw new BoardError(400, "reward must be a decimal amount such as 2 or 0.5");
    const frac = m[2] ?? "";
    if (frac.length > decimals) throw new BoardError(400, `reward has more than ${decimals} decimals`);
    const units = BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
    if (units <= 0n) throw new BoardError(400, "reward must be positive");
    return units;
  }

  private validateSpec(s: SpecInput) {
    if (typeof s?.title !== "string" || s.title.trim().length === 0 || s.title.length > 120) throw new BoardError(400, "title must be 1 to 120 characters");
    if (typeof s.description !== "string" || s.description.length > 4000) throw new BoardError(400, "description must be at most 4000 characters");
    if (typeof s.taskKind !== "string" || !/^[a-z0-9-]{1,32}$/.test(s.taskKind)) throw new BoardError(400, "taskKind must be lowercase letters, digits or dashes");
    if (typeof s.input !== "object" || s.input === null || Array.isArray(s.input) || JSON.stringify(s.input).length > 2048) throw new BoardError(400, "input must be a JSON object under 2 KB");
    if (s.kind !== "Exclusive" && s.kind !== "Contest") throw new BoardError(400, "kind must be Exclusive or Contest");
    const now = this.d.now();
    if (!Number.isSafeInteger(s.deadline) || s.deadline <= now || s.deadline > now + MAX_DEADLINE_MS) throw new BoardError(400, "deadline must be in the future and within 90 days");
  }

  async createBounty(who: Identity, s: SpecInput): Promise<Prepared & { specHash: string }> {
    this.validateSpec(s);
    const reward = this.parseReward(s.reward);
    // Fixed key order: these exact bytes are what the on-chain spec hash commits to.
    const json = JSON.stringify({
      title: s.title.trim(),
      description: s.description,
      taskKind: s.taskKind,
      input: s.input,
      kind: s.kind,
      reward: s.reward,
      rewardToken: this.d.config.rewardTokenId,
      deadline: s.deadline,
      poster: who.account,
      posterAgent: who.tokenId?.toString() ?? null,
    });
    const specHash = sha256(json);
    this.d.store.putSpec(specHash, json);
    const posterAgent = who.tokenId ?? null;
    const a = this.d.attestor.attestPost(
      { contract: this.d.config.contract, poster: who.account, posterAgent, specHash: Buffer.from(specHash, "hex") },
      ATTESTATION_TTL_MS,
    );
    const parameter = encodePost({
      kind: s.kind,
      posterAgent,
      specHash,
      reward,
      deadline: BigInt(s.deadline),
      attestationExpiry: a.expiry,
      signature: a.signatureHex,
    });
    const prepared = await this.d.sponsor.prepare({ type: "contract", entrypoint: "post", parameter }, who.account, who.badge);
    return { action: "post", specHash, prepared };
  }

  spec(hash: string): string | null {
    return this.d.store.spec(hash);
  }

  // --- working ----------------------------------------------------------------

  private async live(id: bigint): Promise<Bounty> {
    const b = await this.d.chain.view(id);
    if (!b) throw new BoardError(404, `no bounty ${id}`);
    this.d.store.upsertBounty(b);
    return b;
  }

  private async ensurePayable(account: string) {
    const e = await checkPayoutEligible(this.d.isOnAllowList, account, this.d.config.faucetUrl);
    if (!e.ok) throw new BoardError(409, e.reason, { faucetUrl: e.faucetUrl });
  }

  private ensurePoster(who: Identity, b: Bounty) {
    if (b.poster !== who.account) throw new BoardError(403, "only the bounty's poster can do this");
  }

  private contract(entrypoint: string, parameter: Uint8Array): Intent {
    return { type: "contract", entrypoint, parameter };
  }

  async claim(who: Identity, id: bigint): Promise<Prepared> {
    const b = await this.live(id);
    if (b.kind !== "Exclusive") throw new BoardError(409, "contests have no claims: submit an entry instead");
    if (b.status.type !== "Open") throw new BoardError(409, `bounty ${id} is ${b.status.type}, not Open`);
    if (BigInt(this.d.now()) >= b.deadline) throw new BoardError(409, "the deadline has passed");
    if (b.poster === who.account) throw new BoardError(409, "you cannot claim your own bounty");
    await this.ensurePayable(who.account);
    const agent = who.tokenId ?? null;
    const a = this.d.attestor.attestWork({ kind: "claim", contract: this.d.config.contract, bountyId: id, worker: who.account, agent }, ATTESTATION_TTL_MS);
    const parameter = encodeClaim({ id, agent, attestationExpiry: a.expiry, signature: a.signatureHex });
    return { action: "claim", bountyId: id.toString(), prepared: await this.d.sponsor.prepare(this.contract("claim", parameter), who.account, who.badge) };
  }

  async submit(who: Identity, id: bigint, work: { preview: string; full: string }): Promise<Prepared & { workHash: string }> {
    if (typeof work?.preview !== "string" || work.preview.length > 2000) throw new BoardError(400, "preview must be at most 2000 characters");
    if (typeof work.full !== "string" || work.full.length === 0 || work.full.length > 100_000) throw new BoardError(400, "full work must be 1 to 100000 characters");
    const b = await this.live(id);
    const workHash = sha256(work.full);

    let intent: Intent;
    if (b.kind === "Exclusive") {
      if (b.status.type !== "Claimed") throw new BoardError(409, `bounty ${id} is ${b.status.type}, not Claimed`);
      if (b.status.worker !== who.account) throw new BoardError(403, "only the worker who claimed this bounty can submit");
      intent = this.contract("submit", encodeIdHash(id, workHash));
    } else {
      if (b.status.type !== "Open") throw new BoardError(409, `contest ${id} is ${b.status.type}, not Open`);
      if (BigInt(this.d.now()) >= b.deadline) throw new BoardError(409, "the deadline has passed");
      if (b.poster === who.account) throw new BoardError(409, "you cannot enter your own contest");
      await this.ensurePayable(who.account);
      const agent = who.tokenId ?? null;
      const a = this.d.attestor.attestWork({ kind: "enter", contract: this.d.config.contract, bountyId: id, worker: who.account, agent }, ATTESTATION_TTL_MS);
      intent = this.contract("enter", encodeEnter({ id, agent, workHash, attestationExpiry: a.expiry, signature: a.signatureHex }));
    }
    this.d.store.putSubmission({ workHash, bountyId: id, worker: who.account, preview: work.preview, full: work.full });
    const prepared = await this.d.sponsor.prepare(intent, who.account, who.badge);
    return { action: b.kind === "Exclusive" ? "submit" : "enter", bountyId: id.toString(), workHash, prepared };
  }

  async posterAction(who: Identity, id: bigint, action: "accept" | "cancel" | "reject" | "award", extra: { reason?: string; entryId?: number } = {}): Promise<Prepared> {
    const b = await this.live(id);
    this.ensurePoster(who, b);
    let parameter: Uint8Array;
    if (action === "accept" || action === "cancel") parameter = encodeU64(id);
    else if (action === "reject") {
      const reason = String(extra.reason ?? "").slice(0, 2000);
      const reasonHash = sha256(JSON.stringify({ reason }));
      this.d.store.putSpec(reasonHash, JSON.stringify({ reason }));
      parameter = encodeIdHash(id, reasonHash);
    } else {
      if (!Number.isInteger(extra.entryId) || (extra.entryId as number) < 0) throw new BoardError(400, "entryId is required");
      parameter = encodeIdEntry(id, extra.entryId as number);
    }
    return { action, bountyId: id.toString(), prepared: await this.d.sponsor.prepare(this.contract(action, parameter), who.account, who.badge) };
  }

  /** Who is owed the reward right now, if anyone (for direct payment and x402 pay-on-delivery). */
  async payee(b: Bounty): Promise<string | null> {
    switch (b.status.type) {
      case "Accepted":
      case "AcceptedUnpaid":
        return b.status.worker;
      case "Awarded":
        return (await this.d.chain.entry(b.id, b.status.entryId))?.worker ?? null;
      default:
        return null;
    }
  }

  /** Fallback when x402 is unavailable: a sponsored direct transfer, funding escrow or paying the worker. */
  async transferIntent(who: Identity, id: bigint, purpose: "fund" | "pay"): Promise<Prepared> {
    const b = await this.live(id);
    this.ensurePoster(who, b);
    let to: string;
    if (purpose === "fund") {
      if (b.funding.type !== "NotFunded") throw new BoardError(409, "already escrowed");
      to = this.d.config.escrowAccount;
    } else {
      const payee = b.funding.type === "NotFunded" ? await this.payee(b) : null;
      if (!payee) throw new BoardError(409, `nothing to pay for bounty ${id} in status ${b.status.type}`);
      to = payee;
    }
    const memo = `${purpose === "fund" ? "fund" : "bounty"}:${id}`;
    const intent: Intent = { type: "plt-transfer", token: this.d.config.rewardTokenId, to, amount: b.reward, memo };
    return { action: `${purpose}-transfer`, bountyId: id.toString(), prepared: await this.d.sponsor.prepare(intent, who.account, who.badge) };
  }

  // --- relay ------------------------------------------------------------------

  async relay(txJson: string): Promise<{ txHash: string; link: string; events: BoardEvent[] }> {
    if (typeof txJson !== "string" || txJson.length > 64_000) throw new BoardError(400, "txJson must be the signed transaction JSON");
    if (this.d.txSponsor(txJson) !== this.d.config.sponsorAddress) throw new BoardError(400, "only transactions prepared and co-signed by this board's sponsor are relayed");
    const { txHash, summary } = await this.d.relay(txJson);
    const events = this.d.eventsOf(summary);
    if (events.length > 0) {
      this.d.store.recordEvents(txHash, events, this.d.now());
      const ids = new Set(events.flatMap((e) => ("id" in e ? [e.id] : [])));
      for (const id of ids) {
        const b = await this.d.chain.view(id);
        if (b) this.d.store.upsertBounty(b);
      }
    }
    if ((summary as { transactionType?: string })?.transactionType === "tokenUpdate") await this.d.noteTransfer(txHash);
    return { txHash, link: txLink(txHash), events };
  }

  /** For callers outside the relay (x402 settlement, escrow worker) to log events and refresh state. */
  async noteEvents(txHash: string, events: BoardEvent[]) {
    this.d.store.recordEvents(txHash, events, this.d.now());
  }

  async refresh(id: bigint) {
    const b = await this.d.chain.view(id);
    if (b) this.d.store.upsertBounty(b);
    return b;
  }

  // --- reads ------------------------------------------------------------------

  async sync(maxAgeMs = 10_000) {
    if (this.d.now() - this.lastSync < maxAgeMs) return;
    await syncFromChain(this.d.chain, this.d.store);
    this.lastSync = this.d.now();
  }

  async list(f: BountyFilter) {
    await this.sync();
    return this.d.store.bounties(f).map((b) => ({ ...b, spec: this.parsedSpec(b.specHash) }));
  }

  private parsedSpec(hash: string): unknown {
    const json = this.d.store.spec(hash);
    return json ? JSON.parse(json) : null;
  }

  async profile(account: string) {
    const [stats, identity] = await Promise.all([
      this.d.chain.stats(account),
      classifyAccount(this.d.accounts, this.d.idpName, account).catch(() => null),
    ]);
    return { account, stats, identity, link: accountLink(account) };
  }

  async detail(id: bigint) {
    const b = this.d.store.bounty(id) ?? (await this.live(id));
    const entries: (Entry & { entryId: number })[] = [];
    for (let i = 0; i < b.entryCount; i++) {
      const e = await this.d.chain.entry(id, i);
      if (e) entries.push({ ...e, entryId: i });
    }
    const preview = (hash: string) => this.d.store.submission(hash)?.preview ?? null;
    return {
      bounty: b,
      spec: this.parsedSpec(b.specHash),
      submission: b.status.type === "Submitted" ? { workHash: b.status.workHash, preview: preview(b.status.workHash) } : null,
      entries: entries.map((e) => ({ ...e, preview: preview(e.workHash) })),
      events: this.d.store.events(id).map((e) => ({ ...e, link: txLink(e.tx) })),
      posterProfile: await this.profile(b.poster),
      links: {
        contract: instanceLink(this.d.config.contract.index, this.d.config.contract.subindex),
        poster: accountLink(b.poster),
        posterAgent: b.posterAgent !== null ? agentLink(b.posterAgent) : null,
      },
    };
  }
}
