import { AccountAddress } from "@concordium/web-sdk";
import type { Bounty, BountyKind, BountyStatus, Entry, Funding, Stats } from "./types.js";

/**
 * Binary codec for bounty_board parameters, return values and events, following the
 * Concordium serialization of the Rust types in contracts/bounty-board/src/state.rs:
 * integers little-endian, Option = tag 0/1 then value, enums = u8 tag then fields,
 * Vec = u32 length then items, AccountAddress and hashes = raw bytes.
 * Golden vectors in both test suites keep the two sides in step.
 */

const U64_MAX = 2n ** 64n - 1n;
const KINDS: BountyKind[] = ["Exclusive", "Contest"];

class Writer {
  private out: number[] = [];
  u8(v: number) {
    this.out.push(v & 0xff);
  }
  u32(v: number) {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new RangeError(`u32 out of range: ${v}`);
    for (let i = 0; i < 4; i++) this.out.push((v >>> (8 * i)) & 0xff);
  }
  u64(v: bigint) {
    if (v < 0n || v > U64_MAX) throw new RangeError(`u64 out of range: ${v}`);
    for (let i = 0n; i < 8n; i++) this.out.push(Number((v >> (8n * i)) & 0xffn));
  }
  hex(h: string, len: number, what: string) {
    if (!new RegExp(`^[0-9a-fA-F]{${len * 2}}$`).test(h)) throw new RangeError(`${what} must be ${len} bytes of hex`);
    for (let i = 0; i < len; i++) this.out.push(parseInt(h.slice(2 * i, 2 * i + 2), 16));
  }
  account(base58: string) {
    for (const b of AccountAddress.fromBase58(base58).decodedAddress) this.out.push(b);
  }
  optU64(v: bigint | null) {
    if (v === null) this.u8(0);
    else {
      this.u8(1);
      this.u64(v);
    }
  }
  done() {
    return Uint8Array.from(this.out);
  }
}

class Reader {
  private pos = 0;
  constructor(private readonly b: Uint8Array) {}
  private take(n: number): Uint8Array {
    if (this.pos + n > this.b.length) throw new RangeError("unexpected end of data");
    const s = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
  u8() {
    return this.take(1)[0]!;
  }
  u32() {
    const s = this.take(4);
    return (s[0]! | (s[1]! << 8) | (s[2]! << 16) | (s[3]! << 24)) >>> 0;
  }
  u64() {
    const s = this.take(8);
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(s[i]!);
    return v;
  }
  hex(n: number) {
    return Buffer.from(this.take(n)).toString("hex");
  }
  account() {
    return AccountAddress.fromBuffer(this.take(32).slice().buffer).address;
  }
  bool() {
    const v = this.u8();
    if (v > 1) throw new RangeError(`invalid bool ${v}`);
    return v === 1;
  }
  opt<T>(f: () => T): T | null {
    const tag = this.u8();
    if (tag === 0) return null;
    if (tag === 1) return f();
    throw new RangeError(`invalid Option tag ${tag}`);
  }
  end() {
    if (this.pos !== this.b.length) throw new RangeError(`trailing bytes: ${this.b.length - this.pos}`);
  }
}

function kind(r: Reader): BountyKind {
  const k = KINDS[r.u8()];
  if (!k) throw new RangeError("invalid Kind tag");
  return k;
}

function funding(r: Reader): Funding {
  const tag = r.u8();
  if (tag === 0) return { type: "NotFunded" };
  if (tag === 1) return { type: "Escrowed", fundingTx: r.hex(32) };
  throw new RangeError(`invalid Funding tag ${tag}`);
}

function status(r: Reader): BountyStatus {
  const tag = r.u8();
  switch (tag) {
    case 0:
      return { type: "Open" };
    case 1:
      return { type: "Claimed", worker: r.account(), agent: r.opt(() => r.u64()) };
    case 2:
      return { type: "Submitted", worker: r.account(), agent: r.opt(() => r.u64()), workHash: r.hex(32), at: r.u64() };
    case 3:
      return { type: "Accepted", worker: r.account(), at: r.u64() };
    case 4:
      return { type: "Awarded", entryId: r.u32(), at: r.u64() };
    case 5:
      return { type: "Splitting", at: r.u64() };
    case 6:
      return { type: "Paid" };
    case 7:
      return { type: "AcceptedUnpaid", worker: r.account() };
    case 8:
      return { type: "RejectedFinal" };
    case 9:
      return { type: "NoAward" };
    case 10:
      return { type: "Expired" };
    case 11:
      return { type: "Cancelled" };
    case 12:
      return { type: "Refunded" };
    default:
      throw new RangeError(`invalid Status tag ${tag}`);
  }
}

function bounty(r: Reader): Bounty {
  return {
    id: r.u64(),
    poster: r.account(),
    posterAgent: r.opt(() => r.u64()),
    kind: kind(r),
    specHash: r.hex(32),
    reward: r.u64(),
    funding: funding(r),
    deadline: r.u64(),
    status: status(r),
    rejections: r.u8(),
    lastRejectedAt: r.opt(() => r.u64()),
    entryCount: r.u32(),
    created: r.u64(),
  };
}

function whole<T>(bytes: Uint8Array, f: (r: Reader) => T): T {
  const r = new Reader(bytes);
  const v = f(r);
  r.end();
  return v;
}

// --- return values -----------------------------------------------------------

export const decodeOptionBounty = (b: Uint8Array): Bounty | null => whole(b, (r) => r.opt(() => bounty(r)));

export const decodeOptionEntry = (b: Uint8Array): Entry | null =>
  whole(b, (r) => r.opt(() => ({ worker: r.account(), agent: r.opt(() => r.u64()), workHash: r.hex(32), at: r.u64() })));

export const decodeStats = (b: Uint8Array): Stats =>
  whole(b, (r) => ({ posted: r.u32(), paidAsPoster: r.u32(), unpaid: r.u32(), rejectedFinal: r.u32(), noAward: r.u32(), paidAsWorker: r.u32() }));

export const decodeSplit = (b: Uint8Array): { to: string; amount: bigint }[] =>
  whole(b, (r) => Array.from({ length: r.u32() }, () => ({ to: r.account(), amount: r.u64() })));

export interface BoardConfig {
  admin: string;
  operator: string;
  attestorHex: string;
  registry: { index: bigint; subindex: bigint };
  rewardToken: string;
  reviewWindowMs: bigint;
  paymentWindowMs: bigint;
  nextId: bigint;
}

export const decodeConfig = (b: Uint8Array): BoardConfig =>
  whole(b, (r) => ({
    admin: r.account(),
    operator: r.account(),
    attestorHex: r.hex(32),
    registry: { index: r.u64(), subindex: r.u64() },
    rewardToken: Buffer.from(r.hex(r.u32()), "hex").toString("utf8"),
    reviewWindowMs: r.u64(),
    paymentWindowMs: r.u64(),
    nextId: r.u64(),
  }));

/** bounty_board `Error` variants in declaration order; the contract rejects with code -(index + 1). */
export const CONTRACT_ERRORS = [
  "ParseError",
  "LogFull",
  "Unauthorized",
  "BadSignature",
  "AttestationExpired",
  "WrongStatus",
  "WrongKind",
  "NotEscrowed",
  "DeadlinePassed",
  "DeadlineNotPassed",
  "WindowNotPassed",
  "InvalidParams",
  "NotFound",
  "AlreadyEntered",
  "ContestFull",
  "RegistryCheckFailed",
  "Overflow",
] as const;

export function contractErrorName(code: number): string {
  return CONTRACT_ERRORS[-code - 1] ?? `reject code ${code}`;
}

// --- events ------------------------------------------------------------------

export type BoardEvent =
  | { type: "Posted"; id: bigint; poster: string; posterAgent: bigint | null; kind: BountyKind; reward: bigint; specHash: string; deadline: bigint }
  | { type: "Funded"; id: bigint; tx: string }
  | { type: "Claimed"; id: bigint; worker: string; agent: bigint | null }
  | { type: "Submitted"; id: bigint; worker: string; workHash: string }
  | { type: "Entered"; id: bigint; entryId: number; worker: string; agent: bigint | null; workHash: string }
  | { type: "Accepted"; id: bigint; worker: string; auto: boolean }
  | { type: "Rejected"; id: bigint; count: number; reasonHash: string }
  | { type: "RejectedFinal"; id: bigint }
  | { type: "Awarded"; id: bigint; entryId: number; worker: string }
  | { type: "SplitStarted"; id: bigint; entries: number }
  | { type: "PayoutRecorded"; id: bigint; to: string; amount: bigint; tx: string }
  | { type: "RefundRecorded"; id: bigint; tx: string }
  | { type: "MarkedUnpaid"; id: bigint }
  | { type: "NoAward"; id: bigint }
  | { type: "Expired"; id: bigint }
  | { type: "Cancelled"; id: bigint }
  | { type: "AdminChanged"; what: number };

export function decodeEvent(bytes: Uint8Array): BoardEvent {
  return whole(bytes, (r): BoardEvent => {
    const tag = r.u8();
    switch (tag) {
      case 0:
        return { type: "Posted", id: r.u64(), poster: r.account(), posterAgent: r.opt(() => r.u64()), kind: kind(r), reward: r.u64(), specHash: r.hex(32), deadline: r.u64() };
      case 1:
        return { type: "Funded", id: r.u64(), tx: r.hex(32) };
      case 2:
        return { type: "Claimed", id: r.u64(), worker: r.account(), agent: r.opt(() => r.u64()) };
      case 3:
        return { type: "Submitted", id: r.u64(), worker: r.account(), workHash: r.hex(32) };
      case 4:
        return { type: "Entered", id: r.u64(), entryId: r.u32(), worker: r.account(), agent: r.opt(() => r.u64()), workHash: r.hex(32) };
      case 5:
        return { type: "Accepted", id: r.u64(), worker: r.account(), auto: r.bool() };
      case 6:
        return { type: "Rejected", id: r.u64(), count: r.u8(), reasonHash: r.hex(32) };
      case 7:
        return { type: "RejectedFinal", id: r.u64() };
      case 8:
        return { type: "Awarded", id: r.u64(), entryId: r.u32(), worker: r.account() };
      case 9:
        return { type: "SplitStarted", id: r.u64(), entries: r.u32() };
      case 10:
        return { type: "PayoutRecorded", id: r.u64(), to: r.account(), amount: r.u64(), tx: r.hex(32) };
      case 11:
        return { type: "RefundRecorded", id: r.u64(), tx: r.hex(32) };
      case 12:
        return { type: "MarkedUnpaid", id: r.u64() };
      case 13:
        return { type: "NoAward", id: r.u64() };
      case 14:
        return { type: "Expired", id: r.u64() };
      case 15:
        return { type: "Cancelled", id: r.u64() };
      case 16:
        return { type: "AdminChanged", what: r.u8() };
      default:
        throw new RangeError(`unknown event tag ${tag}`);
    }
  });
}

// --- parameters --------------------------------------------------------------

export function encodeU64(v: bigint): Uint8Array {
  const w = new Writer();
  w.u64(v);
  return w.done();
}

export function encodeAccount(address: string): Uint8Array {
  const w = new Writer();
  w.account(address);
  return w.done();
}

export function encodePost(p: {
  kind: BountyKind;
  posterAgent: bigint | null;
  specHash: string;
  reward: bigint;
  deadline: bigint;
  attestationExpiry: bigint;
  signature: string;
}): Uint8Array {
  const w = new Writer();
  w.u8(KINDS.indexOf(p.kind));
  w.optU64(p.posterAgent);
  w.hex(p.specHash, 32, "specHash");
  w.u64(p.reward);
  w.u64(p.deadline);
  w.u64(p.attestationExpiry);
  w.hex(p.signature, 64, "signature");
  return w.done();
}

export function encodeClaim(p: { id: bigint; agent: bigint | null; attestationExpiry: bigint; signature: string }): Uint8Array {
  const w = new Writer();
  w.u64(p.id);
  w.optU64(p.agent);
  w.u64(p.attestationExpiry);
  w.hex(p.signature, 64, "signature");
  return w.done();
}

export function encodeEnter(p: { id: bigint; agent: bigint | null; workHash: string; attestationExpiry: bigint; signature: string }): Uint8Array {
  const w = new Writer();
  w.u64(p.id);
  w.optU64(p.agent);
  w.hex(p.workHash, 32, "workHash");
  w.u64(p.attestationExpiry);
  w.hex(p.signature, 64, "signature");
  return w.done();
}

/** Shape shared by submit {id, work_hash}, reject {id, reason_hash}, confirm_funding and record_refund {id, tx}. */
export function encodeIdHash(id: bigint, hash: string): Uint8Array {
  const w = new Writer();
  w.u64(id);
  w.hex(hash, 32, "hash");
  return w.done();
}

export function encodeIdEntry(id: bigint, entryId: number): Uint8Array {
  const w = new Writer();
  w.u64(id);
  w.u32(entryId);
  return w.done();
}

/** InitParams: the ConfigView layout without next_id. */
export function encodeInit(p: {
  admin: string;
  operator: string;
  attestorHex: string;
  registry: { index: bigint; subindex: bigint };
  rewardToken: string;
  reviewWindowMs: bigint;
  paymentWindowMs: bigint;
}): Uint8Array {
  const w = new Writer();
  w.account(p.admin);
  w.account(p.operator);
  w.hex(p.attestorHex, 32, "attestor public key");
  w.u64(p.registry.index);
  w.u64(p.registry.subindex);
  const token = Buffer.from(p.rewardToken, "utf8");
  w.u32(token.length);
  w.hex(token.toString("hex"), token.length, "reward token");
  w.u64(p.reviewWindowMs);
  w.u64(p.paymentWindowMs);
  return w.done();
}

export function encodeRecordPayout(id: bigint, payouts: { to: string; amount: bigint; tx: string }[]): Uint8Array {
  const w = new Writer();
  w.u64(id);
  w.u32(payouts.length);
  for (const p of payouts) {
    w.account(p.to);
    w.u64(p.amount);
    w.hex(p.tx, 32, "tx");
  }
  return w.done();
}
