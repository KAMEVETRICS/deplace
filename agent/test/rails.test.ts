import { createHash, generateKeyPairSync } from "node:crypto";
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
} from "@concordium/web-sdk";
import { CborAccountAddress, TokenAmount, TokenId, createTokenUpdatePayload } from "@concordium/web-sdk/plt";
import { encodeClaim, encodeEnter, encodeIdEntry, encodeIdHash, encodePost, encodeU64 } from "@deplace/shared";
import { agentTokenId } from "../src/identity.js";
import { checkPrepared, RailViolation, reasonHash, type GuardOptions } from "../src/rails/guard.js";
import { SpendBudget } from "../src/rails/budget.js";
import { specHashFor } from "../src/rails/spec-hash.js";
import { guardedPaymentClient } from "../src/rails/payments.js";
import { x402Client } from "@x402/core/client";

const addr = (fill: number) => AccountAddress.fromBuffer(new Uint8Array(32).fill(fill).buffer).address;
const ME = addr(1);
const SPONSOR = addr(2);
const DEPLACE = { index: 13001n, subindex: 0n };
const meta = (sender = ME) => ({ sender: AccountAddress.fromBase58(sender), nonce: SequenceNumber.create(1), expiry: TransactionExpiry.futureMinutes(5) });

function call(entrypoint: string, o: { contract?: typeof DEPLACE; ccd?: bigint; sponsored?: boolean; sender?: string; energy?: bigint } = {}) {
  const c = o.contract ?? DEPLACE;
  const tx = Transaction.updateContract(
    {
      amount: CcdAmount.fromMicroCcd(o.ccd ?? 0n),
      address: ContractAddress.create(c.index, c.subindex),
      receiveName: ReceiveName.fromString(`deplace.${entrypoint}`),
      message: Parameter.fromHexString("00"),
    },
    Energy.create(o.energy ?? 30_000n),
  ).addMetadata(meta(o.sender));
  return Transaction.toJSONString(o.sponsored === false ? tx.build() : tx.addSponsor(AccountAddress.fromBase58(SPONSOR)).build());
}

/** A sponsored Deplace call of `entrypoint` from ME, carrying `parameter` (as the board's prepare_* tools return). */
function callWith(entrypoint: string, parameter: Uint8Array) {
  const tx = Transaction.updateContract(
    {
      amount: CcdAmount.zero(),
      address: ContractAddress.create(DEPLACE.index, DEPLACE.subindex),
      receiveName: ReceiveName.fromString(`deplace.${entrypoint}`),
      message: Parameter.fromBuffer(parameter.slice().buffer),
    },
    Energy.create(30_000n),
  ).addMetadata(meta());
  return Transaction.toJSONString(tx.addSponsor(AccountAddress.fromBase58(SPONSOR)).build());
}

function tokenTransfer() {
  const tx = Transaction.tokenUpdate(
    createTokenUpdatePayload(TokenId.fromString("EUDemo"), {
      transfer: { amount: TokenAmount.create(5_000_000n, 6), recipient: CborAccountAddress.fromAccountAddress(AccountAddress.fromBase58(addr(9))) },
    }),
  )
    .addMetadata(meta())
    .addSponsor(AccountAddress.fromBase58(SPONSOR))
    .build();
  return Transaction.toJSONString(tx);
}

const guard: GuardOptions = { account: ME, contract: DEPLACE, allowFees: false, maxEnergy: 60_000n };

describe("transaction guard", () => {
  it("lets through a sponsored call of the expected Deplace action with no CCD attached", () => {
    expect(() => checkPrepared(call("claim"), ["claim"], guard)).not.toThrow();
  });

  it("refuses a call to another contract, another action, or with CCD attached", () => {
    expect(() => checkPrepared(call("claim", { contract: { index: 99n, subindex: 0n } }), ["claim"], guard)).toThrow(RailViolation);
    expect(() => checkPrepared(call("cancel"), ["claim"], guard)).toThrow(/action/);
    expect(() => checkPrepared(call("claim", { ccd: 1n }), ["claim"], guard)).toThrow(/CCD/);
  });

  it("never signs a token transfer the board prepared", () => {
    expect(() => checkPrepared(tokenTransfer(), ["claim"], guard)).toThrow(/token transfer|contract call/);
  });

  it("refuses transactions for another sender", () => {
    expect(() => checkPrepared(call("claim", { sender: addr(5) }), ["claim"], guard)).toThrow(/sender/);
  });

  it("refuses to pay fees unless allowed, and caps the energy it would pay for", () => {
    expect(() => checkPrepared(call("claim", { sponsored: false }), ["claim"], guard)).toThrow(/fee/);
    expect(() => checkPrepared(call("claim", { sponsored: false }), ["claim"], { ...guard, allowFees: true })).not.toThrow();
    expect(() => checkPrepared(call("claim", { sponsored: false, energy: 90_000n }), ["claim"], { ...guard, allowFees: true })).toThrow(/energy/);
  });
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const SIG = "ab".repeat(64);

describe("what a prepared call is for", () => {
  it("signs a claim only for the bounty and agent asked for", () => {
    const tx = callWith("claim", encodeClaim({ id: 7n, agent: 1418n, attestationExpiry: 99n, signature: SIG }));
    expect(() => checkPrepared(tx, ["claim"], guard, { entrypoint: "claim", bountyId: 7n, agent: 1418n })).not.toThrow();
    expect(() => checkPrepared(tx, ["claim"], guard, { entrypoint: "claim", bountyId: 9n, agent: 1418n })).toThrow(RailViolation);
    expect(() => checkPrepared(tx, ["claim"], guard, { entrypoint: "claim", bountyId: 7n, agent: null })).toThrow(RailViolation);
  });

  it("signs a submit or a contest entry only with the hash of the work it was given", () => {
    expect(() => checkPrepared(callWith("submit", encodeIdHash(7n, sha("work"))), ["submit"], guard, { entrypoint: "submit", bountyId: 7n, workHash: sha("work") })).not.toThrow();
    expect(() => checkPrepared(callWith("submit", encodeIdHash(7n, sha("other"))), ["submit"], guard, { entrypoint: "submit", bountyId: 7n, workHash: sha("work") })).toThrow(
      RailViolation,
    );
    const enter = callWith("enter", encodeEnter({ id: 8n, agent: 1418n, workHash: sha("work"), attestationExpiry: 5n, signature: SIG }));
    expect(() => checkPrepared(enter, ["enter"], guard, { entrypoint: "enter", bountyId: 8n, agent: 1418n, workHash: sha("work") })).not.toThrow();
    expect(() => checkPrepared(enter, ["enter"], guard, { entrypoint: "enter", bountyId: 8n, agent: 1418n, workHash: sha("other") })).toThrow(RailViolation);
  });

  it("signs accept, cancel and award only for the bounty and entry asked for", () => {
    expect(() => checkPrepared(callWith("accept", encodeU64(9n)), ["accept"], guard, { entrypoint: "accept", bountyId: 7n })).toThrow(RailViolation);
    expect(() => checkPrepared(callWith("cancel", encodeU64(7n)), ["cancel"], guard, { entrypoint: "cancel", bountyId: 7n })).not.toThrow();
    expect(() => checkPrepared(callWith("award", encodeIdEntry(7n, 2)), ["award"], guard, { entrypoint: "award", bountyId: 7n, entryId: 1 })).toThrow(RailViolation);
  });

  it("signs a reject only with the hash of its reason, as the board computes it", () => {
    expect(reasonHash("too short")).toBe(sha(JSON.stringify({ reason: "too short" })));
    expect(reasonHash("x".repeat(2500))).toBe(sha(JSON.stringify({ reason: "x".repeat(2000) })));
    expect(() => checkPrepared(callWith("reject", encodeIdHash(7n, reasonHash("a"))), ["reject"], guard, { entrypoint: "reject", bountyId: 7n, reasonHash: reasonHash("b") })).toThrow(
      RailViolation,
    );
  });

  it("signs a post only with the kind, reward, deadline, agent and spec hash asked for", () => {
    const p = { kind: "Exclusive" as const, posterAgent: 1418n, specHash: sha("spec"), reward: 1_000_000n, deadline: 1_800_000_000_000n };
    const tx = callWith("post", encodePost({ ...p, attestationExpiry: 3n, signature: SIG }));
    expect(() => checkPrepared(tx, ["post"], guard, { entrypoint: "post", ...p })).not.toThrow();
    for (const wrong of [{ reward: 9_000_000n }, { deadline: 1n }, { specHash: sha("other") }, { kind: "Contest" as const }, { posterAgent: null }]) {
      expect(() => checkPrepared(tx, ["post"], guard, { entrypoint: "post", ...p, ...wrong })).toThrow(RailViolation);
    }
  });

  it("refuses an expectation for another action than the call's", () => {
    expect(() => checkPrepared(callWith("claim", encodeU64(7n)), ["claim"], guard, { entrypoint: "accept", bountyId: 7n })).toThrow(RailViolation);
  });
});

describe("spec hash", () => {
  const s = { title: "  Page facts  ", description: "D", taskKind: "page-facts", input: { url: "https://example.org" }, kind: "Exclusive" as const, reward: "1", deadline: 1_800_000_000_000 };
  const body = (agent: string) =>
    `{"title":"Page facts","description":"D","taskKind":"page-facts","input":{"url":"https://example.org"},"kind":"Exclusive","reward":"1","rewardToken":"EUDemo","deadline":1800000000000,"poster":"${ME}","posterAgent":${agent}}`;

  it("hashes the bytes the board commits to, with the title trimmed", () => {
    expect(specHashFor(s, ME, 1418n, "EUDemo")).toBe(sha(body('"1418"')));
    expect(specHashFor(s, ME, null, "EUDemo")).toBe(sha(body("null")));
  });
});

describe("agent token id", () => {
  it("reads token 1418 from the reference agent's badge", () => {
    expect(agentTokenId("JyP9WVTtVnRuL8JUmLKZH", { index: 12802n, subindex: 0n })).toBe(1418n);
  });

  it("refuses a badge that is not a token of the configured registry", () => {
    expect(() => agentTokenId("JyP9WVTtVnRuL8JUmLKZH", { index: 12803n, subindex: 0n })).toThrow(/registry/);
  });
});

describe("spending budget", () => {
  const file = () => join(mkdtempSync(join(tmpdir(), "budget-")), "budget.json");
  const limits = { maxPerBounty: 5_000_000n, dailyCap: 8_000_000n };

  it("caps each bounty's reward", () => {
    const b = new SpendBudget(file(), limits);
    expect(() => b.commit("bounty:1", 5_000_001n)).toThrow(/per-bounty/);
    b.commit("bounty:1", 5_000_000n);
  });

  it("caps what the agent commits in any 24 hours, and forgets older commitments", () => {
    let now = 1_000;
    const b = new SpendBudget(file(), limits, () => now);
    b.commit("bounty:1", 5_000_000n);
    expect(() => b.commit("bounty:2", 3_000_001n)).toThrow(/daily/);
    b.commit("bounty:2", 3_000_000n);
    now += 24 * 3_600_000 + 1;
    b.commit("bounty:3", 5_000_000n);
  });

  it("checks a reward against the limits before posting, without recording it", () => {
    const b = new SpendBudget(file(), limits);
    expect(() => b.check(5_000_001n)).toThrow(/per-bounty/);
    b.check(5_000_000n);
    expect(b.spentLast24h()).toBe(0n);
  });

  it("only pays what was committed for that bounty", () => {
    const b = new SpendBudget(file(), limits);
    b.commit("bounty:1", 2_000_000n);
    expect(() => b.reserve("bounty:1", 2_000_001n)).toThrow(/commit/);
    expect(() => b.reserve("bounty:7", 1n)).toThrow(/commit/);
    expect(() => b.reserve("bounty:1", 2_000_000n)).not.toThrow();
  });

  it("pays a reward once: escrow funding and pay on delivery cannot both draw on it", () => {
    const b = new SpendBudget(file(), limits);
    b.commit("bounty:1", 2_000_000n);
    b.reserve("bounty:1", 2_000_000n);
    expect(() => b.reserve("bounty:1", 2_000_000n)).toThrow(/already paid/);
  });

  it("gives a booking back only through its undo, for a payment that was never produced", () => {
    const b = new SpendBudget(file(), limits);
    b.commit("bounty:1", 2_000_000n);
    const undo = b.reserve("bounty:1", 2_000_000n);
    undo();
    undo(); // a second undo changes nothing
    b.reserve("bounty:1", 2_000_000n);
    expect(() => b.reserve("bounty:1", 1n)).toThrow(/already paid/);
  });

  it("keeps commitments and payments across restarts, and committing the same bounty twice counts once", () => {
    const f = file();
    const a = new SpendBudget(f, limits);
    a.commit("bounty:1", 5_000_000n);
    a.commit("bounty:1", 5_000_000n);
    a.reserve("bounty:1", 5_000_000n);
    const b = new SpendBudget(f, limits);
    expect(b.spentLast24h()).toBe(5_000_000n);
    expect(() => b.commit("bounty:2", 3_000_001n)).toThrow(/daily/);
    expect(() => b.reserve("bounty:1", 1n)).toThrow(/already paid/);
  });

  it("moves a post's commitment to its bounty, still counted once in the day", () => {
    const b = new SpendBudget(null, { maxPerBounty: 5n, dailyCap: 5n });
    b.commit("post-tx:aa", 2n);
    b.rename("post-tx:aa", "bounty:9");
    expect(b.spentLast24h()).toBe(2n);
    expect(() => b.reserve("bounty:9", 2n)).not.toThrow();
    expect(() => b.rename("post-tx:aa", "bounty:10")).toThrow(RailViolation);
    b.commit("post-tx:bb", 1n);
    expect(() => b.rename("post-tx:bb", "bounty:9")).toThrow(RailViolation);
  });

  it("drops the commitment of a post that never landed, never one with payments against it", () => {
    const b = new SpendBudget(null, { maxPerBounty: 5n, dailyCap: 5n });
    b.commit("post-tx:aa", 2n);
    b.remove("post-tx:aa");
    expect(b.spentLast24h()).toBe(0n);
    b.commit("bounty:9", 2n);
    b.reserve("bounty:9", 1n);
    expect(() => b.remove("bounty:9")).toThrow(RailViolation);
    expect(() => b.remove("bounty:404")).toThrow(RailViolation);
  });

  it("gives back a payment that never landed, never more than was paid", () => {
    const b = new SpendBudget(null, { maxPerBounty: 5n, dailyCap: 5n });
    b.commit("bounty:9", 2n);
    b.reserve("bounty:9", 2n);
    b.unbook("bounty:9", 2n);
    expect(() => b.reserve("bounty:9", 2n)).not.toThrow();
    expect(() => b.unbook("bounty:9", 5n)).toThrow(RailViolation);
    expect(() => b.unbook("bounty:404", 1n)).toThrow(RailViolation);
  });

  it("keeps moves, drops and give-backs across restarts", () => {
    const f = file();
    const a = new SpendBudget(f, limits);
    a.commit("post-tx:aa", 2_000_000n);
    a.rename("post-tx:aa", "bounty:9");
    a.commit("post-tx:bb", 1_000_000n);
    a.remove("post-tx:bb");
    a.reserve("bounty:9", 2_000_000n);
    a.unbook("bounty:9", 2_000_000n);
    const b = new SpendBudget(f, limits);
    expect(b.spentLast24h()).toBe(2_000_000n);
    expect(() => b.reserve("post-tx:aa", 1n)).toThrow(/commit/);
    expect(() => b.reserve("bounty:9", 2_000_000n)).not.toThrow();
  });
});

describe("guarded x402 client", () => {
  const network = "ccd:4221332d34e1694168c2a0c0b3fd0f27" as const;
  const fakeScheme = { scheme: "exact", createPaymentPayload: async (v: number) => ({ x402Version: v, payload: { signed: true } }) };
  const required = (r: { asset?: string; amount?: string; payTo?: string; maxTimeoutSeconds?: number }) => ({
    x402Version: 2,
    resource: { url: "https://board/bounties/1/work", description: "work", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network, asset: r.asset ?? "EUDemo", amount: r.amount ?? "2000000", payTo: r.payTo ?? addr(7), maxTimeoutSeconds: r.maxTimeoutSeconds ?? 300, extra: {} }],
  });
  const noBooking = () => () => {};
  const client = (expected: { payTo: string; amount: string }, o: { scheme?: unknown; book?: (amount: bigint) => () => void } = {}) =>
    guardedPaymentClient({ network, scheme: (o.scheme ?? fakeScheme) as never, asset: "EUDemo", maxAtomic: 5_000_000n, expected: () => expected, book: o.book ?? noBooking });

  it("pays EUDemo to the expected worker, for the expected amount", async () => {
    await expect(client({ payTo: addr(7), amount: "2000000" }).createPaymentPayload(required({}) as never)).resolves.toMatchObject({ payload: { signed: true } });
  });

  it("refuses another payee, another amount or another asset, without booking anything", async () => {
    const booked: bigint[] = [];
    const book = (a: bigint) => (booked.push(a), noBooking());
    await expect(client({ payTo: addr(8), amount: "2000000" }, { book }).createPaymentPayload(required({}) as never)).rejects.toThrow();
    await expect(client({ payTo: addr(7), amount: "1000000" }, { book }).createPaymentPayload(required({}) as never)).rejects.toThrow();
    await expect(client({ payTo: addr(7), amount: "2000000" }, { book }).createPaymentPayload(required({ asset: "USDR" }) as never)).rejects.toThrow();
    expect(booked).toEqual([]);
  });

  it("books the payment against the budget just before signing, and does not sign when the budget refuses", async () => {
    const booked: bigint[] = [];
    await client({ payTo: addr(7), amount: "2000000" }, { book: (a) => (booked.push(a), noBooking()) }).createPaymentPayload(required({}) as never);
    expect(booked).toEqual([2_000_000n]);

    let signed = false;
    const watching = { scheme: "exact", createPaymentPayload: async (v: number) => ((signed = true), { x402Version: v, payload: {} }) };
    const refusing = () => {
      throw new RailViolation("over budget");
    };
    await expect(client({ payTo: addr(7), amount: "2000000" }, { scheme: watching, book: refusing }).createPaymentPayload(required({}) as never)).rejects.toThrow(/over budget/);
    expect(signed).toBe(false);
  });

  it("gives the booking back when signing fails, since no payment exists", async () => {
    let undone = 0;
    const failing = { scheme: "exact", createPaymentPayload: async () => Promise.reject(new Error("signer unavailable")) };
    await expect(client({ payTo: addr(7), amount: "2000000" }, { scheme: failing, book: () => () => void undone++ }).createPaymentPayload(required({}) as never)).rejects.toThrow(
      /signer unavailable/,
    );
    expect(undone).toBe(1);
  });

  it("documents why the rail is needed: a default x402 client refuses EUDemo outright", async () => {
    const plain = new x402Client().register(network, fakeScheme as never);
    await expect(plain.createPaymentPayload(required({}) as never)).rejects.toThrow();
  });

  it("stops a payment and gives its booking back when onCreated refuses it", async () => {
    const budget = new SpendBudget(null, { maxPerBounty: 5_000_000n, dailyCap: 5_000_000n });
    budget.commit("bounty:1", 2_000_000n);
    const refusing = guardedPaymentClient({
      network,
      scheme: fakeScheme as never,
      asset: "EUDemo",
      maxAtomic: 5_000_000n,
      expected: () => ({ payTo: addr(7), amount: "2000000" }),
      book: (amount) => budget.reserve("bounty:1", amount),
      onCreated: () => {
        throw new RailViolation("cannot read the payment back");
      },
    });
    await expect(refusing.createPaymentPayload(required({}) as never)).rejects.toThrow(/cannot read the payment back/);
    expect(() => budget.reserve("bounty:1", 2_000_000n)).not.toThrow();
  });

  it("refuses payment terms that would keep a signed payment open for more than ten minutes", async () => {
    const booked: bigint[] = [];
    const book = (a: bigint) => (booked.push(a), noBooking());
    await expect(client({ payTo: addr(7), amount: "2000000" }, { book }).createPaymentPayload(required({ maxTimeoutSeconds: 86_400 }) as never)).rejects.toThrow();
    expect(booked).toEqual([]);
    await expect(client({ payTo: addr(7), amount: "2000000" }, { book }).createPaymentPayload(required({ maxTimeoutSeconds: 600 }) as never)).resolves.toBeDefined();
  });

  it("refuses a payment above the per-payment cap even when it was expected", async () => {
    await expect(client({ payTo: addr(7), amount: "6000000" }).createPaymentPayload(required({ amount: "6000000" }) as never)).rejects.toThrow();
  });
});
