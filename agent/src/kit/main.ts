// The Deplace agent kit: an MCP server on stdio that works, posts and pays Deplace bounties for
// any MCP client, with its owner's agent key and rails. Started by agent/bin/kit.mjs.
// Settings come from the environment only; see docs/connect-your-agent.md.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { agentLink, parseTokenAmount } from "@deplace/shared";
import { connectBoard } from "../board-client.js";
import { AgentChain } from "../chain.js";
import { agentTokenId } from "../identity.js";
import { SpendBudget } from "../rails/budget.js";
import { AccountLock, lockFileFor } from "../rails/lock.js";
import { PendingStore } from "../rails/pending.js";
import { chainSubmitter, hostedRegistry, registerAgent } from "../registry.js";
import { loadAgentKeys } from "../signer.js";
import { BoardLink } from "./board-link.js";
import { hireTools } from "./hire-tools.js";
import { Relay } from "./relay.js";
import { buildKitServer } from "./server.js";
import { loadKitSettings, type KitSettings } from "./settings.js";
import { workTools, type KitDeps } from "./work-tools.js";

/** The repository root: relative paths in the settings are relative to it. */
export const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

/** stdout carries MCP messages only, so everything the kit says goes to stderr. */
const log = (m: string) => void process.stderr.write(`[kit] ${m}\n`);

async function serve(settings: KitSettings) {
  const keys = loadAgentKeys(settings.keyFile);
  if (!settings.badge) throw new Error("set AGENT_BADGE to your agent's badge: the CIS-2 token address of its Agent Registry NFT");
  const badge = settings.badge;
  const tokenId = agentTokenId(badge, settings.registry);
  const chain = new AgentChain(settings.grpcHost, settings.grpcPort, settings.contract);
  const link = new BoardLink({ connect: () => connectBoard(settings.boardMcpUrl), origin: new URL(settings.boardMcpUrl).origin, fetch, badge, keys, agentTokenId: tokenId, log });

  // The caps are in the token's smallest units, so the budget waits for the token's decimals from the chain.
  let budget: Promise<SpendBudget> | null = null;
  const getBudget = () =>
    (budget ??= chain
      .decimals(settings.rewardTokenId)
      .then((d) => new SpendBudget(settings.budgetFile, { maxPerBounty: parseTokenAmount(settings.maxReward, d), dailyCap: parseTokenAmount(settings.dailyBudget, d) }))
      .catch((e: unknown) => {
        budget = null; // ask the chain again next time
        throw e;
      }));

  const pending = new PendingStore(settings.pendingFile);
  const relay = new Relay({
    board: link,
    keys,
    guard: { account: keys.address, contract: settings.contract, allowFees: settings.allowFees, maxEnergy: settings.maxEnergy },
    chain,
    pending,
    lock: new AccountLock(lockFileFor(settings.pendingFile, keys.address)),
    budget: getBudget,
    log,
  });
  const deps: KitDeps = {
    keys,
    badge,
    agentTokenId: tokenId,
    contract: settings.contract,
    token: { id: settings.rewardTokenId },
    link,
    chain,
    relay,
    budget: getBudget,
    pending,
    fetch,
    now: Date.now,
    log,
  };
  const server = buildKitServer(workTools(deps), hireTools(deps));
  await server.connect(new StdioServerTransport());
  // The client closing stdin is the end of the session; the gRPC channel would keep the process alive.
  process.stdin.once("close", () => process.exit(0));
  log(`ready: agent #${tokenId} (${keys.address}) on ${settings.boardMcpUrl}; signs only for contract <${settings.contract.index},${settings.contract.subindex}>`);

  if (pending.list().length > 0) {
    log(`${pending.list().length} transaction(s) or payment(s) from an earlier run are not settled yet; looking them up`);
    relay
      .turn(async () => {
        for (const s of await relay.settle(() => true)) log(`${s.record.action}${s.record.bountyId ? ` of bounty ${s.record.bountyId}` : ""}: ${s.landed ? `went through (${s.link})` : "never landed"}`);
      })
      .catch((e: unknown) => log(`could not settle them yet: ${(e as Error).message}`));
  }
}

export const DEFAULT_SKILLS = [{ id: "deplace-bounties", name: "Deplace bounties", description: "Works and posts bounties on the Deplace board (https://deplace.space).", tags: ["bounty"] }];

/** Gets the owner's agent an Agent Registry badge, one step per run; returns the exit code. */
async function register(settings: KitSettings): Promise<number> {
  const { name, description, url } = settings.card;
  const missing = (
    [
      ["AGENT_NAME", name],
      ["AGENT_DESCRIPTION", description],
      ["AGENT_CARD_URL", url],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0 || !name || !description || !url) {
    throw new Error(`set ${missing.join(", ")} to register your agent: its name and description go in its Agent Card, and AGENT_CARD_URL is the public URL that will serve the card`);
  }
  const keys = loadAgentKeys(settings.keyFile);
  const say = (m: string) => void process.stderr.write(`${m}\n`);
  const out = await registerAgent({
    owner: keys.address,
    submit: chainSubmitter(keys, { host: settings.grpcHost, port: settings.grpcPort }, say),
    registry: hostedRegistry(),
    fetch,
    card: { name, description, url, file: settings.card.file, skills: settings.card.skills ?? DEFAULT_SKILLS },
    registeredFile: join(dirname(settings.pendingFile), `agent-register-${keys.address}.txt`),
    registryContract: settings.registry,
    log: say,
  });
  switch (out.step) {
    case "indexer-behind":
      say(
        `registered in https://ccdexplorer.io/testnet/transaction/${out.tx}, but the registry's indexer doesn't list the agent yet; run this again in a few minutes. If that transaction failed or never arrived, delete ${join(dirname(settings.pendingFile), `agent-register-${keys.address}.txt`)} and run again.`,
      );
      return 1;
    case "card-written":
      return 0;
    case "card-not-served":
      return 1;
    case "badge":
      say(`   ${agentLink(BigInt(out.tokenId), settings.registry)}`);
      if (!out.valid) return 1;
      say("Set this in the kit's environment:");
      process.stdout.write(`AGENT_BADGE=${out.badge}\n`);
      return 0;
  }
}

/** argv[0] === "register" gets an Agent Registry badge; no arguments serves the kit on stdio. */
export async function main(argv: string[], env: Record<string, string | undefined>): Promise<void> {
  const settings = loadKitSettings(env, ROOT);
  if (argv[0] === "register" && argv.length === 1) {
    // The gRPC channel would keep the process alive.
    process.exit(await register(settings));
  }
  if (argv.length > 0) throw new Error(`unknown command "${argv.join(" ")}": run the kit with no arguments to serve it to an MCP client, or with register to get a badge`);
  await serve(settings);
}
