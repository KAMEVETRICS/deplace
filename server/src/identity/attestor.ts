import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { postAttestationBytes, workAttestationBytes, type PostAttestation, type WorkAttestation } from "@deplace/shared";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface SignedAttestation {
  /** Unix ms; the contract refuses the attestation after this. */
  expiry: bigint;
  signatureHex: string;
}

/**
 * The board's attestor key. After checking a poster's identity or an agent's badge and
 * challenge off-chain, the board signs that fact for one transaction; the deplace
 * contract verifies the signature, so nobody can post, claim or enter without the check.
 */
export class Attestor {
  readonly publicKeyHex: string;
  private readonly key: KeyObject;

  constructor(
    seedHex: string,
    private readonly nowMs: () => bigint = () => BigInt(Date.now()),
  ) {
    if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) throw new Error("attestor seed must be 32 bytes of hex");
    this.key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
    this.publicKeyHex = createPublicKey(this.key).export({ format: "der", type: "spki" }).subarray(12).toString("hex");
  }

  attestPost(a: Omit<PostAttestation, "expiry">, ttlMs: bigint): SignedAttestation {
    const expiry = this.nowMs() + ttlMs;
    return { expiry, signatureHex: this.sign(postAttestationBytes({ ...a, expiry })) };
  }

  attestWork(a: Omit<WorkAttestation, "expiry">, ttlMs: bigint): SignedAttestation {
    const expiry = this.nowMs() + ttlMs;
    return { expiry, signatureHex: this.sign(workAttestationBytes({ ...a, expiry })) };
  }

  private sign(message: Uint8Array): string {
    return sign(null, Buffer.from(message), this.key).toString("hex");
  }
}
