import { credentials } from "@grpc/grpc-js";
import { AccountAddress, ContractAddress, ContractEvent, Parameter, ReceiveName, ReturnValue, TransactionHash } from "@concordium/web-sdk";
import { ConcordiumGRPCNodeClient } from "@concordium/web-sdk/nodejs";
import { Token, TokenId } from "@concordium/web-sdk/plt";
import { decodeConfig, decodeEvent, decodeOptionBounty, decodeOptionEntry, encodeIdEntry, encodeU64, type BoardEvent, type Bounty } from "@deplace/shared";

/** What the agent reads from the chain before it pays anyone. */
export interface ChainReads {
  bounty(id: bigint): Promise<Bounty>;
  /** The account the contract says is owed this bounty's reward right now, or null. */
  payee(b: Bounty): Promise<string | null>;
  /** The escrow account: the operator in the contract's configuration. */
  escrowAccount(): Promise<string>;
}

/** Where a transaction the agent sent stands on chain. */
export type TxOutcome = { state: "absent" } | { state: "pending" } | { state: "finalized"; failed: boolean; events: BoardEvent[] };

/** The kit's chain reads: the agent's own, plus what it needs to find out whether a lost transaction or payment landed. */
export interface KitChain extends ChainReads {
  decimals(tokenId: string): Promise<number>;
  txOutcome(hash: string): Promise<TxOutcome>;
  /** The account's next nonce as of the last finalized block. */
  finalizedNonce(account: string): Promise<bigint>;
  /** Unix ms of the last finalized block: past a transaction's expiry, it can no longer land. */
  lastFinalizedTime(): Promise<number>;
}

/**
 * The Deplace events in a transaction summary: the same walk as eventsFromSummary in
 * server/src/chain/contract.ts (the agent does not import server code).
 */
export function deplaceEvents(summary: unknown, contract: { index: bigint; subindex: bigint }): BoardEvent[] {
  const s = summary as { transactionType?: string; events?: { tag?: string; address?: { index: bigint; subindex: bigint }; events?: unknown[] }[] };
  if (s?.transactionType !== "update" || !Array.isArray(s.events)) return [];
  const out: BoardEvent[] = [];
  for (const t of s.events) {
    if ((t?.tag !== "Updated" && t?.tag !== "Interrupted") || !t.address) continue;
    if (t.address.index !== contract.index || t.address.subindex !== contract.subindex) continue;
    for (const e of t.events ?? []) {
      const hex = typeof e === "string" ? e : ContractEvent.toHexString(e as ContractEvent.Type);
      out.push(decodeEvent(new Uint8Array(Buffer.from(hex, "hex"))));
    }
  }
  return out;
}

const notFound = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  return code === "NOT_FOUND" || code === 5;
};

/**
 * The agent's own read access to the chain, so that the rails do not depend on what the
 * board says: token decimals, who is owed what on the Deplace contract, and whether a
 * transaction it sent landed.
 */
export class AgentChain implements KitChain {
  readonly client: ConcordiumGRPCNodeClient;

  constructor(
    host: string,
    port: number,
    private readonly contract: { index: bigint; subindex: bigint },
    client?: ConcordiumGRPCNodeClient,
  ) {
    this.client = client ?? new ConcordiumGRPCNodeClient(host, port, credentials.createSsl(), { timeout: 30_000 });
  }

  async decimals(tokenId: string): Promise<number> {
    return (await Token.fromId(this.client, TokenId.fromString(tokenId))).info.state.decimals;
  }

  private async view(entrypoint: string, parameter: Uint8Array): Promise<Uint8Array> {
    const r = await this.client.invokeContract({
      contract: ContractAddress.create(this.contract.index, this.contract.subindex),
      method: ReceiveName.fromString(`deplace.${entrypoint}`),
      parameter: Parameter.fromBuffer(parameter.slice().buffer),
    });
    if (r.tag !== "success" || !r.returnValue) throw new Error(`deplace.${entrypoint} view failed`);
    return ReturnValue.toBuffer(r.returnValue);
  }

  async bounty(id: bigint): Promise<Bounty> {
    const b = decodeOptionBounty(await this.view("view_bounty", encodeU64(id)));
    if (!b) throw new Error(`no bounty ${id} on chain`);
    return b;
  }

  async payee(b: Bounty): Promise<string | null> {
    const s = b.status;
    if (s.type === "Accepted" || s.type === "AcceptedUnpaid") return s.worker;
    if (s.type === "Awarded") return decodeOptionEntry(await this.view("view_entry", encodeIdEntry(b.id, s.entryId)))?.worker ?? null;
    return null;
  }

  async escrowAccount(): Promise<string> {
    return decodeConfig(await this.view("view_config", new Uint8Array())).operator;
  }

  async txOutcome(hash: string): Promise<TxOutcome> {
    let status: Awaited<ReturnType<ConcordiumGRPCNodeClient["getBlockItemStatus"]>>;
    try {
      status = await this.client.getBlockItemStatus(TransactionHash.fromHexString(hash));
    } catch (e) {
      if (notFound(e)) return { state: "absent" };
      throw e;
    }
    if (status.status !== "finalized") return { state: "pending" };
    const summary = status.outcome.summary as { transactionType?: string };
    return { state: "finalized", failed: summary.transactionType === "failed", events: deplaceEvents(summary, this.contract) };
  }

  async finalizedNonce(account: string): Promise<bigint> {
    return (await this.client.getAccountInfo(AccountAddress.fromBase58(account))).accountNonce.value;
  }

  async lastFinalizedTime(): Promise<number> {
    const time = (await this.client.getConsensusStatus()).lastFinalizedTime;
    if (!time) throw new Error("the node gave no last finalized time, so the kit can't tell whether an old transaction may still land");
    return time.getTime();
  }
}
