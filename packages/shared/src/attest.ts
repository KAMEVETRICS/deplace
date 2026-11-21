import { AccountAddress } from "@concordium/web-sdk";
import type { ContractRef } from "./types.js";

/**
 * Messages the board's attestor key signs, and the bounty_board contract verifies.
 *
 * Layout: ASCII domain tag (not length-prefixed) followed by the Concordium binary
 * serialization of the struct: ContractAddress = u64 LE index + u64 LE subindex,
 * AccountAddress = 32 raw bytes, Option = tag byte 0/1 then the value, u64 and
 * Timestamp (ms) = 8 bytes LE, [u8; 32] = 32 raw bytes.
 * Must stay byte-identical to contracts/bounty-board/src/attest.rs.
 */
export const DOMAIN = {
  post: "BountyBoard/v1/post",
  claim: "BountyBoard/v1/claim",
  enter: "BountyBoard/v1/enter",
} as const;

export interface PostAttestation {
  contract: ContractRef;
  /** Base58 account address of the poster (the transaction sender). */
  poster: string;
  /** Agent Registry token id when the poster acts as a registered agent. */
  posterAgent: bigint | null;
  /** SHA-256 of the bounty spec JSON stored off-chain. */
  specHash: Uint8Array;
  /** Unix time in ms after which the contract refuses the attestation. */
  expiry: bigint;
}

export interface WorkAttestation {
  kind: "claim" | "enter";
  contract: ContractRef;
  bountyId: bigint;
  /** Base58 account address of the worker (the transaction sender). */
  worker: string;
  agent: bigint | null;
  expiry: bigint;
}

const U64_MAX = 2n ** 64n - 1n;

class Writer {
  private parts: number[] = [];
  ascii(s: string) {
    for (const c of s) this.parts.push(c.charCodeAt(0));
  }
  u64(name: string, v: bigint) {
    if (v < 0n || v > U64_MAX) throw new RangeError(`${name} must fit in u64, got ${v}`);
    for (let i = 0n; i < 8n; i++) this.parts.push(Number((v >> (8n * i)) & 0xffn));
  }
  bytes(b: Uint8Array) {
    for (const x of b) this.parts.push(x);
  }
  contract(c: ContractRef) {
    this.u64("contract index", c.index);
    this.u64("contract subindex", c.subindex);
  }
  account(base58: string) {
    this.bytes(AccountAddress.fromBase58(base58).decodedAddress);
  }
  optionU64(name: string, v: bigint | null) {
    if (v === null) this.parts.push(0);
    else {
      this.parts.push(1);
      this.u64(name, v);
    }
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

export function postAttestationBytes(a: PostAttestation): Uint8Array {
  if (a.specHash.length !== 32) throw new RangeError(`specHash must be 32 bytes, got ${a.specHash.length}`);
  const w = new Writer();
  w.ascii(DOMAIN.post);
  w.contract(a.contract);
  w.account(a.poster);
  w.optionU64("posterAgent", a.posterAgent);
  w.bytes(a.specHash);
  w.u64("expiry", a.expiry);
  return w.done();
}

export function workAttestationBytes(a: WorkAttestation): Uint8Array {
  const w = new Writer();
  w.ascii(DOMAIN[a.kind]);
  w.contract(a.contract);
  w.u64("bountyId", a.bountyId);
  w.account(a.worker);
  w.optionU64("agent", a.agent);
  w.u64("expiry", a.expiry);
  return w.done();
}
