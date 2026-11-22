/** API shapes as JSON: bigints arrive as decimal strings. */

export type Funding = { type: "NotFunded" } | { type: "Escrowed"; fundingTx: string };

export type Status =
  | { type: "Open" }
  | { type: "Claimed"; worker: string; agent: string | null }
  | { type: "Submitted"; worker: string; agent: string | null; workHash: string; at: string }
  | { type: "Accepted"; worker: string; at: string; workHash: string }
  | { type: "Awarded"; entryId: number; at: string }
  | { type: "Splitting"; at: string }
  | { type: "Paid" }
  | { type: "AcceptedUnpaid"; worker: string; workHash: string }
  | { type: "RejectedFinal" }
  | { type: "NoAward" }
  | { type: "Expired" }
  | { type: "Cancelled" }
  | { type: "Refunded" };

export interface Spec {
  title: string;
  description: string;
  taskKind: string;
  input: Record<string, unknown>;
  kind: "Exclusive" | "Contest";
  reward: string;
  rewardToken: string;
  deadline: number;
  poster: string;
  posterAgent: string | null;
}

export interface Bounty {
  id: string;
  poster: string;
  posterAgent: string | null;
  kind: "Exclusive" | "Contest";
  specHash: string;
  reward: string;
  funding: Funding;
  deadline: string;
  status: Status;
  rejections: number;
  lastRejectedAt: string | null;
  entryCount: number;
  created: string;
  spec?: Spec | null;
}

export interface Prepared {
  txJson: string;
  feeSponsored: boolean;
  notice?: string;
  sender?: string;
  expiresAt?: number;
}

export interface Identity {
  kind: "person" | "company" | "agent";
  label: string;
  account: string;
  tokenId?: string;
  badge?: string;
}

export interface Stats {
  posted: number;
  paidAsPoster: number;
  unpaid: number;
  rejectedFinal: number;
  noAward: number;
  paidAsWorker: number;
}

export interface BoardConfig {
  rewardToken: string;
  decimals: number;
  contract: { index: string; subindex: string };
  escrowAccount: string;
  faucetUrl: string | null;
}
