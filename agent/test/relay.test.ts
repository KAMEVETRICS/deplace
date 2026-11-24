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
import { encodeClaim, type BoardEvent } from "@deplace/shared";
import type { TxOutcome } from "../src/chain.js";
import { KitError } from "../src/kit/errors.js";
import { Relay, type RelayBoard } from "../src/kit/relay.js";
import { SpendBudget } from "../src/rails/budget.js";
import { RailViolation } from "../src/rails/guard.js";
import { AccountLock } from "../src/rails/lock.js";
import { PendingStore } from "../src/rails/pending.js";
import { transactionHash, type AgentKeys } from "../src/signer.js";
import type { SendStep } from "../src/steps.js";
import type { Relayed } from "../src/worker.js";

const addr = (fill: number) => AccountAddress.fromBuffer(new Uint8Array(32).fill(fill).buffer).address;
function keys(fill: number): AgentKeys {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyHex = privateKey.export({ format: "der", type: "pkcs8" }).subarray(16).toString("hex");
  return { address: addr(fill), privateKeyHex, signer: buildBasicAccountSigner(privateKeyHex) };
}
const me = keys(1);
const DEPLACE = { index: 13001n, subindex: 0n };
const SIG = "11".repeat(64);

/** A sponsored claim of `bountyId` for agent 1418, as prepare_claim returns it. */
function preparedClaim(bountyId: bigint, nonce = 1n) {
  const tx = Transaction.updateContract(
    {
      amount: CcdAmount.zero(),
      address: ContractAddress.create(DEPLACE.index, DEPLACE.subindex),
      receiveName: ReceiveName.fromString("deplace.claim"),
      message: Parameter.fromBuffer(encodeClaim({ id: bountyId, agent: 1418n, attestationExpiry: 1n, signature: SIG }).slice().buffer),
    },
    Energy.create(30_000n),
  )
    .addMetadata({ sender: AccountAddress.fromBase58(me.address), nonce: SequenceNumber.create(nonce), expiry: TransactionExpiry.futureMinutes(5) })
    .addSponsor(AccountAddress.fromBase58(addr(3)))
    .build();
  return { prepared: { txJson: Transaction.toJSONString(tx) } };
}
const claimStep = (bountyId: string, onSigned?: SendStep["onSigned"]): SendStep => ({
  action: "claim",
  bountyId,
  expected: { entrypoint: "claim", bountyId: BigInt(bountyId), agent: 1418n },
  onSigned,
});

const CLAIMED: BoardEvent = { type: "Claimed", id: 5n, worker: me.address, agent: 1418n };
const answer = (txJson: string, events: Relayed["events"] = [{ type: "Claimed", id: "5" }]): Relayed => ({ txHash: transactionHash(txJson), link: "l", events });

interface WorldOptions {
  /** What board.relay does with a signed transaction. Default: lands it and answers with its hash. */
  relay?: (txJson: string, w: World) => Promise<Relayed>;
  contract?: { index: string; subindex: string };
  nonce?: bigint;
}
type World = ReturnType<typeof world>;

function world(o: WorldOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-"));
  let t = Date.now();
  const clock = { now: () => t, advance: (ms: number) => void (t += ms) };
  const outcomes = new Map<string, TxOutcome>();
  const log: string[] = [];
  const budget = new SpendBudget(join(dir, "budget.json"), { maxPerBounty: 5_000_000n, dailyCap: 20_000_000n }, clock.now);
  const pending = new PendingStore(join(dir, "pending.json"));
  const w = {
    dir,
    clock,
    outcomes,
    log,
    budget,
    pending,
    nonce: o.nonce ?? 7n,
    relayed: [] as string[],
    board: null as unknown as RelayBoard,
    lock: new AccountLock(join(dir, "agent.lock"), { pid: 200, isAlive: () => true }),
  };
  w.board = {
    relay: async (txJson: string) => {
      if (o.relay) return o.relay(txJson, w);
      w.relayed.push(txJson);
      const hash = transactionHash(txJson);
      outcomes.set(hash, { state: "finalized", failed: false, events: [CLAIMED] });
      return { txHash: hash, link: `https://ccdexplorer.io/testnet/transaction/${hash}`, events: [{ type: "Claimed", id: "5" }] };
    },
    config: async () => ({ contract: o.contract ?? { index: "13001", subindex: "0" }, escrowAccount: addr(4), rewardToken: "EUDemo", decimals: 6, faucetUrl: null }),
  };
  return w;
}

function relayFor(w: World) {
  return new Relay({
    board: w.board,
    keys: me,
    guard: { account: me.address, contract: DEPLACE, allowFees: false },
    chain: { txOutcome: async (hash) => w.outcomes.get(hash) ?? { state: "absent" }, finalizedNonce: async () => w.nonce },
    pending: w.pending,
    lock: w.lock,
    budget: async () => w.budget,
    now: w.clock.now,
    log: (m) => w.log.push(m),
  });
}

const lostAnswer = async (txJson: string, w: World) => {
  // The transaction reached the chain, but the board's answer never came back.
  w.relayed.push(txJson);
  w.outcomes.set(transactionHash(txJson), { state: "finalized", failed: false, events: [] });
  throw new KitError("the transaction was sent but the board's answer was lost", true, { outcomeUnknown: true });
};
const neverSent = async () => {
  throw new KitError("could not reach the board to send the transaction; it was not sent", true);
};

describe("the kit's relay", () => {
  it("signs and relays a checked call, leaving no pending record", async () => {
    const w = world();
    const relay = relayFor(w);
    const r = await relay.turn(() => relay.send(preparedClaim(5n), claimStep("5")));
    expect(r.link).toMatch(/ccdexplorer/);
    expect(w.relayed).toHaveLength(1);
    expect(w.pending.list()).toEqual([]);
  });

  it("writes the pending record before the transaction is sent", async () => {
    let seen: unknown[] = [];
    const w = world({
      relay: async (txJson, w) => {
        seen = w.pending.list();
        return answer(txJson);
      },
    });
    const relay = relayFor(w);
    await relay.turn(() => relay.send(preparedClaim(5n), claimStep("5")));
    expect(seen).toEqual([expect.objectContaining({ kind: "tx", action: "claim", bountyId: "5", hash: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
  });

  it("keeps the record when the answer is lost, and a new Relay finds the transaction on chain", async () => {
    const w = world({ relay: lostAnswer });
    const relay = relayFor(w);
    await expect(relay.turn(() => relay.send(preparedClaim(5n), claimStep("5")))).rejects.toMatchObject({ retryable: true, extra: { outcomeUnknown: true } });
    expect(w.pending.list()).toHaveLength(1);

    const restarted = relayFor({ ...w, pending: new PendingStore(join(w.dir, "pending.json")) });
    const settled = await restarted.turn(() => restarted.settle((r) => r.action === "claim" && r.bountyId === "5"));
    expect(settled).toEqual([expect.objectContaining({ landed: true, failed: false, link: expect.stringMatching(/ccdexplorer/) })]);
    expect(new PendingStore(join(w.dir, "pending.json")).list()).toEqual([]);
    expect(w.relayed).toHaveLength(1);
  });

  it("settles a lost transaction as not landed only after it expired", async () => {
    const w = world({ relay: neverSent });
    const relay = relayFor(w);
    await expect(relay.turn(() => relay.send(preparedClaim(5n), claimStep("5")))).rejects.toBeInstanceOf(KitError);
    const early = await relay.turn(() => relay.settle(() => true)).catch((e) => e);
    expect(early).toBeInstanceOf(KitError);
    expect(early).toMatchObject({ retryable: true, extra: { retryAfter: expect.any(String) } });
    w.clock.advance(6 * 60_000);
    expect(await relay.turn(() => relay.settle(() => true))).toEqual([expect.objectContaining({ landed: false })]);
    expect(w.pending.list()).toEqual([]);
  });

  it("takes turns: two sends at once never overlap", async () => {
    const events: string[] = [];
    const w = world({
      relay: async (txJson) => {
        const hash = transactionHash(txJson);
        events.push(`start ${hash.slice(0, 6)}`);
        await new Promise((r) => setTimeout(r, 20));
        events.push(`end ${hash.slice(0, 6)}`);
        return answer(txJson);
      },
    });
    const relay = relayFor(w);
    await Promise.all([relay.turn(() => relay.send(preparedClaim(5n, 1n), claimStep("5"))), relay.turn(() => relay.send(preparedClaim(6n, 2n), claimStep("6")))]);
    expect(events.map((e) => e.split(" ")[0])).toEqual(["start", "end", "start", "end"]);
  });

  it("keeps taking turns after one fails", async () => {
    const w = world();
    const relay = relayFor(w);
    await expect(relay.turn(async () => Promise.reject(new Error("boom")))).rejects.toThrow(/boom/);
    await expect(relay.turn(() => relay.send(preparedClaim(5n), claimStep("5")))).resolves.toBeDefined();
  });

  it("refuses to sign while another process holds the account's lock", async () => {
    const w = world();
    new AccountLock(w.lock.file, { pid: 100, isAlive: () => true }).acquire();
    const relay = relayFor(w);
    const failure = await relay.turn(() => relay.send(preparedClaim(5n), claimStep("5"))).catch((e) => e);
    expect(failure).toBeInstanceOf(KitError);
    expect(failure.message).toMatch(/pid 100/);
    expect(w.relayed).toEqual([]);
  });

  it("refuses to sign for a board that names another contract", async () => {
    const w = world({ contract: { index: "99", subindex: "0" } });
    const relay = relayFor(w);
    await expect(relay.turn(() => relay.send(preparedClaim(5n), claimStep("5")))).rejects.toBeInstanceOf(RailViolation);
    expect(w.relayed).toEqual([]);
  });

  it("stops signing after the board names a transaction by another hash", async () => {
    const w = world({ relay: async () => ({ txHash: "ff".repeat(32), link: "l", events: [{ type: "Claimed", id: "5" }] }) });
    const relay = relayFor(w);
    await relay.turn(() => relay.send(preparedClaim(5n), claimStep("5"))); // it went through; the kit can no longer track its transactions
    await expect(relay.turn(() => relay.send(preparedClaim(6n, 2n), claimStep("6")))).rejects.toBeInstanceOf(RailViolation);
  });

  it("reports a transaction the contract rejected, and frees the commitment written for it", async () => {
    const w = world({
      relay: async (txJson, w) => {
        w.outcomes.set(transactionHash(txJson), { state: "finalized", failed: true, events: [] });
        return answer(txJson, []); // the board answers a rejected transaction like any other
      },
    });
    const relay = relayFor(w);
    const step = claimStep("5", (hash) => {
      w.budget.commit(`post-tx:${hash}`, 1_000_000n);
      return `post-tx:${hash}`;
    });
    const failure = await relay.turn(() => relay.send(preparedClaim(5n), step)).catch((e) => e);
    expect(failure).toBeInstanceOf(KitError);
    expect(failure).toMatchObject({ retryable: false, extra: { rejectedOnChain: true } });
    expect(w.pending.list()).toEqual([]);
    expect(w.budget.spentLast24h()).toBe(0n);
  });

  it("takes the chain's events when the board's answer leaves them out", async () => {
    const w = world({
      relay: async (txJson, w) => {
        w.outcomes.set(transactionHash(txJson), { state: "finalized", failed: false, events: [CLAIMED] });
        return answer(txJson, []);
      },
    });
    const relay = relayFor(w);
    const r = await relay.turn(() => relay.send(preparedClaim(5n), claimStep("5")));
    expect(r.events).toEqual([{ type: "Claimed", id: "5" }]);
    expect(w.pending.list()).toEqual([]);
  });

  it("keeps the record when neither the board nor the chain shows the outcome yet", async () => {
    const w = world({ relay: async (txJson) => answer(txJson, []) }); // the kit's node hasn't seen it yet
    const relay = relayFor(w);
    expect(await relay.turn(() => relay.send(preparedClaim(5n), claimStep("5"))).catch((e) => e)).toMatchObject({ retryable: true, extra: { outcomeUnknown: true } });
    expect(w.pending.list()).toHaveLength(1);
  });

  it("moves a landed post's commitment to its bounty and drops an unsent one's", async () => {
    const w = world();
    const relay = relayFor(w);
    const posted: BoardEvent = { type: "Posted", id: 9n, poster: me.address, posterAgent: 1418n, kind: "Exclusive", reward: 1_000_000n, specHash: "ab".repeat(32), deadline: 0n };
    w.budget.commit("post-tx:aa", 1_000_000n);
    w.budget.commit("post-tx:bb", 2_000_000n);
    w.pending.add({ kind: "tx", action: "post", bountyId: null, hash: "aa".repeat(32), expiresAt: w.clock.now() + 300_000, commitRef: "post-tx:aa" });
    w.pending.add({ kind: "tx", action: "post", bountyId: null, hash: "bb".repeat(32), expiresAt: w.clock.now() + 300_000, commitRef: "post-tx:bb" });
    w.outcomes.set("aa".repeat(32), { state: "finalized", failed: false, events: [posted] });
    w.clock.advance(301_000);
    const settled = await relay.turn(() => relay.settle((r) => r.action === "post"));
    expect(settled.map((s) => s.landed)).toEqual([true, false]);
    expect(w.budget.spentLast24h()).toBe(1_000_000n);
    expect(() => w.budget.reserve("bounty:9", 1_000_000n)).not.toThrow();
  });

  it("releases a lost payment's booking after its expiry when its nonce was never used", async () => {
    const w = world({ nonce: 7n });
    const relay = relayFor(w);
    w.budget.commit("bounty:9", 1_000_000n);
    w.budget.reserve("bounty:9", 1_000_000n);
    w.pending.add({ kind: "payment", purpose: "deliver", bountyId: "9", ref: "bounty:9", nonce: "7", amount: "1000000", expiresAt: w.clock.now() + 295_000 });
    w.clock.advance(300_000);
    expect(await relay.turn(async () => "turn ran")).toBe("turn ran");
    expect(() => w.budget.reserve("bounty:9", 1_000_000n)).not.toThrow();
    expect(w.pending.list()).toEqual([]);
  });

  it("keeps a lost payment's booking when its nonce was used", async () => {
    const w = world({ nonce: 8n });
    const relay = relayFor(w);
    w.budget.commit("bounty:9", 1_000_000n);
    w.budget.reserve("bounty:9", 1_000_000n);
    w.pending.add({ kind: "payment", purpose: "deliver", bountyId: "9", ref: "bounty:9", nonce: "7", amount: "1000000", expiresAt: w.clock.now() + 295_000 });
    w.clock.advance(300_000);
    await relay.turn(async () => "turn ran");
    expect(() => w.budget.reserve("bounty:9", 1n)).toThrow(/already paid/);
    expect(relay.landedPayments.has("9")).toBe(true);
    expect(w.pending.list()).toEqual([]);
  });

  it("signs nothing else while a payment is unresolved", async () => {
    const w = world();
    const relay = relayFor(w);
    w.pending.add({ kind: "payment", purpose: "deliver", bountyId: "9", ref: "bounty:9", nonce: "7", amount: "1000000", expiresAt: w.clock.now() + 295_000 });
    const failure = await relay.turn(() => relay.send(preparedClaim(5n), claimStep("5"))).catch((e) => e);
    expect(failure).toBeInstanceOf(KitError);
    expect(failure).toMatchObject({ retryable: true, extra: { retryAfter: expect.any(String) } });
    expect(w.relayed).toEqual([]);
  });
});
