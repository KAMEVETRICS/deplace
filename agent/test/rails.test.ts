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
} from "@concordium/web-sdk";
import { CborAccountAddress, TokenAmount, TokenId, createTokenUpdatePayload } from "@concordium/web-sdk/plt";
import { checkPrepared, RailViolation, type GuardOptions } from "../src/rails/guard.js";
import { SpendBudget } from "../src/rails/budget.js";
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
});

describe("guarded x402 client", () => {
  const network = "ccd:4221332d34e1694168c2a0c0b3fd0f27" as const;
  const fakeScheme = { scheme: "exact", createPaymentPayload: async (v: number) => ({ x402Version: v, payload: { signed: true } }) };
  const required = (r: { asset?: string; amount?: string; payTo?: string }) => ({
    x402Version: 2,
    resource: { url: "https://board/bounties/1/work", description: "work", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network, asset: r.asset ?? "EUDemo", amount: r.amount ?? "2000000", payTo: r.payTo ?? addr(7), maxTimeoutSeconds: 300, extra: {} }],
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

  it("refuses a payment above the per-payment cap even when it was expected", async () => {
    await expect(client({ payTo: addr(7), amount: "6000000" }).createPaymentPayload(required({ amount: "6000000" }) as never)).rejects.toThrow();
  });
});
