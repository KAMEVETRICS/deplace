import { readFileSync } from "node:fs";
import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { postAttestationBytes, workAttestationBytes } from "@bounty/shared";
import { ChallengeStore, challengeMessage } from "../src/identity/challenge.js";
import { classifyAccount, verifyAccountSignature } from "../src/identity/account.js";
import { checkBadge } from "../src/identity/badge.js";
import { verifyAgent } from "../src/identity/agent.js";
import { checkPayoutEligible } from "../src/identity/eligibility.js";
import { Attestor } from "../src/identity/attestor.js";
import { lookupOf, testAccount } from "./helpers/accounts.js";

const invalidVerdict = JSON.parse(readFileSync(new URL("./fixtures/check-badge-invalid.json", import.meta.url), "utf8"));

function validVerdict(owner: string, tokenId = 7) {
  return {
    ...invalidVerdict,
    token_id: tokenId,
    token_address: "JyP9TestBadge",
    http_status: 200,
    on_chain: { ...invalidVerdict.on_chain, owner_account: owner, status: "Active" },
    checks: Object.fromEntries(Object.keys(invalidVerdict.checks).map((k) => [k, true])),
    badge_valid: true,
    issues: [],
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const fetchReturning = (res: Response | (() => Promise<Response>)) =>
  (async () => (typeof res === "function" ? res() : res.clone())) as unknown as typeof fetch;

describe("challenges", () => {
  it("challenge_single_use_and_expiry", () => {
    let now = 1_000;
    const store = new ChallengeStore(5 * 60_000, () => now);
    const a = store.issue("acct-1");
    expect(store.consume("acct-2", a.nonce)).toBe(false); // bound to its subject
    expect(store.consume("acct-1", a.nonce)).toBe(true);
    expect(store.consume("acct-1", a.nonce)).toBe(false); // single use

    const b = store.issue("acct-1");
    now += 5 * 60_000 + 1;
    expect(store.consume("acct-1", b.nonce)).toBe(false); // expired
  });

  it("puts the nonce in a domain-separated message", () => {
    expect(challengeMessage("abc")).toBe("BountyBoard/v1/login:abc");
  });
});

describe("accounts", () => {
  it("verifies a signature made by the account's key", async () => {
    const alice = testAccount(1);
    const msg = challengeMessage("n1");
    expect(await verifyAccountSignature(lookupOf(alice), alice.address, msg, await alice.sign(msg))).toBe(true);
  });

  it("rejects a signature by another account's key, and malformed signatures, without throwing", async () => {
    const alice = testAccount(1);
    const mallory = testAccount(2);
    const msg = challengeMessage("n1");
    const lookup = lookupOf(alice, mallory);
    expect(await verifyAccountSignature(lookup, alice.address, msg, await mallory.sign(msg))).toBe(false);
    expect(await verifyAccountSignature(lookup, alice.address, msg, { 5: { 0: "00" } })).toBe(false);
    expect(await verifyAccountSignature(lookup, alice.address, msg, {})).toBe(false);
  });

  it("company_classified_by_idp4", async () => {
    const person = testAccount(1, 0);
    const company = testAccount(2, 4);
    const names = (i: number) => ({ 0: "Concordium testnet IP", 4: "Global FinReg Testnet" })[i];
    const lookup = lookupOf(person, company);
    expect(await classifyAccount(lookup, names, person.address)).toEqual({ kind: "person", idpIndex: 0, idpName: "Concordium testnet IP" });
    expect(await classifyAccount(lookup, names, company.address)).toEqual({ kind: "company", idpIndex: 4, idpName: "Global FinReg Testnet" });
  });
});

describe("badge check", () => {
  it("accepts a valid verdict and returns token id and owner", async () => {
    const r = await checkBadge(fetchReturning(json(200, validVerdict("OWNER", 9))), "https://api", "JyP9TestBadge");
    expect(r).toEqual({ ok: true, tokenId: 9n, owner: "OWNER", agentUri: invalidVerdict.agent_uri });
  });

  it("queries testnet explicitly", async () => {
    let url = "";
    const spy = (async (u: string) => {
      url = u;
      return json(200, validVerdict("OWNER"));
    }) as unknown as typeof fetch;
    await checkBadge(spy, "https://api", "JyP9 x");
    expect(url).toBe("https://api/v1/check-badge/JyP9%20x?network=testnet");
  });

  it("refuses an invalid verdict with the first issue as the reason", async () => {
    const r = await checkBadge(fetchReturning(json(200, invalidVerdict)), "https://api", "JyP9TrQ");
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("card URL did not return HTTP 200") });
  });

  it("badge_revoked_409_rejected", async () => {
    const r = await checkBadge(fetchReturning(json(409, { error: "revoked", message: "agent revoked" })), "https://api", "b");
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/revoked/) });
  });

  it("badge_404_rejected", async () => {
    const r = await checkBadge(fetchReturning(json(404, { error: "not_found", message: "No agent" })), "https://api", "b");
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/no agent/i) });
  });

  it("badge_429_returns_retryAfter_not_ok", async () => {
    const r = await checkBadge(fetchReturning(json(429, { error: "rate_limited" }, { "retry-after": "12" })), "https://api", "b");
    expect(r).toEqual({ ok: false, unavailable: true, retryAfter: 12, reason: expect.stringMatching(/retry after 12 s/) });
  });

  it("badge_timeout_returns_unavailable", async () => {
    const hanging = (async (_u: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)))) as unknown as typeof fetch;
    const r = await checkBadge(hanging, "https://api", "b", { timeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, unavailable: true });
  });

  it("treats a 5xx as unavailable, not as a pass", async () => {
    const r = await checkBadge(fetchReturning(new Response("boom", { status: 502 })), "https://api", "b");
    expect(r).toMatchObject({ ok: false, unavailable: true });
  });
});

describe("verifyAgent", () => {
  const nonce = "n-42";
  const msg = challengeMessage(nonce);

  it("accepts the agent wallet's signature and pays that wallet", async () => {
    const owner = testAccount(1);
    const wallet = testAccount(3);
    const r = await verifyAgent(
      {
        fetch: fetchReturning(json(200, validVerdict(owner.address, 9))),
        badgeApi: "https://api",
        lookup: lookupOf(owner, wallet),
        agentWallet: async () => wallet.address,
      },
      { badge: "JyP9TestBadge", message: msg, signature: await wallet.sign(msg) },
    );
    expect(r).toEqual({ ok: true, tokenId: 9n, owner: owner.address, payoutAccount: wallet.address });
  });

  it("falls back to the owner when no agent wallet is set", async () => {
    const owner = testAccount(1);
    const r = await verifyAgent(
      { fetch: fetchReturning(json(200, validVerdict(owner.address))), badgeApi: "https://api", lookup: lookupOf(owner), agentWallet: async () => null },
      { badge: "JyP9TestBadge", message: msg, signature: await owner.sign(msg) },
    );
    expect(r).toMatchObject({ ok: true, payoutAccount: owner.address });
  });

  it("agent_signature_from_other_account_rejected (a copied badge does not pass)", async () => {
    const owner = testAccount(1);
    const thief = testAccount(2);
    const r = await verifyAgent(
      { fetch: fetchReturning(json(200, validVerdict(owner.address))), badgeApi: "https://api", lookup: lookupOf(owner, thief), agentWallet: async () => null },
      { badge: "JyP9TestBadge", message: msg, signature: await thief.sign(msg) },
    );
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/signature/) });
  });

  it("does not check signatures for an invalid badge", async () => {
    const owner = testAccount(1);
    const r = await verifyAgent(
      { fetch: fetchReturning(json(200, invalidVerdict)), badgeApi: "https://api", lookup: lookupOf(owner), agentWallet: async () => null },
      { badge: "JyP9TestBadge", message: msg, signature: await owner.sign(msg) },
    );
    expect(r.ok).toBe(false);
  });
});

describe("payout eligibility", () => {
  it("not_on_allow_list_refused_with_faucet_url", async () => {
    const r = await checkPayoutEligible(async () => false, "acct", "https://faucet.example");
    expect(r).toEqual({ ok: false, faucetUrl: "https://faucet.example", reason: expect.stringMatching(/allow list/) });
    expect(await checkPayoutEligible(async () => true, "acct", "https://faucet.example")).toEqual({ ok: true });
  });
});

describe("attestor", () => {
  const seed = "07".repeat(32);
  const contract = { index: 1234n, subindex: 0n };

  it("attestation_verifies_with_contract_vectors", () => {
    const attestor = new Attestor(seed, () => 1_000n);
    const poster = testAccount(7).address;
    const a = attestor.attestPost({ contract, poster, posterAgent: 5n, kind: "Contest", specHash: new Uint8Array(32).fill(0xab), reward: 7n, deadline: 9n }, 60_000n);
    expect(a.expiry).toBe(61_000n);
    const msg = postAttestationBytes({ contract, poster, posterAgent: 5n, kind: "Contest", specHash: new Uint8Array(32).fill(0xab), reward: 7n, deadline: 9n, expiry: a.expiry });
    const pub = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(attestor.publicKeyHex, "hex")]), format: "der", type: "spki" });
    expect(verify(null, msg, pub, Buffer.from(a.signatureHex, "hex"))).toBe(true);

    const w = attestor.attestWork({ kind: "enter", contract, bountyId: 42n, worker: poster, agent: null }, 60_000n);
    const wmsg = workAttestationBytes({ kind: "enter", contract, bountyId: 42n, worker: poster, agent: null, expiry: w.expiry });
    expect(verify(null, wmsg, pub, Buffer.from(w.signatureHex, "hex"))).toBe(true);
  });

  it("refuses a seed that is not 32 bytes", () => {
    expect(() => new Attestor("abcd")).toThrow(/32 bytes/);
  });
});
