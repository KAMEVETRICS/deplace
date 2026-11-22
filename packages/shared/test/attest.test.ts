import { describe, expect, it } from "vitest";
import { AccountAddress } from "@concordium/web-sdk";
import { postAttestationBytes, workAttestationBytes } from "../src/attest.js";

// Golden vectors. The Rust contract tests (contracts/bounty-board/tests/core.rs)
// encode the same inputs and assert the same hex, so the two sides cannot drift.
const contract = { index: 1234n, subindex: 0n };
const poster = AccountAddress.fromBuffer(new Uint8Array(32).fill(7).buffer).address;
const worker = AccountAddress.fromBuffer(new Uint8Array(32).fill(9).buffer).address;
const specHash = new Uint8Array(32).fill(0xab);
const expiry = 0x0102030405060708n;

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const CONTRACT_HEX = "d204000000000000" + "0000000000000000";
const EXPIRY_HEX = "0807060504030201";

export const POST_VECTOR =
  "426f756e7479426f6172642f76312f706f7374" + // "BountyBoard/v1/post"
  CONTRACT_HEX +
  "07".repeat(32) + // poster
  "01" + "0500000000000000" + // poster_agent = Some(5)
  "00" + // kind = Exclusive
  "ab".repeat(32) + // spec_hash
  "6400000000000000" + // reward = 100
  "0200000000000000" + // deadline = 2
  EXPIRY_HEX;

export const CLAIM_VECTOR =
  "426f756e7479426f6172642f76312f636c61696d" + // "BountyBoard/v1/claim"
  CONTRACT_HEX +
  "2a00000000000000" + // bounty_id = 42
  "09".repeat(32) + // worker
  "00" + // agent = None
  EXPIRY_HEX;

export const ENTER_VECTOR =
  "426f756e7479426f6172642f76312f656e746572" + // "BountyBoard/v1/enter"
  CONTRACT_HEX +
  "2a00000000000000" +
  "09".repeat(32) +
  "01" + "0700000000000000" + // agent = Some(7)
  EXPIRY_HEX;

describe("attestation bytes", () => {
  it("encodes a post attestation as domain || serial(struct)", () => {
    const bytes = postAttestationBytes({ contract, poster, posterAgent: 5n, kind: "Exclusive", specHash, reward: 100n, deadline: 2n, expiry });
    expect(hex(bytes)).toBe(POST_VECTOR);
  });

  it("encodes a claim attestation without an agent", () => {
    const bytes = workAttestationBytes({ kind: "claim", contract, bountyId: 42n, worker, agent: null, expiry });
    expect(hex(bytes)).toBe(CLAIM_VECTOR);
  });

  it("encodes an enter attestation with an agent", () => {
    const bytes = workAttestationBytes({ kind: "enter", contract, bountyId: 42n, worker, agent: 7n, expiry });
    expect(hex(bytes)).toBe(ENTER_VECTOR);
  });

  it("binds the attestation to the contract address", () => {
    const a = postAttestationBytes({ contract, poster, posterAgent: null, kind: "Exclusive", specHash, reward: 100n, deadline: 2n, expiry });
    const b = postAttestationBytes({ contract: { index: 1235n, subindex: 0n }, poster, posterAgent: null, kind: "Exclusive", specHash, reward: 100n, deadline: 2n, expiry });
    expect(hex(a)).not.toBe(hex(b));
  });

  it("rejects a spec hash that is not 32 bytes", () => {
    expect(() => postAttestationBytes({ contract, poster, posterAgent: null, kind: "Exclusive", specHash: new Uint8Array(31), reward: 100n, deadline: 2n, expiry })).toThrow(/32 bytes/);
  });

  it("rejects values outside u64", () => {
    expect(() => workAttestationBytes({ kind: "claim", contract, bountyId: -1n, worker, agent: null, expiry })).toThrow(/u64/);
    expect(() => workAttestationBytes({ kind: "claim", contract, bountyId: 2n ** 64n, worker, agent: null, expiry })).toThrow(/u64/);
  });
});
