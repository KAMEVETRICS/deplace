import { describe, expect, it } from "vitest";
import { SequenceNumber } from "@concordium/web-sdk";
import type { ConcordiumGRPCNodeClient } from "@concordium/web-sdk/nodejs";
import { AgentChain } from "../src/chain.js";

const DEPLACE = { index: 13001n, subindex: 0n };
/** POSTED_EVENT_VECTOR from packages/shared/test/codec.test.ts: bounty 0, reward 100, spec hash ab…ab. */
const POSTED = "00" + "0000000000000000" + "03".repeat(32) + "00" + "00" + "6400000000000000" + "ab".repeat(32) + "0807060504030201";

const stub = (methods: Partial<Record<keyof ConcordiumGRPCNodeClient, unknown>>) => methods as unknown as ConcordiumGRPCNodeClient;
const chainWith = (methods: Partial<Record<keyof ConcordiumGRPCNodeClient, unknown>>) => new AgentChain("unused", 1, DEPLACE, stub(methods));
const finalized = (summary: unknown) => ({ getBlockItemStatus: async () => ({ status: "finalized", outcome: { blockHash: "00".repeat(32), summary } }) });

describe("chain lookups", () => {
  it("reports a transaction the node doesn't know as absent", async () => {
    const chain = chainWith({
      getBlockItemStatus: async () => {
        throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
      },
    });
    expect(await chain.txOutcome("aa".repeat(32))).toEqual({ state: "absent" });
  });

  it("reports received and committed transactions as pending", async () => {
    expect(await chainWith({ getBlockItemStatus: async () => ({ status: "received" }) }).txOutcome("aa".repeat(32))).toEqual({ state: "pending" });
    expect(await chainWith({ getBlockItemStatus: async () => ({ status: "committed", outcomes: [] }) }).txOutcome("aa".repeat(32))).toEqual({ state: "pending" });
  });

  it("decodes the Deplace events of a finalized update and ignores other contracts", async () => {
    const chain = chainWith(
      finalized({
        type: "accountTransaction",
        transactionType: "update",
        events: [
          { tag: "Updated", address: DEPLACE, events: [POSTED] },
          { tag: "Updated", address: { index: 1n, subindex: 0n }, events: [POSTED] },
        ],
      }),
    );
    const out = await chain.txOutcome("aa".repeat(32));
    expect(out).toMatchObject({ state: "finalized", failed: false });
    expect(out.state === "finalized" && out.events).toEqual([expect.objectContaining({ type: "Posted", id: 0n, reward: 100n, specHash: "ab".repeat(32) })]);
  });

  it("marks a finalized transaction that failed", async () => {
    const chain = chainWith(finalized({ type: "accountTransaction", transactionType: "failed", rejectReason: { tag: "RejectedReceive" } }));
    expect(await chain.txOutcome("aa".repeat(32))).toEqual({ state: "finalized", failed: true, events: [] });
  });

  it("passes on lookup errors other than not found", async () => {
    const chain = chainWith({
      getBlockItemStatus: async () => {
        throw Object.assign(new Error("node down"), { code: "UNAVAILABLE" });
      },
    });
    await expect(chain.txOutcome("aa".repeat(32))).rejects.toThrow(/node down/);
  });

  it("reads the chain's last finalized time, and refuses to guess when the node gives none", async () => {
    expect(await chainWith({ getConsensusStatus: async () => ({ lastFinalizedTime: new Date(1_800_000_000_000) }) }).lastFinalizedTime()).toBe(1_800_000_000_000);
    await expect(chainWith({ getConsensusStatus: async () => ({}) }).lastFinalizedTime()).rejects.toThrow(/finalized time/);
  });

  it("reads the account's finalized next nonce", async () => {
    const chain = chainWith({ getAccountInfo: async () => ({ accountNonce: SequenceNumber.create(7) }) });
    expect(await chain.finalizedNonce("4S3UrfhQbefa5SmR9qFsfTdVqYpSN9s4DVcmyVjTbNkoDtMxGs")).toBe(7n);
  });
});
