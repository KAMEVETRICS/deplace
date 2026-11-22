import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AccountAddress, SequenceNumber, Transaction, TransactionExpiry, buildBasicAccountSigner, CcdAmount } from "@concordium/web-sdk";
import type { AgentKeys } from "../src/signer.js";
import type { TaskHandler } from "../src/tasks/types.js";
import { workOne, type Board } from "../src/worker.js";

function keys(fill: number): AgentKeys {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyHex = privateKey.export({ format: "der", type: "pkcs8" }).subarray(16).toString("hex");
  return { address: AccountAddress.fromBuffer(new Uint8Array(32).fill(fill).buffer).address, privateKeyHex, signer: buildBasicAccountSigner(privateKeyHex) };
}
const me = keys(1);
const poster = keys(2).address;

/** A prepared (unsigned) transaction for `sender`, as the board's prepare_* tools return. */
function prepared(sender: string) {
  const tx = Transaction.transfer({ amount: CcdAmount.fromMicroCcd(1n), toAddress: AccountAddress.fromBase58(poster) })
    .addMetadata({ sender: AccountAddress.fromBase58(sender), nonce: SequenceNumber.create(1), expiry: TransactionExpiry.futureMinutes(5) })
    .build();
  return { prepared: { txJson: Transaction.toJSONString(tx), feeSponsored: true } };
}

const handler: TaskHandler = {
  kind: "page-facts",
  canHandle: (s) => s.taskKind === "page-facts",
  run: async () => ({ preview: "preview text", full: '{"words":3}' }),
};

/** A scripted board: records calls; status walks Claimed -> Submitted -> Accepted -> Paid. */
function board(over: { bounties?: unknown[]; eligible?: boolean; statuses?: string[] } = {}) {
  const calls: { name: string; args: any }[] = [];
  const statuses = [...(over.statuses ?? ["Submitted", "Accepted", "Paid"])];
  const b: Board = {
    async call(name: string, args: Record<string, unknown>): Promise<any> {
      calls.push({ name, args });
      switch (name) {
        case "check_payout_eligibility":
          return (over.eligible ?? true) ? { ok: true } : { ok: false, reason: "not on allow list", faucetUrl: "https://faucet" };
        case "request_challenge":
          return { nonce: "n1", message: "Deplace/v1/login:n1" };
        case "login":
          return { token: "tok", identity: { account: me.address } };
        case "list_bounties":
          return {
            bounties: over.bounties ?? [
              { id: "3", kind: "Exclusive", poster: me.address, spec: { taskKind: "page-facts", input: {} } }, // own bounty: skipped
              { id: "4", kind: "Exclusive", poster, spec: { taskKind: "translate", input: {} } }, // not handled: skipped
              { id: "5", kind: "Exclusive", poster, spec: { taskKind: "page-facts", input: { url: "https://example.org" } } },
            ],
          };
        case "prepare_claim":
        case "prepare_submit":
          return prepared(me.address);
        case "submit_signed":
          return { txHash: "aa".repeat(32), link: "https://ccdexplorer.io/testnet/transaction/" + "aa".repeat(32), events: [] };
        case "get_status":
          return { status: { type: statuses.shift() ?? "Paid" }, funding: { type: "Escrowed" } };
        default:
          throw new Error(`unexpected tool ${name}`);
      }
    },
  };
  return { b, calls };
}

const opts = (b: Board, log: string[] = []) => ({ board: b, badge: "JyP9Badge", keys: me, handlers: [handler], log: (m: string) => log.push(m), pollMs: 0, sleep: async () => {} });

describe("reference worker", () => {
  it("logs in with its badge, claims the first bounty it can do, works it and waits for payment", async () => {
    const { b, calls } = board();
    const out = await workOne(opts(b));
    expect(out).toMatchObject({ bountyId: "5", status: "Paid" });
    expect(calls.map((c) => c.name)).toEqual([
      "check_payout_eligibility",
      "request_challenge",
      "login",
      "list_bounties",
      "prepare_claim",
      "submit_signed",
      "prepare_submit",
      "submit_signed",
      "get_status",
      "get_status",
      "get_status",
    ]);
    expect(calls.find((c) => c.name === "login")!.args).toMatchObject({ badge: "JyP9Badge", nonce: "n1" });
    expect(calls.find((c) => c.name === "prepare_submit")!.args).toMatchObject({ session: "tok", bounty_id: "5", preview: "preview text", full: '{"words":3}' });
    // What it submits is its own signature over the prepared transaction.
    const signed = Transaction.signableFromJSON(JSON.parse(calls.find((c) => c.name === "submit_signed")!.args.tx_json));
    if (signed.version !== 0) throw new Error("expected v0 fixture");
    expect(Object.keys(signed.signature)).toEqual(["0"]);
  });

  it("enters contests without claiming", async () => {
    const { b, calls } = board({ bounties: [{ id: "8", kind: "Contest", poster, spec: { taskKind: "page-facts", input: {} } }] });
    await workOne(opts(b));
    expect(calls.map((c) => c.name)).not.toContain("prepare_claim");
    expect(calls.map((c) => c.name)).toContain("prepare_submit");
  });

  it("stops before working when its payout account cannot be paid", async () => {
    const { b, calls } = board({ eligible: false });
    const log: string[] = [];
    await expect(workOne(opts(b, log))).rejects.toThrow(/allow list/);
    expect(calls.map((c) => c.name)).toEqual(["check_payout_eligibility"]);
  });

  it("returns null when there is nothing it can do", async () => {
    const { b } = board({ bounties: [] });
    expect(await workOne(opts(b))).toBeNull();
  });

  it("resubmits after a rejection", async () => {
    const { b, calls } = board({ statuses: ["Submitted", "Claimed", "Submitted", "Accepted", "Paid"] });
    const out = await workOne(opts(b));
    expect(out?.status).toBe("Paid");
    expect(calls.filter((c) => c.name === "prepare_submit")).toHaveLength(2);
  });

  it("gives up waiting at a final state that is not Paid", async () => {
    const { b } = board({ statuses: ["Submitted", "RejectedFinal"] });
    expect((await workOne(opts(b)))?.status).toBe("RejectedFinal");
  });
});
