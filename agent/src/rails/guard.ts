import { AccountTransactionType, Transaction, type CcdAmount, type ContractAddress, type ReceiveName } from "@concordium/web-sdk";

/** A transaction or payment the agent's rails do not allow. The agent stops instead of signing. */
export class RailViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RailViolation";
  }
}

export interface GuardOptions {
  /** The agent's own account: the only sender it signs for. */
  account: string;
  /** The Deplace contract, from the agent's own configuration (not from the board). */
  contract: { index: bigint; subindex: bigint };
  /** Whether the agent may pay a network fee itself when the board cannot sponsor one. */
  allowFees: boolean;
  /** Energy cap for transactions the agent pays for itself. */
  maxEnergy?: bigint;
}

/**
 * Checks a transaction the board prepared before the agent signs it. The agent only signs
 * calls to the Deplace contract, for the action it asked for, with no CCD attached, and
 * (unless allowed) only when the board's sponsor pays the fee. It never signs a token
 * transfer prepared by the board: its payments go through its own capped x402 client.
 */
export function checkPrepared(txJson: string, entrypoints: string[], o: GuardOptions): void {
  let tx: Transaction.Signable;
  try {
    tx = Transaction.signableFromJSON(JSON.parse(txJson));
  } catch (e) {
    throw new RailViolation(`not a transaction the agent can read: ${(e as Error).message}`);
  }
  if (tx.header.sender.address !== o.account) {
    throw new RailViolation(`refusing to sign: the sender is ${tx.header.sender.address}, not this agent's account ${o.account}`);
  }

  const sponsored = tx.version === 1 && tx.header.sponsor !== undefined;
  if (!sponsored) {
    if (!o.allowFees) throw new RailViolation("refusing to pay a network fee: the board did not sponsor this transaction (set AGENT_ALLOW_FEES=true to allow)");
    const energy = tx.header.executionEnergyAmount.value;
    if (o.maxEnergy !== undefined && energy > o.maxEnergy) throw new RailViolation(`refusing to pay for ${energy} energy; the cap is ${o.maxEnergy}`);
  }

  const p = tx.payload as { type?: AccountTransactionType; address?: ContractAddress.Type; receiveName?: ReceiveName.Type; amount?: CcdAmount.Type };
  if (p.type === AccountTransactionType.TokenUpdate) {
    throw new RailViolation("refusing to sign a token transfer prepared by the board; the agent pays only through its own capped x402 client");
  }
  if (p.type !== AccountTransactionType.Update || !p.address || !p.receiveName || !p.amount) {
    throw new RailViolation(`refusing to sign: only Deplace contract calls are signed (got transaction type ${String(p.type)})`);
  }
  if (p.address.index !== o.contract.index || p.address.subindex !== o.contract.subindex) {
    throw new RailViolation(`refusing to sign a call to contract <${p.address.index},${p.address.subindex}>; the Deplace contract is <${o.contract.index},${o.contract.subindex}>`);
  }
  const allowed = entrypoints.map((e) => `deplace.${e}`);
  if (!allowed.includes(p.receiveName.value)) {
    throw new RailViolation(`refusing to sign the action ${p.receiveName.value}; this step expects ${allowed.join(" or ")}`);
  }
  if (p.amount.microCcdAmount !== 0n) {
    throw new RailViolation(`refusing to send ${p.amount.microCcdAmount} micro-CCD with a contract call`);
  }
}
