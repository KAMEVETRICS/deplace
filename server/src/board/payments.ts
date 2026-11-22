import type { Bounty } from "@deplace/shared";
import type { DepositInfo, DepositOutcome } from "../escrow/worker.js";

export interface TransferNoterDeps {
  rewardToken: string;
  transferInfo(tx: string): Promise<DepositInfo | null>;
  noteDeposit(tx: string): Promise<DepositOutcome>;
  live(id: bigint): Promise<Bounty>;
  payee(b: Bounty): Promise<string | null>;
  recordPayout(id: bigint, payouts: { to: string; amount: bigint; tx: string }[]): Promise<string>;
}

export type TransferNote =
  | { kind: "deposit"; outcome: DepositOutcome }
  | { kind: "payment"; recordTx: string }
  | { kind: "ignored"; reason: string };

/**
 * Handles a token transfer the board relayed: `fund:<id>` goes to the escrow worker;
 * `bounty:<id>` is a poster paying a not-funded bounty directly, recorded as its payout
 * only if sender, recipient, amount and token all match the chain.
 */
export function transferNoter(d: TransferNoterDeps) {
  return async (tx: string): Promise<TransferNote> => {
    const info = await d.transferInfo(tx);
    if (!info) return { kind: "ignored", reason: "not a finalized token transfer" };
    if (!info.success) return { kind: "ignored", reason: "transfer was rejected on chain" };
    if (info.memo?.startsWith("fund:")) return { kind: "deposit", outcome: await d.noteDeposit(tx) };

    const m = /^bounty:(\d{1,20})$/.exec(info.memo ?? "");
    if (!m) return { kind: "ignored", reason: `memo ${JSON.stringify(info.memo)} is not fund:<id> or bounty:<id>` };
    const b = await d.live(BigInt(m[1]!));
    if (b.funding.type !== "NotFunded") return { kind: "ignored", reason: "escrowed bounties are paid by the escrow worker" };
    const payee = await d.payee(b);
    if (!payee) return { kind: "ignored", reason: `bounty ${b.id} owes nothing in status ${b.status.type}` };
    if (info.token !== d.rewardToken) return { kind: "ignored", reason: `token ${info.token} is not the reward token` };
    if (info.from !== b.poster) return { kind: "ignored", reason: "payment is not from the poster" };
    if (info.to !== payee) return { kind: "ignored", reason: "payment is not to the recorded worker" };
    if (info.amount < b.reward) return { kind: "ignored", reason: `amount ${info.amount} is below the reward ${b.reward}` };
    return { kind: "payment", recordTx: await d.recordPayout(b.id, [{ to: payee, amount: info.amount, tx }]) };
  };
}
