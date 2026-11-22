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
