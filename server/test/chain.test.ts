import { describe, expect, it } from "vitest";
import { AccountAddress, ContractEvent, ReturnValue, TransactionHash } from "@concordium/web-sdk";
import { Cbor, CborMemo, TokenAmount, TokenHolder, TokenId } from "@concordium/web-sdk/plt";
import { BountyContract, ContractRejected, eventsFromSummary } from "../src/chain/contract.js";
import { PltClient } from "../src/chain/plt.js";

const acct = (fill: number) => AccountAddress.fromBuffer(new Uint8Array(32).fill(fill).buffer);
const BOUNTY_HEX =
  "01" + "0700000000000000" + "03".repeat(32) + "01" + "0500000000000000" + "01" + "ab".repeat(32) + "6400000000000000" +
  "01" + "11".repeat(32) + "0807060504030201" + "02" + "04".repeat(32) + "00" + "cd".repeat(32) + "0900000000000000" +
  "02" + "01" + "0800000000000000" + "03000000" + "0100000000000000";
const CONFIG_HEX = (nextId: string) =>
  "01".repeat(32) + "02".repeat(32) + "aa".repeat(32) + "0232000000000000" + "0000000000000000" + "06000000" +
  Buffer.from("EUDemo").toString("hex") + "60ea000000000000" + "c0d4010000000000" + nextId;

/** Records invokeContract calls and answers from a table keyed by method name. */
function fakeNode(answers: Record<string, string | { failure: number }>) {
  const calls: { method: string; parameter: string }[] = [];
  return {
    calls,
    client: {
      invokeContract: async (ctx: any) => {
        const method = ctx.method.value as string;
        const parameter = Buffer.from(ctx.parameter.buffer).toString("hex");
        calls.push({ method, parameter });
        const a = typeof answers[method] === "function" ? (answers[method] as any)(parameter) : answers[method];
        if (a === undefined) throw new Error(`unexpected call ${method}`);
        if (typeof a === "object") return { tag: "failure", usedEnergy: 0n, reason: { tag: "RejectedReceive", rejectReason: a.failure } };
        return { tag: "success", usedEnergy: 0n, returnValue: ReturnValue.fromHexString(a), events: [] };
      },
    } as any,
  };
}

describe("BountyContract views", () => {
  const contract = { index: 13001n, subindex: 0n };

  it("reads a bounty with the encoded id", async () => {
    const node = fakeNode({ "deplace.view_bounty": BOUNTY_HEX });
    const b = await new BountyContract(node.client, contract).view(7n);
    expect(b?.id).toBe(7n);
    expect(b?.status.type).toBe("Submitted");
    expect(node.calls).toEqual([{ method: "deplace.view_bounty", parameter: "0700000000000000" }]);
  });

  it("returns null for a missing bounty", async () => {
    const node = fakeNode({ "deplace.view_bounty": "00" });
    expect(await new BountyContract(node.client, contract).view(99n)).toBeNull();
  });

  it("lists every bounty up to next_id", async () => {
    const node = fakeNode({ "deplace.view_config": CONFIG_HEX("0200000000000000"), "deplace.view_bounty": BOUNTY_HEX });
    const all = await new BountyContract(node.client, contract).all();
    expect(all).toHaveLength(2);
    expect(node.calls.map((c) => c.parameter)).toEqual(["", "0000000000000000", "0100000000000000"]);
  });

  it("names the error when a view is rejected", async () => {
    const node = fakeNode({ "deplace.view_split": { failure: -13 } });
    await expect(new BountyContract(node.client, contract).split(1n)).rejects.toThrow(/NotFound/);
  });
});

describe("eventsFromSummary", () => {
  const ours = { index: 13001n, subindex: 0n };
  const POSTED =
    "00" + "0000000000000000" + "03".repeat(32) + "00" + "00" + "6400000000000000" + "ab".repeat(32) + "0807060504030201";

  it("decodes our contract's events and ignores other contracts", () => {
    const summary = {
      transactionType: "update",
      events: [
        { tag: "Updated", address: ours, events: [ContractEvent.fromHexString(POSTED)] },
        { tag: "Updated", address: { index: 12802n, subindex: 0n }, events: [ContractEvent.fromHexString("ff")] },
      ],
    };
    const evs = eventsFromSummary(summary, ours);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "Posted", id: 0n, reward: 100n });
  });

  it("returns nothing for non-update transactions", () => {
    expect(eventsFromSummary({ transactionType: "tokenUpdate", events: [] }, ours)).toEqual([]);
    expect(eventsFromSummary({ transactionType: "failed" }, ours)).toEqual([]);
  });
});

describe("ContractRejected", () => {
  it("carries the contract error name", () => {
    const e = new ContractRejected("record_payout", -12);
    expect(e.errorName).toBe("InvalidParams");
    expect(e.message).toMatch(/record_payout.*InvalidParams/);
  });
});

describe("PltClient", () => {
  const tokenId = TokenId.fromString("EUDemo");
  const holder = (fill: number) => TokenHolder.fromAccountAddress(acct(fill));

  function nodeWithAccount(tokens: any[]) {
    return { getAccountInfo: async () => ({ accountTokens: tokens }) } as any;
  }

  it("reads allow-list membership from the account's token state", async () => {
    const on = nodeWithAccount([{ id: tokenId, state: { balance: TokenAmount.create(5n, 6), moduleState: Cbor.encode({ allowList: true }) } }]);
    const off = nodeWithAccount([{ id: tokenId, state: { balance: TokenAmount.create(0n, 6), moduleState: Cbor.encode({ allowList: false }) } }]);
    const none = nodeWithAccount([]);
    const other = nodeWithAccount([{ id: TokenId.fromString("USDR"), state: { balance: TokenAmount.create(1n, 6), moduleState: Cbor.encode({ allowList: true }) } }]);
    const addr = acct(1).address;
    expect(await new PltClient(on, "EUDemo").isOnAllowList(addr)).toBe(true);
    expect(await new PltClient(off, "EUDemo").isOnAllowList(addr)).toBe(false);
    expect(await new PltClient(none, "EUDemo").isOnAllowList(addr)).toBe(false);
    expect(await new PltClient(other, "EUDemo").isOnAllowList(addr)).toBe(false);
  });

  function nodeWithStatus(status: any) {
    return {
      getBlockItemStatus: async () => {
        if (status instanceof Error) throw status;
        return status;
      },
    } as any;
  }
  const finalized = (summary: any) => ({ status: "finalized", outcome: { blockHash: {}, summary } });
  const tx = "ab".repeat(32);

  it("decodes a finalized token transfer with its memo", async () => {
    const node = nodeWithStatus(
      finalized({
        type: "accountTransaction",
        sender: acct(3),
        transactionType: "tokenUpdate",
        events: [{ tag: "TokenTransfer", tokenId, from: holder(3), to: holder(10), amount: TokenAmount.create(100n, 6), memo: CborMemo.fromString("fund:4") }],
      }),
    );
    expect(await new PltClient(node, "EUDemo").transferInfo(tx)).toEqual({
      tx,
      success: true,
      token: "EUDemo",
      from: acct(3).address,
      to: acct(10).address,
      amount: 100n,
      memo: "fund:4",
    });
  });

  it("reports a rejected token update as unsuccessful, and unknown hashes as null", async () => {
    const failed = nodeWithStatus(finalized({ type: "accountTransaction", sender: acct(3), transactionType: "failed", rejectReason: { tag: "TokenUpdateTransactionFailed" } }));
    expect(await new PltClient(failed, "EUDemo").transferInfo(tx)).toMatchObject({ success: false });
    const pending = nodeWithStatus({ status: "received" });
    expect(await new PltClient(pending, "EUDemo").transferInfo(tx)).toBeNull();
    const unknown = nodeWithStatus(Object.assign(new Error("NOT_FOUND: transaction not found"), { code: 5 }));
    expect(await new PltClient(unknown, "EUDemo").transferInfo(tx)).toBeNull();
  });

  it("maps transaction status for the escrow worker", async () => {
    const ok = nodeWithStatus(finalized({ type: "accountTransaction", transactionType: "tokenUpdate", events: [] }));
    expect(await new PltClient(ok, "EUDemo").txStatus(tx)).toEqual({ state: "success" });
    const bad = nodeWithStatus(finalized({ type: "accountTransaction", transactionType: "failed", rejectReason: { tag: "TokenUpdateTransactionFailed", details: "NotAllowed" } }));
    expect(await new PltClient(bad, "EUDemo").txStatus(tx)).toMatchObject({ state: "failed", reason: expect.stringMatching(/TokenUpdateTransactionFailed/) });
    expect(await new PltClient(nodeWithStatus({ status: "committed", outcomes: [] }), "EUDemo").txStatus(tx)).toEqual({ state: "pending" });
    const missing = nodeWithStatus(Object.assign(new Error("NOT_FOUND"), { code: 5 }));
    expect(await new PltClient(missing, "EUDemo").txStatus(tx)).toEqual({ state: "absent" });
    const down = nodeWithStatus(Object.assign(new Error("UNAVAILABLE"), { code: 14 }));
    await expect(new PltClient(down, "EUDemo").txStatus(tx)).rejects.toThrow(/UNAVAILABLE/);
  });

  it("hashes are accepted in either case", () => {
    expect(() => TransactionHash.fromHexString(tx)).not.toThrow();
  });
});
