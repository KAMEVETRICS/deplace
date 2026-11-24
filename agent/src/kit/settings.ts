import { isAbsolute, join } from "node:path";

/** Everything the kit is told by its owner, from its environment only (the MCP client's env block, or node --env-file). */
export interface KitSettings {
  keyFile: string;
  badge: string | null;
  boardMcpUrl: string;
  contract: { index: bigint; subindex: bigint };
  registry: { index: bigint; subindex: bigint };
  allowFees: boolean;
  maxEnergy: bigint;
  /** Decimal amounts of the reward token. */
  maxReward: string;
  dailyBudget: string;
  budgetFile: string;
  pendingFile: string;
  grpcHost: string;
  grpcPort: number;
  rewardTokenId: string;
  card: { name: string | null; description: string | null; url: string | null; file: string; skills: unknown[] | null };
}

type Env = Record<string, string | undefined>;

const DECIMAL = /^\d{1,12}(\.\d+)?$/;

function text(env: Env, name: string): string | null {
  return env[name]?.trim() || null;
}

function digits(env: Env, name: string, fallback: string): string {
  const v = text(env, name) ?? fallback;
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a whole number, got "${v}"`);
  return v;
}

function decimal(env: Env, name: string, fallback: string): string {
  const v = text(env, name) ?? fallback;
  if (!DECIMAL.test(v)) throw new Error(`${name} must be a decimal amount such as 5 or 2.5, got "${v}"`);
  return v;
}

/**
 * The kit's settings. Paths may be absolute or relative to the repository root. Throws, naming
 * the setting, on anything it cannot read, so a typo never turns into a silent default.
 */
export function loadKitSettings(env: Env, root: string): KitSettings {
  const path = (p: string) => (isAbsolute(p) ? join(p) : join(root, p));

  const keyFile = text(env, "AGENT_KEY_FILE");
  if (!keyFile) throw new Error("set AGENT_KEY_FILE to your agent's Concordium Wallet for Web key export (the agentWallet account of its badge)");

  const boardMcpUrl = text(env, "BOARD_MCP_URL") ?? "https://deplace.space/mcp";
  try {
    const u = new URL(boardMcpUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("not http(s)");
  } catch {
    throw new Error(`BOARD_MCP_URL must be the board's MCP URL, such as https://deplace.space/mcp; got "${boardMcpUrl}"`);
  }

  const allowFees = text(env, "AGENT_ALLOW_FEES") ?? "false";
  if (allowFees !== "true" && allowFees !== "false") throw new Error(`AGENT_ALLOW_FEES must be true or false, got "${allowFees}"`);

  let skills: unknown[] | null = null;
  const rawSkills = text(env, "AGENT_SKILLS");
  if (rawSkills) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawSkills);
    } catch (e) {
      throw new Error(`AGENT_SKILLS must be a JSON array of skills: ${(e as Error).message}`);
    }
    if (!Array.isArray(parsed)) throw new Error("AGENT_SKILLS must be a JSON array of skills, such as [{\"id\":\"page-facts\",\"name\":\"Page facts\"}]");
    skills = parsed;
  }

  return {
    keyFile: path(keyFile),
    badge: text(env, "AGENT_BADGE"),
    boardMcpUrl,
    contract: { index: BigInt(digits(env, "CONTRACT_INDEX", "13123")), subindex: BigInt(digits(env, "CONTRACT_SUBINDEX", "0")) },
    registry: { index: BigInt(digits(env, "REGISTRY_INDEX", "12802")), subindex: BigInt(digits(env, "REGISTRY_SUBINDEX", "0")) },
    allowFees: allowFees === "true",
    maxEnergy: 30_000n, // the board's own cap for contract calls
    maxReward: decimal(env, "AGENT_MAX_REWARD", "5"),
    dailyBudget: decimal(env, "AGENT_DAILY_BUDGET", "20"),
    budgetFile: path(text(env, "AGENT_BUDGET_FILE") ?? "data/agent-budget.json"),
    pendingFile: path(text(env, "AGENT_PENDING_FILE") ?? "data/agent-pending.json"),
    grpcHost: text(env, "GRPC_HOST") ?? "grpc.testnet.concordium.com",
    grpcPort: Number(digits(env, "GRPC_PORT", "20000")),
    rewardTokenId: text(env, "REWARD_TOKEN_ID") ?? "EUDemo",
    card: {
      name: text(env, "AGENT_NAME"),
      description: text(env, "AGENT_DESCRIPTION"),
      url: text(env, "AGENT_CARD_URL"),
      file: path(text(env, "AGENT_CARD_FILE") ?? "data/agent-card.json"),
      skills,
    },
  };
}
