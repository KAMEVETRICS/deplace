import { credentials } from "@grpc/grpc-js";
import { ContractAddress, Parameter, ReceiveName, ReturnValue } from "@concordium/web-sdk";
import { ConcordiumGRPCNodeClient } from "@concordium/web-sdk/nodejs";
import { Token, TokenId } from "@concordium/web-sdk/plt";
import { decodeConfig, decodeOptionBounty, decodeOptionEntry, encodeIdEntry, encodeU64, type Bounty } from "@deplace/shared";

/** What the agent reads from the chain before it pays anyone. */
export interface ChainReads {
  bounty(id: bigint): Promise<Bounty>;
  /** The account the contract says is owed this bounty's reward right now, or null. */
  payee(b: Bounty): Promise<string | null>;
  /** The escrow account: the operator in the contract's configuration. */
  escrowAccount(): Promise<string>;
}

/**
 * The agent's own read access to the chain, so that the rails do not depend on what the
 * board says: token decimals, and who is owed what on the Deplace contract.
 */
export class AgentChain implements ChainReads {
  readonly client: ConcordiumGRPCNodeClient;

  constructor(
    host: string,
    port: number,
    private readonly contract: { index: bigint; subindex: bigint },
  ) {
    this.client = new ConcordiumGRPCNodeClient(host, port, credentials.createSsl(), { timeout: 30_000 });
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
}
