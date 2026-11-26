import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildAccountSigner, parseWallet } from "@concordium/web-sdk";
import type { Wallet } from "./operator.js";

/** Loads a Concordium Wallet for Web key export. */
export function loadWallet(file: string): Wallet {
  if (!existsSync(file)) throw new Error(`key export ${file} not found (export it from Concordium Wallet for Web: your account, Private key, Export)`);
  const w = parseWallet(readFileSync(file, "utf8"));
  return { address: w.value.address, signer: buildAccountSigner(w) };
}

/** The raw key of credential 0 / key 0, for libraries that take a hex key (x402's facilitator signer). */
export function walletPrivateKey(file: string): { address: string; key: string } {
  const w = parseWallet(readFileSync(file, "utf8"));
  const key = w.value.accountKeys.keys[0]?.keys[0]?.signKey;
  if (!key) throw new Error(`${file}: no key at credential 0, index 0`);
  return { address: w.value.address, key };
}

/** The attestor's ed25519 seed (hex). Created on first use; it never leaves secrets/. */
export function loadOrCreateAttestorSeed(file: string): string {
  if (existsSync(file)) {
    const seed = readFileSync(file, "utf8").trim();
    if (!/^[0-9a-f]{64}$/i.test(seed)) throw new Error(`${file} must hold a 32-byte hex seed`);
    return seed;
  }
  mkdirSync(dirname(file), { recursive: true });
  const seed = randomBytes(32).toString("hex");
  writeFileSync(file, seed + "\n", { mode: 0o600 });
  return seed;
}
