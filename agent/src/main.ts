// Reference worker agent for Deplace.
//   npm start -w agent                        work: claim, do and submit one page-facts bounty, wait for payment
//   npm start -w agent -- --forever           keep working bounties
//   npm start -w agent -- --post              agent as poster: post, accept, pay on delivery with x402
//   npm start -w agent -- --post --escrow     agent as poster: post, escrow the reward with x402, accept
import { loadConfig, parseTokenAmount } from "@deplace/shared";
import { env, fromRoot } from "./env.js";
import { connectBoard } from "./board-client.js";
import { AgentChain } from "./chain.js";
import { agentTokenId } from "./identity.js";
import { postAndPay } from "./poster.js";
import { SpendBudget } from "./rails/budget.js";
import type { GuardOptions } from "./rails/guard.js";
import { AccountLock, lockFileFor } from "./rails/lock.js";
import { PendingStore } from "./rails/pending.js";
import { loadAgentKeys } from "./signer.js";
import { pageFacts } from "./tasks/page-facts.js";
import { workOne } from "./worker.js";

const cfg = loadConfig(process.env);
if (!cfg.contract) throw new Error("set CONTRACT_INDEX in .env: the agent signs calls to that Deplace contract and no other");
const keys = loadAgentKeys(fromRoot(env("AGENT_KEY_FILE", "secrets/worker-agent.export")));
const badge = env("AGENT_BADGE");
const tokenId = agentTokenId(badge, cfg.registry);
const url = env("BOARD_MCP_URL", "http://localhost:8787/mcp");
// One signer per account: a kit or another agent signing for this account at the same time is refused.
const pendingFile = fromRoot(env("AGENT_PENDING_FILE", "data/agent-pending.json"));
new AccountLock(lockFileFor(pendingFile, keys.address)).acquire();
const pending = new PendingStore(pendingFile);
const log = (m: string) => console.log(`[agent] ${m}`);
// What the agent signs, from its own configuration rather than the board's word.
const guard: GuardOptions = {
  account: keys.address,
  contract: cfg.contract,
  allowFees: env("AGENT_ALLOW_FEES", "false") === "true",
  maxEnergy: 30_000n, // the board's own cap for contract calls
};
const board = await connectBoard(url);
log(`connected to ${url} as ${keys.address} (badge ${badge}); signing only for contract <${cfg.contract.index},${cfg.contract.subindex}>`);

try {
  if (process.argv.includes("--post")) {
    const chain = new AgentChain(cfg.grpcHost, cfg.grpcPort, cfg.contract);
    const decimals = await chain.decimals(cfg.rewardTokenId);
    const budget = new SpendBudget(fromRoot(env("AGENT_BUDGET_FILE", "data/agent-budget.json")), {
      maxPerBounty: parseTokenAmount(env("AGENT_MAX_REWARD", "5"), decimals),
      dailyCap: parseTokenAmount(env("AGENT_DAILY_BUDGET", "20"), decimals),
    });
    await postAndPay({
      board,
      badge,
      agentTokenId: tokenId,
      keys,
      chain,
      guard,
      budget,
      token: { id: cfg.rewardTokenId, decimals },
      boardOrigin: new URL(url).origin,
      pending,
      escrow: process.argv.includes("--escrow"),
      log,
    });
  } else {
    const forever = process.argv.includes("--forever");
    for (;;) {
      const done = await workOne({ board, badge, agentTokenId: tokenId, keys, guard, handlers: [pageFacts], log });
      if (done) log(`bounty ${done.bountyId} finished as ${done.status}`);
      if (done && !forever) break;
      await new Promise((r) => setTimeout(r, 20_000));
    }
  }
} finally {
  await board.close();
}
// The gRPC channel would keep the process alive.
process.exit(0);
