import type { ContractRef } from "./types.js";

export interface Config {
  grpcHost: string;
  grpcPort: number;
  genesisHash: string;
  walletProxy: string;
  /** Hosted Agent Registry REST base URL. Calls must add network=testnet. */
  badgeApi: string;
  registry: ContractRef;
  /** deplace instance; null until scripts/deploy.ts has run. */
  contract: ContractRef | null;
  rewardTokenId: string;
  faucetUrl: string | null;
  publicBaseUrl: string;
  port: number;
  dbPath: string;
  reviewWindowMs: bigint;
  paymentWindowMs: bigint;
  sponsorMinCcd: bigint;
  keyFiles: {
    sponsor: string;
    operator: string;
    attestor: string;
    agent: string;
    poster: string;
    workerHuman: string;
  };
}

type Env = Record<string, string | undefined>;

const str = (env: Env, name: string, fallback: string): string => {
  const v = env[name]?.trim();
  return v ? v : fallback;
};

const u64 = (env: Env, name: string, fallback: bigint): bigint => {
  const v = env[name]?.trim();
  if (!v) return fallback;
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a non-negative integer, got "${v}"`);
  return BigInt(v);
};

const int = (env: Env, name: string, fallback: number): number => {
  const v = u64(env, name, BigInt(fallback));
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${name} is too large`);
  return Number(v);
};

const THREE_DAYS_MS = 3n * 24n * 60n * 60n * 1000n;

/** Reads the board's configuration from environment variables (see .env.example). */
export function loadConfig(env: Env): Config {
  const contractIndex = env.CONTRACT_INDEX?.trim();
  if (contractIndex && !/^\d+$/.test(contractIndex)) {
    throw new Error(`CONTRACT_INDEX must be a non-negative integer, got "${contractIndex}"`);
  }
  return {
    grpcHost: str(env, "GRPC_HOST", "grpc.testnet.concordium.com"),
    grpcPort: int(env, "GRPC_PORT", 20000),
    genesisHash: str(env, "GENESIS_HASH", "4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796"),
    walletProxy: str(env, "WALLET_PROXY", "https://wallet-proxy.testnet.concordium.com"),
    badgeApi: str(env, "BADGE_API", "https://agent-registry-mcp.concordium.com"),
    registry: { index: u64(env, "REGISTRY_INDEX", 12802n), subindex: u64(env, "REGISTRY_SUBINDEX", 0n) },
    contract: contractIndex ? { index: BigInt(contractIndex), subindex: u64(env, "CONTRACT_SUBINDEX", 0n) } : null,
    rewardTokenId: str(env, "REWARD_TOKEN_ID", "EUDemo"),
    faucetUrl: env.FAUCET_URL?.trim() || null,
    publicBaseUrl: str(env, "PUBLIC_BASE_URL", "http://localhost:8787"),
    port: int(env, "PORT", 8787),
    dbPath: str(env, "DB_PATH", "data/board.db"),
    reviewWindowMs: u64(env, "REVIEW_WINDOW_MS", THREE_DAYS_MS),
    paymentWindowMs: u64(env, "PAYMENT_WINDOW_MS", THREE_DAYS_MS),
    sponsorMinCcd: u64(env, "SPONSOR_MIN_CCD", 100n),
    keyFiles: {
      sponsor: str(env, "SPONSOR_KEY_FILE", "secrets/sponsor.export"),
      operator: str(env, "OPERATOR_KEY_FILE", "secrets/operator.export"),
      attestor: str(env, "ATTESTOR_KEY_FILE", "secrets/attestor.key"),
      agent: str(env, "AGENT_KEY_FILE", "secrets/worker-agent.export"),
      poster: str(env, "POSTER_KEY_FILE", "secrets/poster.export"),
      workerHuman: str(env, "WORKER_HUMAN_KEY_FILE", "secrets/worker-human.export"),
    },
  };
}
