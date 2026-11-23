import { Buffer } from "buffer";
import { detectConcordiumProvider, type WalletApi } from "@concordium/browser-wallet-api-helpers";
import { AccountTransactionType, Transaction } from "@concordium/web-sdk";
import type { Prepared } from "./types.js";

/** Concordium testnet genesis hash; the wallet reports the selected chain by it. */
const TESTNET = "4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796";

export async function connectWallet(): Promise<{ provider: WalletApi; account: string }> {
  let provider: WalletApi;
  try {
    provider = await detectConcordiumProvider(3000);
  } catch {
    throw new Error("Concordium Wallet for Web was not found. Install it from the Chrome Web Store and reload.");
  }
  const accounts = await provider.requestAccounts();
  const account = accounts[0];
  if (!account) throw new Error("The wallet did not share an account.");
  const chain = await provider.getSelectedChain();
  if (chain && !chain.toLowerCase().includes(TESTNET.slice(0, 32))) throw new Error("Switch Concordium Wallet for Web to Testnet (menu → Network → Testnet).");
  return { provider, account };
}

/**
 * What Concordium Wallet for Web answers while it is locked, and also when the site is not
 * connected to the account asked for. A locked wallet says this instead of asking to be unlocked.
 */
const NOT_WHITELISTED = "Site is not whitelisted";

/** Makes a wallet request, turning the wallet's misleading "not whitelisted" refusal into advice. */
async function askWallet<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (e) {
    if (e instanceof Error && e.message.includes(NOT_WHITELISTED)) {
      throw new Error(
        "Concordium Wallet for Web is locked, or this site is not connected to the account you signed in with. Unlock the wallet and try again; if that does not help, reload the page and connect again.",
        { cause: e },
      );
    }
    throw e;
  }
}

/** Has the wallet sign the board's login challenge with the account. */
export function signChallenge(provider: WalletApi, account: string, message: string) {
  return askWallet(() => provider.signMessage(account, message));
}

/**
 * Signs and submits a transaction the board prepared and its sponsor co-signed. The wallet
 * shows the contract call (decoded with the module schema) and submits it; the sender pays nothing.
 */
export async function sendPrepared(provider: WalletApi, account: string, prepared: Prepared, moduleSchemaBase64: string | null): Promise<string> {
  if (!prepared.feeSponsored) {
    throw new Error(`${prepared.notice ?? "This transaction is not sponsored."} The web app only submits sponsored transactions; use the reference agent or CLI for this one.`);
  }
  const tx = Transaction.signableFromJSON(JSON.parse(prepared.txJson));
  const isContractCall = (tx.payload as { type?: AccountTransactionType }).type === AccountTransactionType.Update;
  if (isContractCall) {
    if (!moduleSchemaBase64) throw new Error("The contract schema is not available from the board, so the wallet cannot show this call.");
    return askWallet(() => provider.sendSponsoredTransaction(account, tx as never, { type: "ModuleSchema", value: Buffer.from(moduleSchemaBase64, "base64") }));
  }
  return askWallet(() => provider.sendSponsoredTransaction(account, tx as never));
}
