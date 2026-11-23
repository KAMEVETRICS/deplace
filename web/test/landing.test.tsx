// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { FINAL, LOOP_MS, STEPS, WORDS, boardStats, frameAt } from "../src/landing/timeline.js";
import type { Bounty } from "../src/types.js";

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
