// Composition root: wires the board to testnet. Run: npm start -w server (reads ../.env).
import "./env-init.js";
import { config as loadEnv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { Router } from "express";
import { AccountAddress, Transaction, TransactionHash } from "@concordium/web-sdk";
import { encodeRecordPayout, encodeU64, loadConfig } from "@deplace/shared";
import { dueAction } from "./board/keeper.js";
import { agentCardRouter } from "./api/cards.js";
import { createApp } from "./api/app.js";
import { transferNoter } from "./board/payments.js";
import { BoardError, BoardService } from "./board/service.js";
import { BountyContract, eventsFromSummary } from "./chain/contract.js";
import { grpcClient, isNotFound } from "./chain/grpc.js";
import { Operator } from "./chain/operator.js";
import { PltClient } from "./chain/plt.js";
import { registryAgentWallet } from "./chain/registry.js";
import { loadOrCreateAttestorSeed, loadWallet, walletPrivateKey } from "./chain/wallet.js";
import { escrowChain } from "./escrow/chain-adapter.js";
import { EscrowWorker } from "./escrow/worker.js";
import { Attestor } from "./identity/attestor.js";
import { mcpRouter } from "./mcp/server.js";
import { SponsorPolicy, type Intent } from "./sponsor/policy.js";
import { SponsorService } from "./sponsor/sponsor.js";
import { BoardStore } from "./store/db.js";
import { createX402Gateway } from "./x402/gateway.js";
import { x402Router, type X402Gateway } from "./x402/routes.js";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
loadEnv({ path: join(root, ".env") });
process.chdir(root); // key file paths in .env are relative to the repository root
const cfg = loadConfig(process.env);
if (!cfg.contract) throw new Error("CONTRACT_INDEX is not set: deploy first (npx tsx scripts/deploy.ts)");
const contractRef = cfg.contract;

const client = grpcClient(cfg);
const contract = new BountyContract(client, contractRef);
const plt = new PltClient(client, cfg.rewardTokenId);
const decimals = await plt.decimals();
const sponsorWallet = loadWallet(cfg.keyFiles.sponsor);
const sponsorKey = walletPrivateKey(cfg.keyFiles.sponsor);
const operatorWallet = loadWallet(cfg.keyFiles.operator);
// The operator's own calls (confirm_funding, record_payout, record_refund) are recorded like relayed ones.
const operator = new Operator(client, operatorWallet, contractRef, { tokenId: cfg.rewardTokenId, decimals }, (txHash, summary) =>
  service.noteOperatorTransaction(txHash, summary),
);
const attestor = new Attestor(loadOrCreateAttestorSeed(cfg.keyFiles.attestor));

const onChain = await contract.config();
if (onChain.attestorHex !== attestor.publicKeyHex) {
  throw new Error(`attestor key mismatch: contract expects ${onChain.attestorHex}, ${cfg.keyFiles.attestor} holds ${attestor.publicKeyHex}`);
}
if (onChain.operator !== operatorWallet.address) throw new Error(`operator mismatch: contract expects ${onChain.operator}`);

const store = new BoardStore(cfg.dbPath);
const accounts = async (address: string) => {
  try {
    return await client.getAccountInfo(AccountAddress.fromBase58(address));
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
};

// Identity provider names come from the wallet-proxy (v2 lists all four testnet IDPs).
const idpNames = new Map<number, string>([
  [0, "Concordium testnet IP"],
  [3, "Digital Trust Solutions TestNet"],
  [4, "Global FinReg Testnet"],
  [5, "Dataspike"],
]);
try {
  const ips = (await (await fetch(`${cfg.walletProxy}/v2/ip_info`)).json()) as { ipInfo: { ipIdentity: number; ipDescription: { name: string } } }[];
  for (const ip of ips) idpNames.set(ip.ipInfo.ipIdentity, ip.ipInfo.ipDescription.name);
} catch (e) {
  console.warn("[startup] could not read identity provider names from the wallet-proxy, using built-in names:", (e as Error).message);
}

const unsponsoredTypes = new Set(
  (process.env.SPONSOR_DISABLED_TYPES ?? "").split(",").map((s) => s.trim()).filter((s): s is Intent["type"] => s === "contract" || s === "plt-transfer"),
);

// Sponsoring pauses when the sponsor's CCD drops below this floor (checked at most once a minute).
const stopBelowMicroCcd = BigInt(process.env.SPONSOR_STOP_CCD ?? "20") * 1_000_000n;
let balanceChecked = { at: 0, ok: true };
const sponsorBalanceOk = async () => {
  if (Date.now() - balanceChecked.at > 60_000) {
    const info = await client.getAccountInfo(AccountAddress.fromBase58(sponsorWallet.address));
    balanceChecked = { at: Date.now(), ok: info.accountAmount.microCcdAmount >= stopBelowMicroCcd };
  }
  return balanceChecked.ok;
};

let service: BoardService; // assigned below; the policy needs it for payee lookups
const policy = new SponsorPolicy({
  escrowAccount: operatorWallet.address,
  rewardTokenId: cfg.rewardTokenId,
  bounty: async (id) => {
    const b = await contract.view(id);
    return b ? { poster: b.poster, payee: await service.payee(b), reward: b.reward } : null;
  },
  sponsorBalanceOk,
});
const sponsor = new SponsorService(policy, {
  sponsor: sponsorWallet,
  nextNonce: async (a) => (await client.getNextAccountNonce(AccountAddress.fromBase58(a))).nonce.value,
  contract: contractRef,
  rewardTokenId: cfg.rewardTokenId,
  tokenDecimals: decimals,
  unsponsoredTypes,
});

const escrow = new EscrowWorker({ chain: escrowChain(contract, plt, operator), store: store.escrow, escrowAccount: operatorWallet.address, rewardToken: cfg.rewardTokenId });
const recordPayout = (id: bigint, payouts: { to: string; amount: bigint; tx: string }[]) => operator.update("record_payout", encodeRecordPayout(id, payouts));

service = new BoardService({
  config: {
    contract: contractRef,
    rewardTokenId: cfg.rewardTokenId,
    tokenDecimals: decimals,
    escrowAccount: operatorWallet.address,
    sponsorAddress: sponsorWallet.address,
    faucetUrl: cfg.faucetUrl,
    badgeApi: cfg.badgeApi,
  },
  store,
  chain: contract,
  isOnAllowList: (a) => plt.isOnAllowList(a),
  accounts,
  idpName: (i) => idpNames.get(i),
  agentWallet: (tokenId) => registryAgentWallet(client, cfg.registry, tokenId),
  fetch,
  sponsor,
  attestor,
  txSponsor: (txJson) => {
    try {
      const tx = Transaction.signableFromJSON(JSON.parse(txJson));
      return tx.version === 1 ? (tx.header.sponsor?.account.address ?? null) : null;
    } catch {
      throw new BoardError(400, "txJson is not a transaction prepared by this board");
    }
  },
  relay: async (txJson) => {
    const signed = Transaction.signableFromJSON(JSON.parse(txJson));
    const hash = await client.sendTransaction(Transaction.finalize(signed));
    const outcome = await client.waitForTransactionFinalization(hash);
    return { txHash: TransactionHash.toHexString(hash), summary: outcome.summary };
  },
  outcome: async (txHash) => {
    const out = await client.waitForTransactionFinalization(TransactionHash.fromHexString(txHash), 120_000);
    return { summary: out.summary };
  },
  eventsOf: (summary) => eventsFromSummary(summary, contractRef),
  noteTransfer: async (tx) => {
    const note = await noter(tx);
    if (note.kind === "ignored") console.warn(`[relay] transfer ${tx} not matched to a bounty: ${note.reason}`);
  },
  now: Date.now,
});
const noter = transferNoter({
  rewardToken: cfg.rewardTokenId,
  transferInfo: (tx) => plt.transferInfo(tx),
  noteDeposit: (tx) => escrow.noteDeposit(tx),
  live: (id) => service.live(id),
  payee: (b) => service.payee(b),
  recordPayout,
});

let gateway: X402Gateway | null = null;
try {
  gateway = await createX402Gateway({ sponsorAddress: sponsorKey.address, sponsorKeyHex: sponsorKey.key, grpcHost: cfg.grpcHost, grpcPort: cfg.grpcPort, tokenId: cfg.rewardTokenId });
} catch (e) {
  console.error("[startup] x402 gateway unavailable; pay-on-delivery and x402 funding are off:", e);
}
const x402 = gateway
  ? x402Router(service, gateway, { publicBaseUrl: cfg.publicBaseUrl, recordPayout, noteDeposit: (tx, opts) => escrow.noteDeposit(tx, opts) })
  : Router().all(["/bounties/:id/work", "/bounties/:id/fund"], (_req, res) => {
      res.status(503).json({ error: "x402 is unavailable on this board right now; use the direct transfer fallback" });
    });

const webDist = join(root, "web", "dist");
// The module schema lets Wallet for Web show contract parameters before the user signs.
const schemaFile = join(root, "dist", "deplace.schema.b64");
const schemaRouter = Router().get("/contract/schema", (_req, res) => {
  if (!existsSync(schemaFile)) {
    res.status(404).json({ error: "schema not built: run scripts/build-contract.ps1" });
    return;
  }
  res.json({ type: "ModuleSchema", value: readFileSync(schemaFile, "utf8").trim(), contract: contractRef });
});
const app = createApp({
  service,
  extraRouters: [x402, mcpRouter(service, { publicBaseUrl: cfg.publicBaseUrl }), schemaRouter],
  mounts: [
    { path: "/agents", router: agentCardRouter(join(root, "server", "public", "agents")) },
    ...(existsSync(webDist) ? [{ path: "/", router: Router().use(express.static(webDist)) }] : []),
  ],
  health: async () => {
    const info = await client.getAccountInfo(AccountAddress.fromBase58(sponsorWallet.address));
    const ccd = info.accountAmount.microCcdAmount / 1_000_000n;
    return {
      contract: contractRef,
      sponsor: { address: sponsorWallet.address, ccd, low: ccd < cfg.sponsorMinCcd },
      escrow: { address: operatorWallet.address, ...escrow.health() },
      x402: gateway !== null,
      unsponsoredTypes: [...unsponsoredTypes],
    };
  },
});

// Keeper: sends the permissionless time-based calls (auto_accept, mark_unpaid, split_unawarded,
// no_award, expire) when due. The contract checks block time, so a call that is a few seconds
// early is rejected and retried on a later pass.
const windows = { reviewWindowMs: onChain.reviewWindowMs, paymentWindowMs: onChain.paymentWindowMs };
const lastTried = new Map<string, number>();
async function keep() {
  for (const b of store.bounties({})) {
    const action = dueAction(b, BigInt(Date.now()), windows);
    if (!action) continue;
    const key = `${b.id}:${action}`;
    if (Date.now() - (lastTried.get(key) ?? 0) < 60_000) continue;
    lastTried.set(key, Date.now());
    try {
      const tx = await operator.update(action, encodeU64(b.id));
      console.log(`[keeper] bounty ${b.id}: ${action} ${tx}`);
    } catch (e) {
      console.warn(`[keeper] bounty ${b.id}: ${action} not accepted yet: ${(e as Error).message}`);
    }
  }
}

let busy = false;
async function loop() {
  if (busy) return;
  busy = true;
  try {
    await service.sync(0);
    await keep();
    await service.retryUnrecordedPayments(recordPayout);
    await escrow.tick();
  } catch (e) {
    console.error("[loop] sync, keeper or escrow tick failed:", e);
  } finally {
    busy = false;
  }
}
setInterval(loop, 15_000);
void loop();

app.listen(cfg.port, () => {
  console.log(`Deplace on ${cfg.publicBaseUrl} (port ${cfg.port})`);
  console.log(`  contract <${contractRef.index},${contractRef.subindex}>  sponsor ${sponsorWallet.address}  escrow/operator ${operatorWallet.address}`);
  console.log(`  MCP: ${cfg.publicBaseUrl}/mcp   x402: ${gateway ? "on" : "off"}`);
});
