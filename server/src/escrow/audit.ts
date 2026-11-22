import type { BoardEvent, Bounty } from "@deplace/shared";
import type { DepositInfo } from "./worker.js";

export interface AuditInput {
  escrowAccount: string;
  rewardToken: string;
  bounties: Bounty[];
  /** Events the board recorded for a bounty (PayoutRecorded / RefundRecorded carry the transfer hashes). */
  events(id: bigint): BoardEvent[];
  transferInfo(tx: string): Promise<DepositInfo | null>;
  /** The escrow account's balance of the reward token, in smallest units. */
  escrowBalance: bigint;
}

export interface AuditRow {
  id: bigint;
  status: string;
  owed: bigint;
  notes: string[];
}

const OWED = new Set(["Open", "Claimed", "Submitted", "Accepted", "Awarded", "Splitting", "Cancelled", "Expired", "RejectedFinal"]);

function matches(t: DepositInfo | null, token: string, from: string, to: string, amount: bigint, memo: string): boolean {
  return t !== null && t.success && t.token === token && t.from === from && t.to === to && t.amount === amount && t.memo === memo;
}

/**
 * Checks the custodial escrow against the chain: every escrowed bounty's funding deposit,
 * every recorded payout and refund, and that the escrow balance covers every reward
 * still owed. Anyone can run it; it needs no keys.
 */
export async function auditEscrow(i: AuditInput): Promise<{ rows: AuditRow[]; liabilities: bigint; balance: bigint; shortfall: bigint; ok: boolean }> {
  const rows: AuditRow[] = [];
  let liabilities = 0n;
  for (const b of i.bounties) {
    if (b.funding.type !== "Escrowed") continue;
    const notes: string[] = [];
    const fund = await i.transferInfo(b.funding.fundingTx);
    if (!matches(fund, i.rewardToken, b.poster, i.escrowAccount, b.reward, `fund:${b.id}`)) {
      notes.push(`funding tx ${b.funding.fundingTx} is not a ${b.reward} ${i.rewardToken} deposit from the poster with memo fund:${b.id}`);
    }
    const evs = i.events(b.id);
    if (b.status.type === "Paid") {
      const payouts = evs.filter((e): e is Extract<BoardEvent, { type: "PayoutRecorded" }> => e.type === "PayoutRecorded");
      if (payouts.length === 0) notes.push("paid, but this board has no PayoutRecorded event for it (check CCDExplorer)");
      for (const p of payouts) {
        if (!matches(await i.transferInfo(p.tx), i.rewardToken, i.escrowAccount, p.to, p.amount, `bounty:${b.id}`)) {
          notes.push(`payout ${p.tx} does not match a ${p.amount} transfer from escrow to ${p.to} with memo bounty:${b.id}`);
        }
      }
    }
    if (b.status.type === "Refunded") {
      const refunds = evs.filter((e): e is Extract<BoardEvent, { type: "RefundRecorded" }> => e.type === "RefundRecorded");
      if (refunds.length === 0) notes.push("refunded, but this board has no RefundRecorded event for it (check CCDExplorer)");
      for (const r of refunds) {
        if (!matches(await i.transferInfo(r.tx), i.rewardToken, i.escrowAccount, b.poster, b.reward, `refund:${b.id}`)) {
          notes.push(`refund ${r.tx} does not match a ${b.reward} transfer from escrow back to the poster with memo refund:${b.id}`);
        }
      }
    }
    const owed = OWED.has(b.status.type) ? b.reward : 0n;
    liabilities += owed;
    rows.push({ id: b.id, status: b.status.type, owed, notes });
  }
  const shortfall = liabilities > i.escrowBalance ? liabilities - i.escrowBalance : 0n;
  const ok = shortfall === 0n && rows.every((r) => r.notes.length === 0);
  return { rows, liabilities, balance: i.escrowBalance, shortfall, ok };
}
