// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const POSTER = "4jKZns1aveRVjBmGrvTp9ovsptBMktCJgoZ3zC5XTRsVrqjyuF";
const AGENT = "3qedXEmjY43FLLSpB8tsFAc2gZsmydxd7V6vYh1QJhDbukYVoQ";
const HASH = "70728ed00ccf68885e6a1574b26e865990e36a7023591fa7c660e60977a48eb9";
const LONG = "Complete German translation of the live Deplace homepage. " + "Every section is translated, links kept. ".repeat(20);

const { bountyMock, actMock, runMock, session } = vi.hoisted(() => ({
  bountyMock: vi.fn(),
  actMock: vi.fn(),
  runMock: vi.fn(),
  session: { account: null as string | null },
}));
vi.mock("../src/api.js", () => ({ api: { bounty: bountyMock, act: actMock, work: vi.fn() }, ApiError: class extends Error {} }));
vi.mock("../src/session.js", () => ({
  useSession: () => ({
    config: { decimals: 6, rewardToken: "EUDemo" },
    account: session.account,
    run: runMock,
    busy: false,
    setToast: vi.fn(),
    names: { [AGENT]: "Agent #1501" },
    learnNames: () => {},
  }),
}));
const { BountyPage } = await import("../src/pages/BountyPage.js");

/** Bounty 6 as the board returns it: an escrowed contest whose deadline has passed, with one entry. */
function detail(over: Record<string, unknown> = {}) {
  const deadline = String(Date.now() - 60_000);
  return {
    names: {},
    bounty: {
      id: "6",
      poster: POSTER,
      posterAgent: null,
      kind: "Contest",
      specHash: "ab".repeat(32),
      reward: "5000000",
      funding: { type: "Escrowed", fundingTx: "cd".repeat(32) },
      deadline,
      status: { type: "Open" },
      rejections: 0,
      lastRejectedAt: null,
      entryCount: 1,
      created: String(Date.now() - 3 * 3_600_000),
    },
    spec: { title: "translate this page to german", description: "Translate deplace.space.", taskKind: "translation", input: {}, kind: "Contest", reward: "5", rewardToken: "EUDemo", deadline: Number(deadline), poster: POSTER, posterAgent: null },
    submission: null,
    entries: [{ entryId: 0, worker: AGENT, agent: "1501", workHash: HASH, preview: LONG, at: String(Date.now() - 2 * 3_600_000) }],
    events: [],
    posterProfile: { stats: { posted: 1, paidAsPoster: 0, unpaid: 0, rejectedFinal: 0, noAward: 0, paidAsWorker: 0 }, identity: null },
    links: { contract: "https://ccdexplorer.io/testnet/contract/13123/0", poster: "https://ccdexplorer.io/testnet/account/x", posterAgent: null },
    ...over,
  };
}

beforeEach(() => {
  session.account = POSTER;
  bountyMock.mockResolvedValue(detail());
  actMock.mockResolvedValue({ action: "award", prepared: { txJson: "{}", feeSponsored: true } });
  runMock.mockImplementation(async (_label: string, fn: () => Promise<unknown>) => {
    await fn();
    return null;
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("a contest's entries, for the poster after the deadline", () => {
  it("shows each entry with its entrant, when it came in and its work hash", async () => {
    render(<BountyPage id="6" />);
    const entry = await screen.findByRole("listitem", { name: "Entry #0" });
    expect(within(entry).getByRole("link", { name: "Agent #1501" })).toBeTruthy();
    expect(within(entry).getByText("entered 2 h ago")).toBeTruthy();
    expect(within(entry).getByText(/work hash 70728e…a48eb9/)).toBeTruthy();
  });

  it("clamps a long preview and shows all of it on request", async () => {
    render(<BountyPage id="6" />);
    const more = await screen.findByRole("button", { name: "Show the whole preview" });
    const preview = screen.getByText(/Complete German translation/);
    expect(preview.className).toMatch(/\bclamp\b/);
    fireEvent.click(more);
    expect(preview.className).not.toMatch(/\bclamp\b/);
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
  });

  it("offers no toggle for a short preview", async () => {
    bountyMock.mockResolvedValue(detail({ entries: [{ entryId: 0, worker: AGENT, workHash: HASH, preview: "Short and sweet." }] }));
    render(<BountyPage id="6" />);
    await screen.findByText("Short and sweet.");
    expect(screen.queryByRole("button", { name: "Show the whole preview" })).toBeNull();
  });

  it("awards an entry with a button that names the reward", async () => {
    render(<BountyPage id="6" />);
    const award = await screen.findByRole("button", { name: "Award 5 EUDemo" });
    expect(award.className).toMatch(/\bmoney\b/);
    fireEvent.click(award);
    await vi.waitFor(() => expect(actMock).toHaveBeenCalledWith("6", "award", { entryId: 0 }));
    expect(runMock.mock.calls[0]![0]).toBe("Award");
  });

  it("clamps an Exclusive submission's long preview the same way", async () => {
    const d = detail();
    bountyMock.mockResolvedValue({
      ...d,
      bounty: { ...d.bounty, kind: "Exclusive", status: { type: "Submitted", worker: AGENT, agent: "1501", workHash: HASH, at: String(Date.now()) }, entryCount: 0 },
      submission: { workHash: HASH, preview: LONG },
      entries: [],
    });
    render(<BountyPage id="6" />);
    expect(await screen.findByRole("button", { name: "Show the whole preview" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
  });
});
