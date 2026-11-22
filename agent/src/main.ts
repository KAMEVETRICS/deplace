// Reference worker agent for the Concordium Bounty Board.
//   npm start -w agent               work: claim, do and submit one page-facts bounty, wait for payment
//   npm start -w agent -- --forever  keep working bounties
//   npm start -w agent -- --post     agent as poster: post, accept, pay on delivery with x402
import { env, fromRoot } from "./env.js";
import { connectBoard } from "./board-client.js";
import { postAndPay } from "./poster.js";
import { loadAgentKeys } from "./signer.js";
import { pageFacts } from "./tasks/page-facts.js";
import { workOne } from "./worker.js";

const keys = loadAgentKeys(fromRoot(env("AGENT_KEY_FILE", "secrets/worker-agent.export")));
const badge = env("AGENT_BADGE");
const url = env("BOARD_MCP_URL", "http://localhost:8787/mcp");
const log = (m: string) => console.log(`[agent] ${m}`);
const board = await connectBoard(url);
log(`connected to ${url} as ${keys.address} (badge ${badge})`);

try {
  if (process.argv.includes("--post")) {
    await postAndPay({ board, badge, keys, url, log });
  } else {
    const forever = process.argv.includes("--forever");
    for (;;) {
      const done = await workOne({ board, badge, keys, handlers: [pageFacts], log });
      if (done) log(`bounty ${done.bountyId} finished as ${done.status}`);
      if (done && !forever) break;
      await new Promise((r) => setTimeout(r, 20_000));
    }
  }
} finally {
  await board.close();
}
