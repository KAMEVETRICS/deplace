import { verifyMessageSignature, type AccountInfo, type AccountTransactionSignature } from "@concordium/web-sdk";

export type MinimalAccountInfo = Pick<AccountInfo, "accountAddress" | "accountThreshold" | "accountCredentials">;

/** Reads an account's on-chain keys and credentials. Resolves null when the account does not exist. */
export type AccountInfoLookup = (address: string) => Promise<MinimalAccountInfo | null>;

/**
 * True when `signature` is a valid Concordium message signature over `message`
 * by the keys `address` holds on chain. A malformed signature is a failed check,
 * not an error. Lookup (network) errors propagate.
 */
export async function verifyAccountSignature(
  lookup: AccountInfoLookup,
  address: string,
  message: string,
  signature: AccountTransactionSignature,
): Promise<boolean> {
  const info = await lookup(address);
  if (!info) return false;
  try {
    return await verifyMessageSignature(message, signature, info);
  } catch {
    // The SDK throws for signatures naming credential or key indices the account does not have.
    return false;
  }
}

export interface AccountIdentity {
  kind: "person" | "company";
  idpIndex: number;
  idpName: string;
}

/** Testnet identity provider that issues company identities (Global FinReg; index 3 on mainnet). */
export const TESTNET_COMPANY_IDPS = [4];

/**
 * Says which identity provider issued the account's first credential. Every
 * Concordium account is opened from a verified identity, so this is the label the
 * board shows; no attributes are revealed.
 */
export async function classifyAccount(
  lookup: AccountInfoLookup,
  idpName: (index: number) => string | undefined,
  address: string,
  companyIdps: number[] = TESTNET_COMPANY_IDPS,
): Promise<AccountIdentity> {
  const info = await lookup(address);
  if (!info) throw new Error(`account ${address} does not exist`);
  const cred = info.accountCredentials[0] as { value?: { contents?: { ipIdentity?: number } } } | undefined;
  const idpIndex = cred?.value?.contents?.ipIdentity;
  if (typeof idpIndex !== "number") throw new Error(`account ${address} has no identity credential at index 0`);
  return {
    kind: companyIdps.includes(idpIndex) ? "company" : "person",
    idpIndex,
    idpName: idpName(idpIndex) ?? `identity provider ${idpIndex}`,
  };
}
