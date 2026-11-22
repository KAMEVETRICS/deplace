import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AccountAddress,
  CcdAmount,
  SequenceNumber,
  Transaction,
  TransactionExpiry,
  buildBasicAccountSigner,
  verifyMessageSignature,
} from "@concordium/web-sdk";
import { signChallenge, signPrepared, type AgentKeys } from "../src/signer.js";

function keys(fill: number): AgentKeys & { publicKeyHex: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyHex = privateKey.export({ format: "der", type: "pkcs8" }).subarray(16).toString("hex");
  const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("hex");
  const address = AccountAddress.fromBuffer(new Uint8Array(32).fill(fill).buffer).address;
  return { address, privateKeyHex, publicKeyHex, signer: buildBasicAccountSigner(privateKeyHex) };
}

describe("agent signer", () => {
  it("signs a login challenge the board can verify", async () => {
    const k = keys(1);
    const sig = await signChallenge(k, "BountyBoard/v1/login:abc");
    const info = {
      accountAddress: AccountAddress.fromBase58(k.address),
      accountThreshold: 1,
      accountCredentials: { 0: { v: 0, value: { type: "normal", contents: { credentialPublicKeys: { threshold: 1, keys: { 0: { schemeId: "Ed25519", verifyKey: k.publicKeyHex } } } } } } },
    } as never;
    expect(await verifyMessageSignature("BountyBoard/v1/login:abc", sig, info)).toBe(true);
  });

  it("adds its sender signature to a prepared transaction and keeps the payload", async () => {
    const k = keys(2);
    const tx = Transaction.transfer({ amount: CcdAmount.fromMicroCcd(1n), toAddress: AccountAddress.fromBase58(keys(3).address) })
      .addMetadata({ sender: AccountAddress.fromBase58(k.address), nonce: SequenceNumber.create(1), expiry: TransactionExpiry.futureMinutes(5) })
      .build();
    const signed = Transaction.signableFromJSON(JSON.parse(await signPrepared(k, Transaction.toJSONString(tx))));
    if (signed.version !== 0) throw new Error("expected v0");
    expect(Object.keys(signed.signature[0] ?? {})).toEqual(["0"]);
  });

  it("refuses to sign a transaction for another sender", async () => {
    const k = keys(4);
    const tx = Transaction.transfer({ amount: CcdAmount.fromMicroCcd(1n), toAddress: AccountAddress.fromBase58(keys(5).address) })
      .addMetadata({ sender: AccountAddress.fromBase58(keys(6).address), nonce: SequenceNumber.create(1), expiry: TransactionExpiry.futureMinutes(5) })
      .build();
    await expect(signPrepared(k, Transaction.toJSONString(tx))).rejects.toThrow(/sender/);
  });
});
