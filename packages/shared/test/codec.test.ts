import { describe, expect, it } from "vitest";
import { AccountAddress } from "@concordium/web-sdk";
import {
  contractErrorName,
  decodeConfig,
  decodeEvent,
  decodeOptionBounty,
  decodeSplit,
  decodeStats,
  encodeClaim,
  encodeInit,
  encodePost,
  encodeRecordPayout,
  encodeU64,
} from "../src/codec.js";

// Golden vectors shared with contracts/bounty-board/tests/codec.rs.
const acct = (fill: number) => AccountAddress.fromBuffer(new Uint8Array(32).fill(fill).buffer).address;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

export const BOUNTY_VECTOR =
  "01" + // Some
  "0700000000000000" + // id 7
  "03".repeat(32) + // poster
  "01" + "0500000000000000" + // poster_agent Some(5)
  "01" + // kind Contest
  "ab".repeat(32) + // spec_hash
  "6400000000000000" + // reward 100
  "01" + "11".repeat(32) + // Escrowed { funding_tx }
  "0807060504030201" + // deadline
  "02" + "04".repeat(32) + "00" + "cd".repeat(32) + "0900000000000000" + // Submitted { worker, agent None, work_hash, at 9 }
  "02" + // rejections
  "01" + "0800000000000000" + // last_rejected_at Some(8)
  "03000000" + // entry_count
  "0100000000000000"; // created

export const PAYOUT_EVENT_VECTOR = "0a" + "0700000000000000" + "04".repeat(32) + "6400000000000000" + "22".repeat(32);

export const POSTED_EVENT_VECTOR =
  "00" + "0000000000000000" + "03".repeat(32) + "00" + "00" + "6400000000000000" + "ab".repeat(32) + "0807060504030201";

export const RECORD_PAYOUT_VECTOR =
  "0700000000000000" +
  "02000000" +
  "04".repeat(32) + "2200000000000000" + "11".repeat(32) +
  "05".repeat(32) + "2100000000000000" + "22".repeat(32);

describe("codec", () => {
  it("decodes Option<Bounty>", () => {
    expect(decodeOptionBounty(bytes(BOUNTY_VECTOR))).toEqual({
      id: 7n,
      poster: acct(3),
      posterAgent: 5n,
      kind: "Contest",
      specHash: "ab".repeat(32),
      reward: 100n,
      funding: { type: "Escrowed", fundingTx: "11".repeat(32) },
      deadline: 0x0102030405060708n,
      status: { type: "Submitted", worker: acct(4), agent: null, workHash: "cd".repeat(32), at: 9n },
      rejections: 2,
      lastRejectedAt: 8n,
      entryCount: 3,
      created: 1n,
    });
    expect(decodeOptionBounty(bytes("00"))).toBeNull();
  });

  it("decodes Accepted and AcceptedUnpaid with the accepted work hash", () => {
    const submitted = "02" + "04".repeat(32) + "00" + "cd".repeat(32) + "0900000000000000";
    const accepted = "03" + "04".repeat(32) + "0900000000000000" + "cd".repeat(32);
    const unpaid = "07" + "04".repeat(32) + "cd".repeat(32);
    expect(decodeOptionBounty(bytes(BOUNTY_VECTOR.replace(submitted, accepted)))?.status).toEqual({
      type: "Accepted",
      worker: acct(4),
      at: 9n,
      workHash: "cd".repeat(32),
    });
    expect(decodeOptionBounty(bytes(BOUNTY_VECTOR.replace(submitted, unpaid)))?.status).toEqual({
      type: "AcceptedUnpaid",
      worker: acct(4),
      workHash: "cd".repeat(32),
    });
  });

  it("refuses trailing bytes", () => {
    expect(() => decodeOptionBounty(bytes(BOUNTY_VECTOR + "00"))).toThrow(/trailing/);
  });

  it("decodes events", () => {
    expect(decodeEvent(bytes(PAYOUT_EVENT_VECTOR))).toEqual({ type: "PayoutRecorded", id: 7n, to: acct(4), amount: 100n, tx: "22".repeat(32) });
    expect(decodeEvent(bytes(POSTED_EVENT_VECTOR))).toEqual({
      type: "Posted",
      id: 0n,
      poster: acct(3),
      posterAgent: null,
      kind: "Exclusive",
      reward: 100n,
      specHash: "ab".repeat(32),
      deadline: 0x0102030405060708n,
    });
  });

  it("rejects an unknown event tag", () => {
    expect(() => decodeEvent(bytes("ff"))).toThrow(/tag/);
  });

  it("encodes record_payout parameters", () => {
    const p = encodeRecordPayout(7n, [
      { to: acct(4), amount: 34n, tx: "11".repeat(32) },
      { to: acct(5), amount: 33n, tx: "22".repeat(32) },
    ]);
    expect(hex(p)).toBe(RECORD_PAYOUT_VECTOR);
  });

  it("encodes post and claim parameters", () => {
    const sig = "ee".repeat(64);
    expect(
      hex(
        encodePost({
          kind: "Exclusive",
          posterAgent: null,
          specHash: "ab".repeat(32),
          reward: 100n,
          deadline: 2n,
          attestationExpiry: 3n,
          signature: sig,
        }),
      ),
    ).toBe("00" + "00" + "ab".repeat(32) + "6400000000000000" + "0200000000000000" + "0300000000000000" + sig);
    expect(hex(encodeClaim({ id: 1n, agent: 9n, attestationExpiry: 3n, signature: sig }))).toBe(
      "0100000000000000" + "01" + "0900000000000000" + "0300000000000000" + sig,
    );
    expect(hex(encodeU64(42n))).toBe("2a00000000000000");
  });

  it("decodes stats and split shares", () => {
    expect(decodeStats(bytes("01000000" + "02000000" + "03000000" + "04000000" + "05000000" + "06000000"))).toEqual({
      posted: 1,
      paidAsPoster: 2,
      unpaid: 3,
      rejectedFinal: 4,
      noAward: 5,
      paidAsWorker: 6,
    });
    expect(decodeSplit(bytes("01000000" + "04".repeat(32) + "2200000000000000"))).toEqual([{ to: acct(4), amount: 34n }]);
  });

  it("decodes the config view", () => {
    const h =
      "01".repeat(32) + "02".repeat(32) + "aa".repeat(32) + "0232000000000000" + "0000000000000000" +
      "06000000" + Buffer.from("EUDemo").toString("hex") + "60ea000000000000" + "c0d4010000000000" + "0500000000000000";
    expect(decodeConfig(bytes(h))).toEqual({
      admin: acct(1),
      operator: acct(2),
      attestorHex: "aa".repeat(32),
      registry: { index: 12802n, subindex: 0n },
      rewardToken: "EUDemo",
      reviewWindowMs: 60_000n,
      paymentWindowMs: 120_000n,
      nextId: 5n,
    });
  });

  it("encodes init parameters as the config layout without next_id", () => {
    const init = encodeInit({
      admin: acct(1),
      operator: acct(2),
      attestorHex: "aa".repeat(32),
      registry: { index: 12802n, subindex: 0n },
      rewardToken: "EUDemo",
      reviewWindowMs: 60_000n,
      paymentWindowMs: 120_000n,
    });
    expect(hex(init)).toBe(
      "01".repeat(32) + "02".repeat(32) + "aa".repeat(32) + "0232000000000000" + "0000000000000000" +
        "06000000" + Buffer.from("EUDemo").toString("hex") + "60ea000000000000" + "c0d4010000000000",
    );
  });

  it("names contract reject codes (same table as tests/codec.rs)", () => {
    expect(contractErrorName(-1)).toBe("ParseError");
    expect(contractErrorName(-3)).toBe("Unauthorized");
    expect(contractErrorName(-13)).toBe("NotFound");
    expect(contractErrorName(-17)).toBe("Overflow");
    expect(contractErrorName(-99)).toBe("reject code -99");
  });

  it("refuses a hex value of the wrong length", () => {
    expect(() => encodeU64(-1n)).toThrow(/u64/);
    expect(() => encodeClaim({ id: 1n, agent: null, attestationExpiry: 3n, signature: "ee" })).toThrow(/64 bytes/);
  });
});
