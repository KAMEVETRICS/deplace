/** A smart contract instance address. */
export interface ContractRef {
  index: bigint;
  subindex: bigint;
}

export type BountyKind = "Exclusive" | "Contest";

export type Funding = { type: "NotFunded" } | { type: "Escrowed"; fundingTx: string };

/** Mirrors `Status` in contracts/bounty-board/src/state.rs. Times are Unix ms. */
export type BountyStatus =
  | { type: "Open" }
  | { type: "Claimed"; worker: string; agent: bigint | null }
  | { type: "Submitted"; worker: string; agent: bigint | null; workHash: string; at: bigint }
  | { type: "Accepted"; worker: string; at: bigint; workHash: string }
  | { type: "Awarded"; entryId: number; at: bigint }
  | { type: "Splitting"; at: bigint }
  | { type: "Paid" }
  | { type: "AcceptedUnpaid"; worker: string; workHash: string }
  | { type: "RejectedFinal" }
  | { type: "NoAward" }
  | { type: "Expired" }
  | { type: "Cancelled" }
  | { type: "Refunded" };

export interface Bounty {
  id: bigint;
  poster: string;
  posterAgent: bigint | null;
  kind: BountyKind;
  /** Hex SHA-256 of the spec JSON. */
  specHash: string;
  /** Reward in the token's smallest unit. */
  reward: bigint;
  funding: Funding;
  deadline: bigint;
  status: BountyStatus;
  rejections: number;
  lastRejectedAt: bigint | null;
  entryCount: number;
  created: bigint;
}

export interface Entry {
  worker: string;
  agent: bigint | null;
  workHash: string;
  at: bigint;
}

/** Public track record kept by the contract per account. */
export interface Stats {
  posted: number;
  paidAsPoster: number;
  unpaid: number;
  rejectedFinal: number;
  noAward: number;
  paidAsWorker: number;
}
