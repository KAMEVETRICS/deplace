import { ContractAddress, Parameter, ReceiveName, ReturnValue, type ConcordiumGRPCClient } from "@concordium/web-sdk";
import {
  contractErrorName,
  decodeConfig,
  decodeOptionBounty,
  decodeOptionEntry,
  decodeSplit,
  decodeStats,
  encodeAccount,
  encodeIdEntry,
  encodeU64,
  type Bounty,
  type BoardConfig,
  type ContractRef,
  type Entry,
  type Stats,
} from "@bounty/shared";
import { bigintJson } from "./grpc.js";

/** The contract rejected the call; `errorName` is the bounty_board `Error` variant. */
export class ContractRejected extends Error {
  readonly errorName: string;
  constructor(
    readonly entrypoint: string,
    readonly code: number,
  ) {
    super(`bounty_board.${entrypoint} rejected: ${contractErrorName(code)}`);
    this.name = "ContractRejected";
    this.errorName = contractErrorName(code);
  }
}

/** Read access to bounty_board through the node's invokeContract (no transaction, no fee). */
export class BountyContract {
  constructor(
    private readonly client: Pick<ConcordiumGRPCClient, "invokeContract">,
    readonly address: ContractRef,
  ) {}

  private async invoke(entrypoint: string, parameter: Uint8Array): Promise<Uint8Array> {
    const res = await this.client.invokeContract({
      contract: ContractAddress.create(this.address.index, this.address.subindex),
      method: ReceiveName.fromString(`bounty_board.${entrypoint}`),
      parameter: Parameter.fromBuffer(parameter.slice().buffer),
    });
    if (res.tag === "failure") {
      const reason = res.reason as { tag?: string; rejectReason?: number } | null;
      if (reason?.tag === "RejectedReceive" && typeof reason.rejectReason === "number") throw new ContractRejected(entrypoint, reason.rejectReason);
      throw new Error(`bounty_board.${entrypoint} invocation failed: ${JSON.stringify(reason, bigintJson)}`);
    }
    if (!res.returnValue) throw new Error(`bounty_board.${entrypoint} returned no value`);
    return ReturnValue.toBuffer(res.returnValue);
  }

  async view(id: bigint): Promise<Bounty | null> {
    return decodeOptionBounty(await this.invoke("view_bounty", encodeU64(id)));
  }

  async entry(id: bigint, entryId: number): Promise<Entry | null> {
    return decodeOptionEntry(await this.invoke("view_entry", encodeIdEntry(id, entryId)));
  }

  async split(id: bigint): Promise<{ to: string; amount: bigint }[]> {
    return decodeSplit(await this.invoke("view_split", encodeU64(id)));
  }

  async stats(account: string): Promise<Stats> {
    return decodeStats(await this.invoke("view_stats", encodeAccount(account)));
  }

  async config(): Promise<BoardConfig> {
    return decodeConfig(await this.invoke("view_config", new Uint8Array()));
  }

  /** Every bounty, by reading ids 0..next_id. Fine at hackathon scale; an indexer would page. */
  async all(): Promise<Bounty[]> {
    const { nextId } = await this.config();
    const out: Bounty[] = [];
    for (let id = 0n; id < nextId; id++) {
      const b = await this.view(id);
      if (b) out.push(b);
    }
    return out;
  }
}
