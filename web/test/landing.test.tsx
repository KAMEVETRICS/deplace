// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FINAL, LOOP_MS, STEPS, WORDS, boardStats, frameAt } from "../src/landing/timeline.js";
import type { Bounty } from "../src/types.js";

const { bountiesMock } = vi.hoisted(() => ({ bountiesMock: vi.fn() }));
vi.mock("../src/api.js", () => ({ api: { bounties: bountiesMock } }));
vi.mock("../src/session.js", () => ({ useSession: () => ({ config: { rewardToken: "EUDemo", decimals: 6, contract: { index: "13123", subindex: "0" } } }) }));
const { Landing } = await import("../src/pages/Landing.js");

function reducedMotion(on: boolean) {
  window.matchMedia = ((q: string) => ({ matches: on && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
}

describe("landing page", () => {
  beforeEach(() => {
    reducedMotion(true);
    bountiesMock.mockResolvedValue({ bounties: [] });
  });
  afterEach(cleanup);

  it("sends every Open the board button to the board", () => {
    render(<Landing />);
    const links = screen.getAllByRole("link", { name: "Open the board" });
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const a of links) expect(a.getAttribute("href")).toBe("#/board");
  });

  it("tells screen readers what the animation shows, and hides the moving text from them", () => {
    const { container } = render(<Landing />);
    expect(screen.getByText(/finds a bounty, claims it, submits its work and is paid/)).toBeTruthy();
    expect(container.querySelector(".stage")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows the finished state when the visitor prefers reduced motion", () => {
    const { container } = render(<Landing />);
    const stage = container.querySelector(".stage")!;
    expect(stage.querySelectorAll(".term-body li")).toHaveLength(STEPS.length);
    expect(stage.textContent).toContain(STEPS[STEPS.length - 1]!.line);
    expect(stage.querySelector(".demo-card .badge")?.textContent).toBe("Paid");
  });

  it("still renders when the board cannot be reached", async () => {
    bountiesMock.mockRejectedValue(new Error("down"));
    render(<Landing />);
    expect(await screen.findAllByText("–")).toHaveLength(3);
  });
});

describe("landing timeline", () => {
  it("starts with one line and an Open bounty, the cursor still at the terminal", () => {
    expect(frameAt(0)).toMatchObject({ lines: 1, status: "Open", cursorOnCard: false, word: WORDS[0] });
  });

  it("reaches Claimed, Submitted and Paid in order, and loops", () => {
    expect(STEPS.map((s) => frameAt(s.at + 1).status)).toEqual(["Open", "Open", "Claimed", "Submitted", "Paid"]);
    expect(frameAt(STEPS[2]!.at + 1).cursorOnCard).toBe(true);
    expect(frameAt(LOOP_MS + 1)).toEqual(frameAt(1));
  });

  it("types the newest line a character at a time, up to its length", () => {
    const s = STEPS[1]!;
    expect(frameAt(s.at).typed).toBe(0);
    expect(frameAt(s.at + 300).typed).toBe(10);
    expect(frameAt(STEPS[2]!.at - 1).typed).toBe(s.line.length);
  });

  it("swaps the giant word flip-book style", () => {
    const words = new Set(Array.from({ length: 12 }, (_, i) => frameAt(i * 1000).word));
    expect([...words].sort()).toEqual([...WORDS].sort());
  });

  it("has a finished state with every line typed and the bounty Paid", () => {
    expect(FINAL).toMatchObject({ lines: STEPS.length, typed: STEPS[STEPS.length - 1]!.line.length, status: "Paid", cursorOnCard: true });
  });
});

describe("board stats", () => {
  const b = (id: string, status: string, reward: string) => ({ id, status: { type: status }, reward }) as unknown as Bounty;

  it("counts bounties posted and paid, and the reward paid out", () => {
    expect(boardStats([b("0", "Paid", "1000000"), b("1", "Paid", "2500000"), b("2", "Open", "1000000")])).toEqual({ posted: 3, paid: 2, paidUnits: 3_500_000n });
    expect(boardStats([])).toEqual({ posted: 0, paid: 0, paidUnits: 0n });
  });
});
