import {
  AccountAddress,
  CcdAmount,
  ContractAddress,
  Energy,
  Parameter,
  ReceiveName,
  SequenceNumber,
  Transaction,
  TransactionExpiry,
  type AccountSigner,
} from "@concordium/web-sdk";
import { CborAccountAddress, CborMemo, TokenAmount, TokenId, createTokenUpdatePayload } from "@concordium/web-sdk/plt";
import type { ContractRef } from "@bounty/shared";
import type { Intent, SponsorPolicy } from "./policy.js";

export interface SponsorAccount {
  address: string;
  signer: AccountSigner;
}

export interface SponsorDeps {
  sponsor: SponsorAccount;
  nextNonce: (account: string) => Promise<bigint>;
  contract: ContractRef;
  rewardTokenId: string;
  tokenDecimals: number;
  /** Execution energy cap for contract updates. The fee is charged on energy actually used. */
  maxContractEnergy?: bigint;
  expiryMinutes?: number;
}

export interface PreparedTx {
  /** Sponsor-signed transaction (web-sdk Transaction JSON). The sender adds its signature and submits. */
  txJson: string;
  sender: string;
  expiresAt: number;
  feeSponsored: true;
}

/** Server-side errors a caller should show to the user, not log as failures. */
export class SponsorRefused extends Error {
  constructor(
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "SponsorRefused";
  }
}

type Meta = { sender: AccountAddress.Type; nonce: SequenceNumber.Type; expiry: TransactionExpiry.Type };

async function sponsoredFor(deps: SponsorDeps, intent: Intent, meta: Meta, sponsor: AccountAddress.Type): Promise<Transaction.Signable> {
  // Each branch sponsors its own concrete transaction type; the SDK's generics do not accept a union.
  if (intent.type === "contract") {
    const tx = Transaction.updateContract(
      {
        amount: CcdAmount.zero(),
        address: ContractAddress.create(deps.contract.index, deps.contract.subindex),
        receiveName: ReceiveName.fromString(`bounty_board.${intent.entrypoint}`),
        message: Parameter.fromBuffer(intent.parameter.slice().buffer),
      },
      Energy.create(deps.maxContractEnergy ?? 30_000n),
    )
      .addMetadata(meta)
      .addSponsor(sponsor)
      .build();
    return Transaction.sponsor(tx, deps.sponsor.signer);
  }
  const tokenId = TokenId.fromString(intent.token);
  const tx = Transaction.tokenUpdate(
    createTokenUpdatePayload(tokenId, {
      transfer: {
        amount: TokenAmount.create(intent.amount, deps.tokenDecimals),
        recipient: CborAccountAddress.fromAccountAddress(AccountAddress.fromBase58(intent.to)),
        memo: CborMemo.fromString(intent.memo),
      },
    }),
  )
    .addMetadata(meta)
    .addSponsor(sponsor)
    .build();
  return Transaction.sponsor(tx, deps.sponsor.signer);
}

/**
 * Builds the transaction for `intent` with `sender` as sender and the board's sponsor
 * as fee payer, and signs it as sponsor (the sponsor-first flow). The sender's
 * signature is still missing; neither party can change the transaction afterwards.
 */
export async function buildSponsored(deps: SponsorDeps, intent: Intent, sender: string): Promise<PreparedTx> {
  const minutes = deps.expiryMinutes ?? 5;
  const nonce = await deps.nextNonce(sender);
  const meta: Meta = {
    sender: AccountAddress.fromBase58(sender),
    nonce: SequenceNumber.create(nonce),
    expiry: TransactionExpiry.futureMinutes(minutes),
  };
  const sponsored = await sponsoredFor(deps, intent, meta, AccountAddress.fromBase58(deps.sponsor.address));
  return { txJson: Transaction.toJSONString(sponsored), sender, expiresAt: Date.now() + minutes * 60_000, feeSponsored: true };
}

export class SponsorService {
  constructor(
    private readonly policy: SponsorPolicy,
    private readonly deps: SponsorDeps,
  ) {}

  async prepare(intent: Intent, sender: string, badge?: string): Promise<PreparedTx> {
    const decision = await this.policy.check(intent, sender, badge);
    if (!decision.ok) throw new SponsorRefused(decision.reason, decision.retryAfter);
    return buildSponsored(this.deps, intent, sender);
  }
}
