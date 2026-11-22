import { existsSync, readFileSync } from "node:fs";
import {
  AccountAddress,
  buildAccountSigner,
  parseWallet,
  signMessage,
  Transaction,
  type AccountSigner,
  type AccountTransactionSignature,
} from "@concordium/web-sdk";

export interface AgentKeys {
  address: string;
  signer: AccountSigner;
  /** Credential 0 / key 0, for the x402 client signer. */
  privateKeyHex: string;
}

/** Loads the agent's account from a Concordium Wallet for Web key export. */
export function loadAgentKeys(file: string): AgentKeys {
  if (!existsSync(file)) throw new Error(`key export ${file} not found (see docs/setup-accounts.md)`);
  const w = parseWallet(readFileSync(file, "utf8"));
  const privateKeyHex = w.value.accountKeys.keys[0]?.keys[0]?.signKey;
  if (!privateKeyHex) throw new Error(`${file}: no key at credential 0, index 0`);
  return { address: w.value.address, signer: buildAccountSigner(w), privateKeyHex };
}

/** Signs the board's login challenge (a Concordium account message signature). */
export function signChallenge(keys: AgentKeys, message: string): Promise<AccountTransactionSignature> {
  return signMessage(AccountAddress.fromBase58(keys.address), message, keys.signer);
}

/**
 * Adds the agent's sender signature to a transaction the board prepared (and its sponsor
 * co-signed). Refuses transactions for another sender: the agent only signs its own.
 */
export async function signPrepared(keys: AgentKeys, txJson: string): Promise<string> {
  const tx = Transaction.signableFromJSON(JSON.parse(txJson));
  if (tx.header.sender.address !== keys.address) throw new Error(`refusing to sign: transaction sender ${tx.header.sender.address} is not ${keys.address}`);
  return Transaction.toJSONString(await Transaction.sign(tx, keys.signer));
}
