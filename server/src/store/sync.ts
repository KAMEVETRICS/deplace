import type { Bounty } from "@deplace/shared";
import type { BoardStore } from "./db.js";

const ESCROW_WORK = new Set(["Accepted", "Awarded", "Splitting", "Cancelled", "Expired", "RejectedFinal"]);

/**
 * Refreshes the cache from the contract's views and queues every escrowed bounty
 * that needs a payout or refund for the escrow worker.
 */
export async function syncFromChain(chain: { all(): Promise<Bounty[]> }, store: BoardStore): Promise<number> {
  const all = await chain.all();
  for (const b of all) {
    store.upsertBounty(b);
    if (b.funding.type === "Escrowed" && ESCROW_WORK.has(b.status.type)) store.escrow.addCandidate(b.id);
  }
  return all.length;
}
