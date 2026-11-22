import { describe, expect, it } from "vitest";
import { AccountAddress, ReturnValue } from "@concordium/web-sdk";
import type { Bounty } from "@deplace/shared";
import { transferNoter } from "../src/board/payments.js";
import { registryAgentWallet } from "../src/chain/registry.js";
import type { DepositInfo } from "../src/escrow/worker.js";

const acct = (fill: number) => AccountAddress.fromBuffer(new Uint8Array(32).fill(fill).buffer).address;
const POSTER = acct(1);
const WORKER = acct(2);

function bounty(over: Partial<Bounty> = {}): Bounty {
  return {
    id: 4n,
    poster: POSTER,
    posterAgent: null,
    kind: "Exclusive",
    specHash: "ab".repeat(32),
    reward: 100n,
    funding: { type: "NotFunded" },
    deadline: 0n,
    status: { type: "Accepted", worker: WORKER, at: 1n, workHash: "cd".repeat(32) },
    rejections: 0,
    lastRejectedAt: null,
    entryCount: 0,
    created: 0n,
    ...over,
  };
}

function setup(info: Partial<DepositInfo> | null, b = bounty()) {
  const recorded: unknown[] = [];
  const deposits: string[] = [];
  const note = transferNoter({
    rewardToken: "EUDemo",
    transferInfo: async (tx) => (info === null ? null : { tx, success: true, token: "EUDemo", from: POSTER, to: WORKER, amount: 100n, memo: "bounty:4", ...info }),
    noteDeposit: async (tx) => {
      deposits.push(tx);
      return { confirmed: true };
    },
    live: async () => b,
    payee: async (x) => (x.status.type === "Accepted" ? x.status.worker : null),
    recordPayout: async (id, p) => {
      recorded.push([id, p]);
      return "ff".repeat(32);
    },
  });
  return { note, recorded, deposits };
}

describe("direct payments and deposits", () => {
  it("routes fund:<id> transfers to the escrow worker", async () => {
    const s = setup({ memo: "fund:4" });
    expect(await s.note("aa".repeat(32))).toEqual({ kind: "deposit", outcome: { confirmed: true } });
    expect(s.deposits).toEqual(["aa".repeat(32)]);
  });

  it("records a correct direct payment as the payout", async () => {
    const s = setup({});
    expect(await s.note("aa".repeat(32))).toEqual({ kind: "payment", recordTx: "ff".repeat(32) });
    expect(s.recorded).toEqual([[4n, [{ to: WORKER, amount: 100n, tx: "aa".repeat(32) }]]]);
  });

  it("ignores payments that are short, misdirected, from someone else, in another token, or for escrowed bounties", async () => {
    for (const bad of [{ amount: 99n }, { to: acct(9) }, { from: acct(9) }, { token: "USDR" }, { success: false }, { memo: "hello" }]) {
      const s = setup(bad);
      expect((await s.note("aa".repeat(32))).kind).toBe("ignored");
      expect(s.recorded).toEqual([]);
    }
    const s = setup({}, bounty({ funding: { type: "Escrowed", fundingTx: "11".repeat(32) } }));
    expect((await s.note("aa".repeat(32))).kind).toBe("ignored");
  });

  it("ignores unknown transactions", async () => {
    expect((await setup(null).note("aa".repeat(32))).kind).toBe("ignored");
  });
});

describe("registryAgentWallet", () => {
  const node = (hex: string | { failure: number }) => ({
    invokeContract: async (ctx: any) => {
      node.last = { method: ctx.method.value, parameter: Buffer.from(ctx.parameter.buffer).toString("hex") };
      return typeof hex === "string"
        ? { tag: "success", usedEnergy: 0n, returnValue: ReturnValue.fromHexString(hex), events: [] }
        : { tag: "failure", usedEnergy: 0n, reason: { tag: "RejectedReceive", rejectReason: hex.failure } };
    },
  });
  node.last = { method: "", parameter: "" } as { method: string; parameter: string };
  const reg = { index: 12802n, subindex: 0n };

  it("asks CIS-8004.getAgentWallet with a CIS-2 u64 token id", async () => {
    await registryAgentWallet(node("00") as any, reg, 258n);
    expect(node.last).toEqual({ method: "CIS-8004.getAgentWallet", parameter: "08" + "0201000000000000" });
  });

  it("decodes Option<AccountAddress> and Option<Address::Account>", async () => {
    expect(await registryAgentWallet(node("01" + "02".repeat(32)) as any, reg, 1n)).toBe(WORKER);
    expect(await registryAgentWallet(node("0100" + "02".repeat(32)) as any, reg, 1n)).toBe(WORKER);
    expect(await registryAgentWallet(node("00") as any, reg, 1n)).toBeNull();
  });

  it("treats AgentNotFound as no wallet and other rejections as errors", async () => {
    expect(await registryAgentWallet(node({ failure: -7200 }) as any, reg, 1n)).toBeNull();
    await expect(registryAgentWallet(node({ failure: -1 }) as any, reg, 1n)).rejects.toThrow(/rejected/);
  });
});
