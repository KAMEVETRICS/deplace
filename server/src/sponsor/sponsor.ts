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
import type { ContractRef } from "@deplace/shared";
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
  /**
   * Transaction types that cannot be sponsored on this network (set from the day-1 spike
   * results). They are built for the sender to pay, and the response says so.
   */
  unsponsoredTypes?: Set<Intent["type"]>;
}

export const FEE_NOTICE = "Network fee applies: this transaction type cannot be sponsored right now, so your account pays a small CCD fee.";

export interface PreparedTx {
  /** Web-sdk Transaction JSON. When sponsored, the sponsor has signed; the sender adds its signature and submits. */
  txJson: string;
  sender: string;
  expiresAt: number;
  feeSponsored: boolean;
  /** Present when the sender pays the fee. */
  notice?: string;
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

/** Builds the transaction; with `sponsor`, also adds and signs the sponsorship. */
async function signableFor(deps: SponsorDeps, intent: Intent, meta: Meta, sponsor: AccountAddress.Type | null): Promise<Transaction.Signable> {
  // Each branch handles its own concrete transaction type; the SDK's generics do not accept a union.
  if (intent.type === "contract") {
    const tx = Transaction.updateContract(
      {
        amount: CcdAmount.zero(),
        address: ContractAddress.create(deps.contract.index, deps.contract.subindex),
        receiveName: ReceiveName.fromString(`deplace.${intent.entrypoint}`),
        message: Parameter.fromBuffer(intent.parameter.slice().buffer),
      },
      Energy.create(deps.maxContractEnergy ?? 30_000n),
    ).addMetadata(meta);
    return sponsor ? Transaction.sponsor(tx.addSponsor(sponsor).build(), deps.sponsor.signer) : tx.build();
  }
  const tx = Transaction.tokenUpdate(
    createTokenUpdatePayload(TokenId.fromString(intent.token), {
      transfer: {
        amount: TokenAmount.create(intent.amount, deps.tokenDecimals),
        recipient: CborAccountAddress.fromAccountAddress(AccountAddress.fromBase58(intent.to)),
        memo: CborMemo.fromString(intent.memo),
      },
    }),
  ).addMetadata(meta);
  return sponsor ? Transaction.sponsor(tx.addSponsor(sponsor).build(), deps.sponsor.signer) : tx.build();
}

async function meta(deps: SponsorDeps, sender: string): Promise<Meta> {
  return {
    sender: AccountAddress.fromBase58(sender),
    nonce: SequenceNumber.create(await deps.nextNonce(sender)),
    expiry: TransactionExpiry.futureMinutes(deps.expiryMinutes ?? 5),
  };
}

/**
 * Builds the transaction for `intent` with `sender` as sender and the board's sponsor
 * as fee payer, and signs it as sponsor (the sponsor-first flow). The sender's
 * signature is still missing; neither party can change the transaction afterwards.
 */
export async function buildSponsored(deps: SponsorDeps, intent: Intent, sender: string): Promise<PreparedTx> {
  const m = await meta(deps, sender);
  const sponsored = await signableFor(deps, intent, m, AccountAddress.fromBase58(deps.sponsor.address));
  return { txJson: Transaction.toJSONString(sponsored), sender, expiresAt: Date.now() + (deps.expiryMinutes ?? 5) * 60_000, feeSponsored: true };
}

/** The explicit fallback: the same transaction, but the sender pays the fee. */
export async function buildUnsponsored(deps: SponsorDeps, intent: Intent, sender: string): Promise<PreparedTx> {
  const m = await meta(deps, sender);
  const tx = await signableFor(deps, intent, m, null);
  return {
    txJson: Transaction.toJSONString(tx),
    sender,
    expiresAt: Date.now() + (deps.expiryMinutes ?? 5) * 60_000,
    feeSponsored: false,
    notice: FEE_NOTICE,
  };
}

export class SponsorService {
  constructor(
    private readonly policy: SponsorPolicy,
    private readonly deps: SponsorDeps,
  ) {}

  async prepare(intent: Intent, sender: string, badge?: string): Promise<PreparedTx> {
    const decision = await this.policy.check(intent, sender, badge);
    if (!decision.ok) throw new SponsorRefused(decision.reason, decision.retryAfter);
    if (this.deps.unsponsoredTypes?.has(intent.type)) return buildUnsponsored(this.deps, intent, sender);
    return buildSponsored(this.deps, intent, sender);
  }
}
