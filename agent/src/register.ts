// Registers the reference worker in the Agent Registry (CIS-8004 <12802,0>, testnet) and
// gives it a valid "Verified by Concordium" badge. Idempotent: run it again after each step.
//
//   npm run register -w agent
//
// The flow the registry itself describes: register first, then build the card for the minted
// token id, publish it byte for byte at AGENT_CARD_URL, pin its SHA-256 on chain, and check
// the badge (it fetches the card and compares the hash). The script writes the card to
// server/public/agents/bounty-worker.json; publish that file at AGENT_CARD_URL.
// Anyone's agent registers the same way with `node agent/bin/kit.mjs register`.
import { agentLink } from "@deplace/shared";
import { env, fromRoot } from "./env.js";
import { chainSubmitter, hostedRegistry, REFERENCE_AGENT_CARD, registerAgent } from "./registry.js";
import { loadAgentKeys } from "./signer.js";

const CARD_FILE = fromRoot("server/public/agents/bounty-worker.json");
/** Written as soon as the register transaction is sent, so a re-run never registers twice while the indexer catches up. */
const REGISTERED_FILE = fromRoot("data/agent-register-tx.txt");
const CARD_URL = env("AGENT_CARD_URL");
const keys = loadAgentKeys(fromRoot(env("AGENT_KEY_FILE", "secrets/worker-agent.export")));

const out = await registerAgent({
  owner: keys.address,
  submit: chainSubmitter(keys, { host: env("GRPC_HOST", "grpc.testnet.concordium.com"), port: Number(env("GRPC_PORT", "20000")) }),
  registry: hostedRegistry(),
  fetch,
  card: { ...REFERENCE_AGENT_CARD, url: CARD_URL, file: CARD_FILE },
  registeredFile: REGISTERED_FILE,
  registryContract: { index: 12802n, subindex: 0n },
  log: (m) => console.log(m),
});

switch (out.step) {
  case "indexer-behind":
    throw new Error(
      `registered in https://ccdexplorer.io/testnet/transaction/${out.tx} but the registry indexer does not list the agent yet; run again later (delete ${REGISTERED_FILE} only if that transaction failed)`,
    );
  case "card-written":
    process.exit(0);
    break;
  case "card-not-served":
    process.exit(1);
    break;
  case "badge":
    console.log(`   ${agentLink(BigInt(out.tokenId))}`);
    if (out.valid) console.log(`\nAdd to .env:\nAGENT_BADGE=${out.badge}`);
}
// The gRPC channel would keep the process alive.
process.exit(0);
