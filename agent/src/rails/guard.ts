import { createHash } from "node:crypto";
import { AccountTransactionType, Parameter, Transaction, type CcdAmount, type ContractAddress, type ReceiveName } from "@concordium/web-sdk";
import { encodeClaim, encodeEnter, encodeIdEntry, encodeIdHash, encodePost, encodeU64, type BountyKind } from "@deplace/shared";

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

/** What the agent asked the board to prepare: the prepared call's parameter must say the same. */
export type ExpectedCall =
  | { entrypoint: "claim"; bountyId: bigint; agent: bigint | null }
  | { entrypoint: "enter"; bountyId: bigint; agent: bigint | null; workHash: string }
  | { entrypoint: "submit"; bountyId: bigint; workHash: string }
  | { entrypoint: "reject"; bountyId: bigint; reasonHash: string }
  | { entrypoint: "award"; bountyId: bigint; entryId: number }
  | { entrypoint: "accept" | "cancel"; bountyId: bigint }
  | { entrypoint: "post"; kind: BountyKind; posterAgent: bigint | null; specHash: string; reward: bigint; deadline: bigint };

/** What the board puts on chain for a rejection: sha256 hex of JSON.stringify({ reason: reason.slice(0, 2000) }). */
export function reasonHash(reason: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ reason: reason.slice(0, 2000) }))
    .digest("hex");
}

/** The attestation the board's attestor appends to claim, enter and post: a u64 expiry and a 64-byte signature. */
const ATTESTATION_BYTES = 8 + 64;

/** The parameter the call must carry, and how many trailing bytes are the board's attestation (not compared). */
function expectedParameter(e: ExpectedCall): { bytes: Uint8Array; attestation: number } {
  const blank = { attestationExpiry: 0n, signature: "00".repeat(64) };
  switch (e.entrypoint) {
    case "claim":
      return { bytes: encodeClaim({ id: e.bountyId, agent: e.agent, ...blank }), attestation: ATTESTATION_BYTES };
    case "enter":
      return { bytes: encodeEnter({ id: e.bountyId, agent: e.agent, workHash: e.workHash, ...blank }), attestation: ATTESTATION_BYTES };
    case "post":
      return {
        bytes: encodePost({ kind: e.kind, posterAgent: e.posterAgent, specHash: e.specHash, reward: e.reward, deadline: e.deadline, ...blank }),
        attestation: ATTESTATION_BYTES,
      };
    case "submit":
      return { bytes: encodeIdHash(e.bountyId, e.workHash), attestation: 0 };
    case "reject":
      return { bytes: encodeIdHash(e.bountyId, e.reasonHash), attestation: 0 };
    case "award":
      return { bytes: encodeIdEntry(e.bountyId, e.entryId), attestation: 0 };
    case "accept":
    case "cancel":
      return { bytes: encodeU64(e.bountyId), attestation: 0 };
  }
}

/** The request in words, for the refusal message. */
function asked(e: ExpectedCall): string {
  switch (e.entrypoint) {
    case "post":
      return `a ${e.kind} bounty with reward ${e.reward}, deadline ${e.deadline}, agent ${e.posterAgent ?? "none"} and spec hash ${e.specHash}`;
    case "claim":
      return `bounty ${e.bountyId} for agent ${e.agent ?? "none"}`;
    case "enter":
      return `bounty ${e.bountyId} for agent ${e.agent ?? "none"} with work hash ${e.workHash}`;
    case "submit":
      return `bounty ${e.bountyId} with work hash ${e.workHash}`;
    case "reject":
      return `bounty ${e.bountyId} with reason hash ${e.reasonHash}`;
    case "award":
      return `bounty ${e.bountyId}, entry ${e.entryId}`;
    case "accept":
    case "cancel":
      return `bounty ${e.bountyId}`;
  }
}

/**
 * Checks a transaction the board prepared before the agent signs it. The agent only signs
 * calls to the Deplace contract, for the action it asked for, with no CCD attached, and
 * (unless allowed) only when the board's sponsor pays the fee. It never signs a token
 * transfer prepared by the board: its payments go through its own capped x402 client.
 * With `expected`, the call's parameter must also be for what the agent asked: the bounty,
 * the work or reason hash, the entry, the agent, and for a post its reward, deadline and spec.
 */
export function checkPrepared(txJson: string, entrypoints: string[], o: GuardOptions, expected?: ExpectedCall): void {
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

  const p = tx.payload as { type?: AccountTransactionType; address?: ContractAddress.Type; receiveName?: ReceiveName.Type; amount?: CcdAmount.Type; message?: Parameter.Type };
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

  if (!expected) return;
  const name = p.receiveName.value;
  if (!entrypoints.includes(expected.entrypoint) || name !== `deplace.${expected.entrypoint}`) {
    throw new RailViolation(`refusing to sign ${name}: the agent asked for deplace.${expected.entrypoint}`);
  }
  if (!p.message) throw new RailViolation(`refusing to sign ${name}: the prepared call carries no parameter`);
  const got = Buffer.from(Parameter.toBuffer(p.message));
  const want = expectedParameter(expected);
  const compared = want.bytes.length - want.attestation;
  if (got.length !== want.bytes.length || !got.subarray(0, compared).equals(Buffer.from(want.bytes.subarray(0, compared)))) {
    throw new RailViolation(`refusing to sign ${name}: the prepared call is not for what the agent asked (${asked(expected)})`);
  }
}
