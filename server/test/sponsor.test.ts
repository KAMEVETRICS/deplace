import { describe, expect, it } from "vitest";
import { buildBasicAccountSigner, Transaction } from "@concordium/web-sdk";
import { SponsorPolicy, type BountyFacts } from "../src/sponsor/policy.js";
import { buildSponsored, SponsorRefused, SponsorService } from "../src/sponsor/sponsor.js";
import { testAccount } from "./helpers/accounts.js";

const escrow = testAccount(10).address;
const poster = testAccount(11).address;
const worker = testAccount(12).address;
const stranger = testAccount(13).address;

const facts: Record<string, BountyFacts> = {
  "1": { poster, payee: worker, reward: 100n },
  "2": { poster, payee: null, reward: 100n },
};

function policy(now = () => 0) {
  return new SponsorPolicy({
    escrowAccount: escrow,
    rewardTokenId: "EUDemo",
    bounty: async (id) => facts[id.toString()] ?? null,
    now,
  });
}

const contract = (entrypoint: string) => ({ type: "contract" as const, entrypoint, parameter: new Uint8Array([1]) });
const transfer = (to: string, memo: string, token = "EUDemo", amount = 100n) => ({ type: "plt-transfer" as const, token, to, amount, memo });

describe("sponsor policy", () => {
  it("sponsors the board's user entrypoints", async () => {
    for (const e of ["post", "claim", "submit", "accept", "reject", "enter", "award", "cancel", "expire", "auto_accept"]) {
      expect(await policy().check(contract(e), poster)).toEqual({ ok: true });
    }
  });

  it("refuses_foreign_contract: operator-only and unknown entrypoints are not sponsored", async () => {
    for (const e of ["record_payout", "confirm_funding", "set_operator", "set_attestor", "transfer", "bounty_board.post"]) {
      expect(await policy().check(contract(e), poster)).toMatchObject({ ok: false, reason: expect.stringMatching(/not sponsored/) });
    }
  });

  it("sponsors funding the escrow and paying the recorded worker", async () => {
    expect(await policy().check(transfer(escrow, "fund:2"), poster)).toEqual({ ok: true });
    expect(await policy().check(transfer(worker, "bounty:1"), poster)).toEqual({ ok: true });
  });

  it("refuses_transfer_to_unrelated_account", async () => {
    const p = policy();
    expect(await p.check(transfer(stranger, "fund:2"), poster)).toMatchObject({ ok: false, reason: expect.stringMatching(/escrow/) });
    expect(await p.check(transfer(stranger, "bounty:1"), poster)).toMatchObject({ ok: false, reason: expect.stringMatching(/worker/) });
    expect(await p.check(transfer(worker, "bounty:2"), poster)).toMatchObject({ ok: false, reason: expect.stringMatching(/worker/) });
    expect(await p.check(transfer(escrow, "hello"), poster)).toMatchObject({ ok: false, reason: expect.stringMatching(/memo/) });
    expect(await p.check(transfer(escrow, "fund:99"), poster)).toMatchObject({ ok: false, reason: expect.stringMatching(/no bounty/) });
  });

  it("only the poster's own transfers are sponsored", async () => {
    expect(await policy().check(transfer(escrow, "fund:2"), stranger)).toMatchObject({ ok: false, reason: expect.stringMatching(/poster/) });
  });

  it("refuses_wrong_token", async () => {
    expect(await policy().check(transfer(escrow, "fund:2", "USDR"), poster)).toMatchObject({ ok: false, reason: expect.stringMatching(/token/) });
  });

  it("refuses a zero amount", async () => {
    expect(await policy().check(transfer(escrow, "fund:2", "EUDemo", 0n), poster)).toMatchObject({ ok: false });
  });

  it("rate_limit_trips_at_31", async () => {
    let now = 0;
    const p = policy(() => now);
    for (let i = 0; i < 30; i++) expect((await p.check(contract("submit"), worker)).ok).toBe(true);
    expect(await p.check(contract("submit"), worker)).toMatchObject({ ok: false, reason: expect.stringMatching(/rate/), retryAfter: expect.any(Number) });
    expect((await p.check(contract("submit"), poster)).ok).toBe(true); // other senders unaffected
    now += 60 * 60_000 + 1;
    expect((await p.check(contract("submit"), worker)).ok).toBe(true);
  });

  it("limits each badge to 10 sponsored transactions an hour, across accounts", async () => {
    const p = policy();
    for (let i = 0; i < 10; i++) expect((await p.check(contract("claim"), `acct-${i}`, "JyP9Badge")).ok).toBe(true);
    expect(await p.check(contract("claim"), "acct-x", "JyP9Badge")).toMatchObject({ ok: false, reason: expect.stringMatching(/badge/) });
  });
});

describe("sponsored transactions", () => {
  const sponsorAcct = testAccount(20);
  const deps = {
    sponsor: { address: sponsorAcct.address, signer: buildBasicAccountSigner(sponsorAcct.privateKeyHex) },
    nextNonce: async () => 7n,
    contract: { index: 13001n, subindex: 0n },
    rewardTokenId: "EUDemo",
    tokenDecimals: 6,
  };

  it("prepared_tx_has_sponsor_and_sender_nonce", async () => {
    const prepared = await buildSponsored(deps, contract("claim"), worker);
    expect(prepared.feeSponsored).toBe(true);
    const tx = Transaction.signableFromJSON(JSON.parse(prepared.txJson));
    if (tx.version !== 1) throw new Error("expected a v1 (sponsorable) transaction");
    expect(tx.header.sender.address).toBe(worker);
    expect(tx.header.nonce.value).toBe(7n);
    expect(tx.header.sponsor?.account.address).toBe(sponsorAcct.address);
    expect(tx.signatures.sponsor).toBeDefined();
    expect(Object.keys(tx.signatures.sender ?? {})).toHaveLength(0); // the sender signs later
  });

  it("builds a token transfer with the memo", async () => {
    const prepared = await buildSponsored(deps, transfer(escrow, "fund:2"), poster);
    const tx = Transaction.signableFromJSON(JSON.parse(prepared.txJson));
    if (tx.version !== 1) throw new Error("expected a v1 (sponsorable) transaction");
    expect(tx.header.sponsor?.account.address).toBe(sponsorAcct.address);
    expect(prepared.txJson).toContain("EUDemo");
  });

  it("the service refuses what the policy refuses", async () => {
    const service = new SponsorService(policy(), deps);
    await expect(service.prepare(contract("record_payout"), poster)).rejects.toBeInstanceOf(SponsorRefused);
    await expect(service.prepare(contract("claim"), worker)).resolves.toMatchObject({ feeSponsored: true });
  });
});
