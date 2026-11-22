import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bounty } from "@bounty/shared";
import { BoardService, type BoardDeps } from "../../src/board/service.js";
import { Attestor } from "../../src/identity/attestor.js";
import { BoardStore } from "../../src/store/db.js";
import type { Intent } from "../../src/sponsor/policy.js";
import { lookupOf, type TestAccount } from "./accounts.js";

export const NOW = 1_800_000_000_000;

/** A BoardService over in-memory fakes: a map of bounties, an allow list, recorded sponsor intents. */
export function fakeBoard(accounts: TestAccount[], over: Partial<BoardDeps> = {}) {
  const chain = new Map<bigint, Bounty>();
  const allowList = new Set(accounts.map((a) => a.address));
  const intents: { intent: Intent; sender: string; badge?: string }[] = [];
  const store = new BoardStore(join(mkdtempSync(join(tmpdir(), "board-")), "b.db"));
  const deps: BoardDeps = {
    config: {
      contract: { index: 1n, subindex: 0n },
      rewardTokenId: "EUDemo",
      tokenDecimals: 6,
      escrowAccount: "escrow",
      sponsorAddress: "sponsor",
      faucetUrl: "https://faucet.example",
      badgeApi: "https://badge.example",
    },
    store,
    chain: {
      view: async (id) => chain.get(id) ?? null,
      entry: async () => null,
      stats: async () => ({ posted: 0, paidAsPoster: 0, unpaid: 0, rejectedFinal: 0, noAward: 0, paidAsWorker: 0 }),
      all: async () => [...chain.values()],
    },
    isOnAllowList: async (a) => allowList.has(a),
    accounts: lookupOf(...accounts),
    idpName: () => "Concordium testnet IP",
    agentWallet: async () => null,
    fetch,
    sponsor: {
      prepare: async (intent, sender, badge) => {
        intents.push({ intent, sender, badge });
        return { txJson: "{}", sender, expiresAt: NOW, feeSponsored: true };
      },
    },
    attestor: new Attestor("09".repeat(32), () => BigInt(NOW)),
    txSponsor: () => "sponsor",
    relay: async () => ({ txHash: "aa".repeat(32), summary: {} }),
    eventsOf: () => [],
    noteTransfer: async () => {},
    now: () => NOW,
    ...over,
  };
  return { service: new BoardService(deps), chain, allowList, intents, store, deps };
}

export function openBounty(id: bigint, poster: string, over: Partial<Bounty> = {}): Bounty {
  return {
    id,
    poster,
    posterAgent: null,
    kind: "Exclusive",
    specHash: "ab".repeat(32),
    reward: 1_000_000n,
    funding: { type: "NotFunded" },
    deadline: BigInt(NOW + 3_600_000),
    status: { type: "Open" },
    rejections: 0,
    lastRejectedAt: null,
    entryCount: 0,
    created: BigInt(NOW),
    ...over,
  };
}
