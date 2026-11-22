// Audits the board's custodial escrow against the chain. Needs no keys: it reads the board's
// public API for bounties and recorded events, and checks every claim on testnet itself.
//   npx tsx scripts/audit.ts [BOARD_URL]      (default http://localhost:8787)
// Exits 1 on any mismatch or if the escrow balance does not cover the rewards still owed.
import "../server/src/env-init.js";
import "dotenv/config";
import { AccountAddress } from "@concordium/web-sdk";
import { formatTokenAmount, loadConfig, type BoardEvent, type Bounty } from "@bounty/shared";
import { grpcClient } from "../server/src/chain/grpc.js";
import { PltClient } from "../server/src/chain/plt.js";
import { auditEscrow } from "../server/src/escrow/audit.js";

const board = (process.argv[2] ?? process.env.PUBLIC_BASE_URL ?? "http://localhost:8787").replace(/\/$/, "");
const cfg = loadConfig(process.env);
const client = grpcClient(cfg);
const plt = new PltClient(client, cfg.rewardTokenId);

const get = async (path: string) => {
  const res = await fetch(board + path);
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return res.json() as Promise<any>;
};

const publicCfg = await get("/config");
const escrow: string = publicCfg.escrowAccount;
// Numeric fields come back as strings; hashes and addresses must stay strings.
const toBounty = (b: any): Bounty => ({ ...b, id: BigInt(b.id), reward: BigInt(b.reward), deadline: BigInt(b.deadline), created: BigInt(b.created) });
const bounties: Bounty[] = (await get("/bounties")).bounties.map(toBounty);
const events = new Map<bigint, BoardEvent[]>();
for (const b of bounties.filter((x) => x.funding.type === "Escrowed")) {
  const d = await get(`/bounties/${b.id}`);
  events.set(
    b.id,
    d.events.map((e: any) => ({ ...e.event, id: BigInt(e.event.id), ...(e.event.amount !== undefined ? { amount: BigInt(e.event.amount) } : {}) })),
  );
}

const info = await client.getAccountInfo(AccountAddress.fromBase58(escrow));
const balance = info.accountTokens.find((t) => t.id.value === cfg.rewardTokenId)?.state.balance.value ?? 0n;
const decimals = await plt.decimals();

const r = await auditEscrow({ escrowAccount: escrow, rewardToken: cfg.rewardTokenId, bounties, events: (id) => events.get(id) ?? [], transferInfo: (tx) => plt.transferInfo(tx), escrowBalance: balance });

console.log(`Escrow audit of ${board} (escrow account ${escrow})\n`);
console.log("bounty  status          owed        result");
for (const row of r.rows) {
  console.log(`${String(row.id).padEnd(7)} ${row.status.padEnd(15)} ${formatTokenAmount(row.owed, decimals).padStart(10)}  ${row.notes.length ? "MISMATCH" : "ok"}`);
  for (const n of row.notes) console.log(`        - ${n}`);
}
console.log(`\nowed to workers or posters: ${formatTokenAmount(r.liabilities, decimals)} ${cfg.rewardTokenId}`);
console.log(`escrow balance:             ${formatTokenAmount(r.balance, decimals)} ${cfg.rewardTokenId}`);
if (r.shortfall > 0n) console.log(`SHORTFALL:                  ${formatTokenAmount(r.shortfall, decimals)} ${cfg.rewardTokenId}`);
console.log(r.ok ? "\nAUDIT OK" : "\nAUDIT FAILED");
process.exit(r.ok ? 0 : 1);
