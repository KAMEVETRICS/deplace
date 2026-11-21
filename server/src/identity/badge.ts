export type BadgeCheck =
  | { ok: true; tokenId: bigint; owner: string; agentUri: string }
  | { ok: false; reason: string; unavailable?: true; retryAfter?: number };

interface Verdict {
  badge_valid?: unknown;
  token_id?: unknown;
  agent_uri?: unknown;
  on_chain?: { owner_account?: unknown; status?: unknown };
  issues?: { message?: unknown }[];
  message?: unknown;
}

/**
 * Asks the hosted Agent Registry service whether a "Verified by Concordium" badge
 * is valid on testnet: Active on-chain record, card served at agent_uri, and the
 * served bytes' SHA-256 equal to the on-chain metadata hash. The service defaults
 * to mainnet, so the query always says network=testnet.
 *
 * Never passes on doubt: timeouts, 5xx and 429 come back as `unavailable`.
 */
export async function checkBadge(
  fetchFn: typeof fetch,
  apiBase: string,
  badge: string,
  opts: { timeoutMs?: number } = {},
): Promise<BadgeCheck> {
  const url = `${apiBase.replace(/\/+$/, "")}/v1/check-badge/${encodeURIComponent(badge)}?network=testnet`;
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
  } catch (e) {
    return { ok: false, unavailable: true, reason: `badge service unavailable (${(e as Error).name ?? "network error"}), retry later` };
  }

  if (res.status === 429) {
    const header = Number(res.headers.get("retry-after"));
    const retryAfter = Number.isFinite(header) && header > 0 ? header : 30;
    return { ok: false, unavailable: true, retryAfter, reason: `badge service rate-limited, retry after ${retryAfter} s` };
  }
  if (res.status >= 500) return { ok: false, unavailable: true, reason: `badge service unavailable (HTTP ${res.status}), retry later` };

  const body = (await res.json().catch(() => null)) as Verdict | null;
  if (res.status === 404) return { ok: false, reason: `no agent at badge ${badge}` };
  if (res.status === 409) return { ok: false, reason: "agent is revoked, so no badge is issued" };
  if (res.status !== 200 || !body) {
    return { ok: false, reason: `badge check failed (HTTP ${res.status}${typeof body?.message === "string" ? `: ${body.message}` : ""})` };
  }
  if (body.badge_valid !== true) {
    const issue = body.issues?.[0]?.message;
    return { ok: false, reason: `badge is not valid: ${typeof issue === "string" ? issue : "no reason given"}` };
  }

  const owner = body.on_chain?.owner_account;
  const tokenId = body.token_id;
  if (body.on_chain?.status !== "Active" || typeof owner !== "string" || (typeof tokenId !== "number" && typeof tokenId !== "string")) {
    return { ok: false, reason: "badge service returned an unexpected verdict" };
  }
  return { ok: true, tokenId: BigInt(tokenId), owner, agentUri: typeof body.agent_uri === "string" ? body.agent_uri : "" };
}
