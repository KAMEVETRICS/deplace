import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AccountAddress } from "@concordium/web-sdk";

/** Writes a Concordium Wallet for Web key export of a throwaway account, in the shape parseWallet reads, to `dir`; returns its path. */
export function keyExport(dir: string, name = "agent.export"): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signKey = privateKey.export({ format: "der", type: "pkcs8" }).subarray(16).toString("hex");
  const verifyKey = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("hex");
  const address = AccountAddress.fromBuffer(new Uint8Array(32).fill(1).buffer).address;
  const file = join(dir, name);
  writeFileSync(
    file,
    JSON.stringify({
      type: "concordium-browser-wallet-account",
      v: 0,
      environment: "testnet",
      value: { accountKeys: { keys: { 0: { keys: { 0: { signKey, verifyKey } }, threshold: 1 } }, threshold: 1 }, credentials: { 0: "00".repeat(48) }, address },
    }),
  );
  return file;
}
