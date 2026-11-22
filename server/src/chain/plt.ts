import { AccountAddress, TransactionHash, type ConcordiumGRPCClient } from "@concordium/web-sdk";
import { Cbor, CborMemo, Token, TokenId } from "@concordium/web-sdk/plt";
import type { DepositInfo, TxState } from "../escrow/worker.js";
import { bigintJson, isNotFound } from "./grpc.js";

type Node = Pick<ConcordiumGRPCClient, "getAccountInfo" | "getBlockItemStatus">;

function memoText(memo: unknown): string | null {
  if (!memo) return null;
  try {
    const v = CborMemo.parse(memo as CborMemo.Type);
    return typeof v === "string" ? v : null;
  } catch {
    return null; // a memo that is not CBOR text is not one of ours
  }
}

/** Reads the reward token (a PLT) from the chain: decimals, allow list, transfers. */
export class PltClient {
  constructor(
    private readonly client: Node,
    readonly tokenId: string,
  ) {}

  async decimals(): Promise<number> {
    const token = await Token.fromId(this.client as unknown as ConcordiumGRPCClient, TokenId.fromString(this.tokenId));
    return token.info.state.decimals;
  }

  /** EUDemo has an allow list: transfers fail unless sender and receiver are both on it. */
  async isOnAllowList(account: string): Promise<boolean> {
    let info;
    try {
      info = await this.client.getAccountInfo(AccountAddress.fromBase58(account));
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
    const t = info.accountTokens.find((x) => x.id.value === this.tokenId);
    if (!t?.state.moduleState) return false;
    const state = Cbor.decode(t.state.moduleState, "TokenModuleAccountState");
    return state.allowList === true;
  }

  /** The token transfer in a finalized transaction, or null while it is unknown or not final. */
  async transferInfo(tx: string): Promise<DepositInfo | null> {
    let st;
    try {
      st = await this.client.getBlockItemStatus(TransactionHash.fromHexString(tx));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
    if (st.status !== "finalized") return null;
    const s = st.outcome.summary as { type?: string; transactionType?: string; sender?: AccountAddress.Type; events?: unknown[] };
    if (s?.type !== "accountTransaction") return null;
    if (s.transactionType === "failed") {
      return { tx, success: false, token: this.tokenId, from: s.sender?.address ?? "", to: "", amount: 0n, memo: null };
    }
    if (s.transactionType !== "tokenUpdate") return null;
    const ev = (s.events ?? []).find((e) => (e as { tag?: string })?.tag === "TokenTransfer") as
      | { tokenId: TokenId.Type; from: { address: AccountAddress.Type }; to: { address: AccountAddress.Type }; amount: { value: bigint }; memo?: unknown }
      | undefined;
    if (!ev) return null;
    return {
      tx,
      success: true,
      token: ev.tokenId.value,
      from: ev.from.address.address,
      to: ev.to.address.address,
      amount: ev.amount.value,
      memo: memoText(ev.memo),
    };
  }

  async txStatus(hash: string): Promise<TxState> {
    let st;
    try {
      st = await this.client.getBlockItemStatus(TransactionHash.fromHexString(hash));
    } catch (e) {
      if (isNotFound(e)) return { state: "absent" };
      throw e;
    }
    if (st.status !== "finalized") return { state: "pending" };
    const s = st.outcome.summary as { transactionType?: string; rejectReason?: unknown };
    if (s?.transactionType === "failed") return { state: "failed", reason: JSON.stringify(s.rejectReason, bigintJson) };
    return { state: "success" };
  }
}
