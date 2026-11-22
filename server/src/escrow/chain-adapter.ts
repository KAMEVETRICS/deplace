import { encodeIdHash, encodeRecordPayout } from "@bounty/shared";
import type { BountyContract } from "../chain/contract.js";
import type { Operator } from "../chain/operator.js";
import type { PltClient } from "../chain/plt.js";
import type { EscrowChain } from "./worker.js";

/** The escrow worker's view of the chain, backed by the real contract, token and operator. */
export function escrowChain(contract: BountyContract, plt: PltClient, operator: Operator): EscrowChain {
  return {
    bounty: (id) => contract.view(id),
    split: (id) => contract.split(id),
    entryWorker: async (id, entryId) => (await contract.entry(id, entryId))?.worker ?? null,
    transferInfo: (tx) => plt.transferInfo(tx),
    prepareTransfer: (to, amount, memo) => operator.prepareTransfer(to, amount, memo),
    txStatus: (hash) => plt.txStatus(hash),
    confirmFunding: async (id, tx) => {
      await operator.update("confirm_funding", encodeIdHash(id, tx));
    },
    recordPayout: async (id, payouts) => {
      await operator.update("record_payout", encodeRecordPayout(id, payouts));
    },
    recordRefund: async (id, tx) => {
      await operator.update("record_refund", encodeIdHash(id, tx));
    },
  };
}
