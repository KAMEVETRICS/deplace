import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AccountAddress, SequenceNumber, Transaction, TransactionHash, buildBasicAccountSigner } from "@concordium/web-sdk";
import { Operator } from "../src/chain/operator.js";

const addr = (fill: number) => AccountAddress.fromBuffer(new Uint8Array(32).fill(fill).buffer).address;

function wallet() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const hex = privateKey.export({ format: "der", type: "pkcs8" }).subarray(16).toString("hex");
  return { address: addr(4), signer: buildBasicAccountSigner(hex) };
}

/** A node that hashes what it receives the way Concordium nodes do: SHA-256 of the block item. */
function node() {
  const sent: Uint8Array[] = [];
  return {
    sent,
    client: {
      getNextAccountNonce: async () => ({ nonce: SequenceNumber.create(4n), allFinal: true }),
      sendTransaction: async (tx: Transaction.Finalized) => {
        const bytes = Transaction.serializeBlockItem(tx);
        sent.push(bytes);
        return TransactionHash.fromHexString(createHash("sha256").update(bytes).digest("hex"));
      },
    },
  };
}

describe("operator transfers", () => {
  it("stores the hash the node assigns to the transfer, so the escrow worker finds it again", async () => {
    const n = node();
    const op = new Operator(n.client as never, wallet(), { index: 1n, subindex: 0n }, { tokenId: "EUDemo", decimals: 6 });
    const p = await op.prepareTransfer(addr(7), 1_000_000n, "bounty:0");
    await p.submit();
    expect(n.sent).toHaveLength(1);
    expect(p.hash).toBe(createHash("sha256").update(n.sent[0]!).digest("hex"));
  });
});
