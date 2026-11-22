import {
  AccountAddress,
  CcdAmount,
  ContractAddress,
  Energy,
  Parameter,
  ReceiveName,
  Transaction,
  TransactionExpiry,
  TransactionHash,
  type AccountSigner,
  type ConcordiumGRPCClient,
} from "@concordium/web-sdk";
import { CborAccountAddress, CborMemo, TokenAmount, TokenId, createTokenUpdatePayload } from "@concordium/web-sdk/plt";
import type { ContractRef } from "@deplace/shared";
import type { PreparedTransfer } from "../escrow/worker.js";
import { ContractRejected } from "./contract.js";
import { bigintJson } from "./grpc.js";

export interface Wallet {
  address: string;
  signer: AccountSigner;
}

/** Serializes transactions from one account so two callers never take the same nonce. */
class NonceLock {
  private tail: Promise<void> = Promise.resolve();
  acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const prev = this.tail;
    this.tail = prev.then(() => held);
    return prev.then(() => release);
  }
}

/** Throws ContractRejected / Error when a finalized transaction failed. */
function assertSucceeded(entrypoint: string, summary: unknown) {
  const s = summary as { transactionType?: string; rejectReason?: { tag?: string; rejectReason?: number } };
  if (s?.transactionType !== "failed") return;
  const r = s.rejectReason;
  if (r?.tag === "RejectedReceive" && typeof r.rejectReason === "number") throw new ContractRejected(entrypoint, r.rejectReason);
  throw new Error(`${entrypoint} failed on chain: ${JSON.stringify(r, bigintJson)}`);
}

/**
 * The operator account: the escrow, and the only sender allowed to call deplace's
 * operator entrypoints. It pays its own (small) fees.
 */
export class Operator {
  private readonly lock = new NonceLock();

  constructor(
    private readonly client: ConcordiumGRPCClient,
    readonly wallet: Wallet,
    private readonly contract: ContractRef,
    private readonly reward: { tokenId: string; decimals: number },
    /** Called with every finalized operator contract call, so its events reach the board's record. */
    private readonly onFinalized?: (txHash: string, summary: unknown) => Promise<void> | void,
  ) {}

  private sender() {
    return AccountAddress.fromBase58(this.wallet.address);
  }

  /** Calls an operator entrypoint and waits for finalization. Returns the transaction hash. */
  async update(entrypoint: string, parameter: Uint8Array, energy = 60_000n): Promise<string> {
    const release = await this.lock.acquire();
    let hash: TransactionHash.Type;
    try {
      const { nonce } = await this.client.getNextAccountNonce(this.sender());
      const tx = Transaction.updateContract(
        {
          amount: CcdAmount.zero(),
          address: ContractAddress.create(this.contract.index, this.contract.subindex),
          receiveName: ReceiveName.fromString(`deplace.${entrypoint}`),
          message: Parameter.fromBuffer(parameter.slice().buffer),
        },
        Energy.create(energy),
      )
        .addMetadata({ sender: this.sender(), nonce, expiry: TransactionExpiry.futureMinutes(5) })
        .build();
      hash = await this.client.sendTransaction(await Transaction.signAndFinalize(tx, this.wallet.signer));
    } finally {
      release();
    }
    const outcome = await this.client.waitForTransactionFinalization(hash);
    assertSucceeded(entrypoint, outcome.summary);
    const hex = TransactionHash.toHexString(hash);
    await this.onFinalized?.(hex, outcome.summary);
    return hex;
  }

  /**
   * Signs an escrow transfer and returns its hash before sending, so the escrow worker can
   * store it first (write-ahead). The nonce lock is held until `submit` (or 30 s).
   */
  async prepareTransfer(to: string, amount: bigint, memo: string): Promise<PreparedTransfer> {
    const release = await this.lock.acquire();
    try {
      const { nonce } = await this.client.getNextAccountNonce(this.sender());
      const expiry = TransactionExpiry.futureMinutes(10);
      const tx = Transaction.tokenUpdate(
        createTokenUpdatePayload(TokenId.fromString(this.reward.tokenId), {
          transfer: {
            amount: TokenAmount.create(amount, this.reward.decimals),
            recipient: CborAccountAddress.fromAccountAddress(AccountAddress.fromBase58(to)),
            memo: CborMemo.fromString(memo),
          },
        }),
      )
        .addMetadata({ sender: this.sender(), nonce, expiry })
        .build();
      const signed = await Transaction.signAndFinalize(tx, this.wallet.signer);
      const hash = Buffer.from(Transaction.getAccountTransactionHash(signed)).toString("hex");
      const timer = setTimeout(release, 30_000);
      return {
        hash,
        expiresAt: Number(expiry.expiryEpochSeconds) * 1000,
        submit: async () => {
          try {
            await this.client.sendTransaction(signed);
          } finally {
            clearTimeout(timer);
            release();
          }
        },
      };
    } catch (e) {
      release();
      throw e;
    }
  }
}
