import { credentials } from "@grpc/grpc-js";
import { ConcordiumGRPCNodeClient } from "@concordium/web-sdk/nodejs";

/** Testnet node client over TLS (the public endpoint refuses plaintext). */
export function grpcClient(cfg: { grpcHost: string; grpcPort: number }): ConcordiumGRPCNodeClient {
  return new ConcordiumGRPCNodeClient(cfg.grpcHost, cfg.grpcPort, credentials.createSsl(), { timeout: 30_000 });
}

/** True for gRPC NOT_FOUND, which the node returns for unknown transaction hashes and accounts. */
export function isNotFound(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown };
  return err?.code === 5 || err?.code === "NOT_FOUND" || (typeof err?.message === "string" && /NOT_FOUND|not found/i.test(err.message));
}

export const bigintJson = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

/** True for failures that waiting can fix: the node unavailable, a failed DNS lookup, a timeout, a reset connection. */
export function isTransient(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown };
  if (err?.code === 14 || err?.code === "UNAVAILABLE" || err?.code === 4 || err?.code === "DEADLINE_EXCEEDED") return true;
  return typeof err?.message === "string" && /Name resolution failed|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT/i.test(err.message);
}

/**
 * Runs `fn`, retrying transient failures with a pause that grows by `delayMs` each time.
 * Any other error, and the last transient one, is thrown.
 */
export async function retrying<T>(
  label: string,
  fn: () => Promise<T>,
  o: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void>; log?: (message: string) => void } = {},
): Promise<T> {
  const attempts = o.attempts ?? 6;
  const delayMs = o.delayMs ?? 2_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = o.log ?? ((m: string) => console.warn(m));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransient(e) || attempt >= attempts) throw e;
      log(`[startup] ${label} failed (${(e as Error).message}); trying again in ${(delayMs * attempt) / 1000} s (attempt ${attempt + 1} of ${attempts})`);
      await sleep(delayMs * attempt);
    }
  }
}
