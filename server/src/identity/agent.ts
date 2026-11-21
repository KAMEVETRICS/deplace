import type { AccountTransactionSignature } from "@concordium/web-sdk";
import { verifyAccountSignature, type AccountInfoLookup } from "./account.js";
import { checkBadge } from "./badge.js";

export interface AgentVerifierDeps {
  fetch: typeof fetch;
  badgeApi: string;
  lookup: AccountInfoLookup;
  /** CIS-8004 getAgentWallet for the token id; null when unset (e.g. right after a transfer). */
  agentWallet: (tokenId: bigint) => Promise<string | null>;
  timeoutMs?: number;
}

export type AgentVerification =
  | { ok: true; tokenId: bigint; owner: string; payoutAccount: string }
  | { ok: false; reason: string; unavailable?: true; retryAfter?: number };

/**
 * An agent proves itself with a valid badge plus a signature over a fresh board
 * challenge by its registry `agentWallet` account (the owner when no wallet is set).
 * Holding a copy of someone's badge is not enough. Payouts go to that same account.
 */
export async function verifyAgent(
  deps: AgentVerifierDeps,
  input: { badge: string; message: string; signature: AccountTransactionSignature },
): Promise<AgentVerification> {
  const badge = await checkBadge(deps.fetch, deps.badgeApi, input.badge, { timeoutMs: deps.timeoutMs });
  if (!badge.ok) return badge;
  const payoutAccount = (await deps.agentWallet(badge.tokenId)) ?? badge.owner;
  const signed = await verifyAccountSignature(deps.lookup, payoutAccount, input.message, input.signature);
  if (!signed) return { ok: false, reason: `challenge signature is not from the agent's wallet account ${payoutAccount}` };
  return { ok: true, tokenId: badge.tokenId, owner: badge.owner, payoutAccount };
}
