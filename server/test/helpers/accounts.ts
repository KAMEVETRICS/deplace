import { generateKeyPairSync } from "node:crypto";
import { AccountAddress, buildBasicAccountSigner, signMessage, type AccountTransactionSignature } from "@concordium/web-sdk";
import type { AccountInfoLookup, MinimalAccountInfo } from "../../src/identity/account.js";

/** A throwaway ed25519 account for tests: address, raw keys, and the AccountInfo the node would return. */
export interface TestAccount {
  address: string;
  privateKeyHex: string;
  publicKeyHex: string;
  info: MinimalAccountInfo;
  sign(message: string): Promise<AccountTransactionSignature>;
}

export function testAccount(fill: number, ipIdentity = 0): TestAccount {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyHex = privateKey.export({ format: "der", type: "pkcs8" }).subarray(16).toString("hex");
  const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("hex");
  const address = AccountAddress.fromBuffer(new Uint8Array(32).fill(fill).buffer).address;
  const info: MinimalAccountInfo = {
    accountAddress: AccountAddress.fromBase58(address),
    accountThreshold: 1,
    accountCredentials: {
      0: {
        v: 0,
        value: {
          type: "normal",
          contents: {
            ipIdentity,
            credentialPublicKeys: { threshold: 1, keys: { 0: { schemeId: "Ed25519", verifyKey: publicKeyHex } } },
          },
        },
      },
    } as unknown as MinimalAccountInfo["accountCredentials"],
  };
  const signer = buildBasicAccountSigner(privateKeyHex);
  return {
    address,
    privateKeyHex,
    publicKeyHex,
    info,
    sign: (message) => signMessage(AccountAddress.fromBase58(address), message, signer),
  };
}

export function lookupOf(...accounts: TestAccount[]): AccountInfoLookup {
  return async (address) => accounts.find((x) => x.address === address)?.info ?? null;
}
