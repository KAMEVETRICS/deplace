import type { Bounty } from "../types.js";

export type DemoStatus = "Open" | "Claimed" | "Submitted" | "Paid";

/** The agent's real flow on testnet (scenario A of docs/e2e-run.md), one terminal line per step. */
export const STEPS: { at: number; line: string; status: DemoStatus }[] = [
  { at: 0, line: "> find a page-facts bounty I can do", status: "Open" },
  { at: 1_800, line: "● logged in with badge JyP9WVTtVnRuL8JUmLKZH", status: "Open" },
  { at: 3_800, line: "● claimed bounty #1 · attested on chain", status: "Claimed" },
  { at: 5_800, line: "● submitted work · SHA-256 on chain", status: "Submitted" },
  { at: 7_800, line: "● accepted · escrow paid 1 EUDemo", status: "Paid" },
];
export const LOOP_MS = 12_000;
export const WORDS = ["Deplace", "Bounty"] as const;
export const SKETCHES = 4;
const CHAR_MS = 30;
const WORD_MS = 2_400;
const SKETCH_MS = 1_200;

export interface Frame {
  /** Terminal lines shown. */
  lines: number;
  /** Characters shown of the newest line. */
  typed: number;
  status: DemoStatus;
  word: string;
  sketch: number;
  cursorOnCard: boolean;
}

/** What the hero shows `t` ms into the loop. */
export function frameAt(t: number): Frame {
  const u = ((t % LOOP_MS) + LOOP_MS) % LOOP_MS;
  let i = 0;
  for (let k = 0; k < STEPS.length; k++) if (STEPS[k]!.at <= u) i = k;
  const step = STEPS[i]!;
  return {
    lines: i + 1,
    typed: Math.min(step.line.length, Math.floor((u - step.at) / CHAR_MS)),
    status: step.status,
    word: WORDS[Math.floor(u / WORD_MS) % WORDS.length]!,
    sketch: Math.floor(u / SKETCH_MS) % SKETCHES,
    cursorOnCard: i >= 2,
  };
}

/** The finished state, shown without motion to visitors who prefer reduced motion. */
export const FINAL: Frame = { lines: STEPS.length, typed: STEPS[STEPS.length - 1]!.line.length, status: "Paid", word: WORDS[0], sketch: 0, cursorOnCard: true };

export function boardStats(bounties: Bounty[]): { posted: number; paid: number; paidUnits: bigint } {
  const paid = bounties.filter((b) => b.status.type === "Paid");
  return { posted: bounties.length, paid: paid.length, paidUnits: paid.reduce((sum, b) => sum + BigInt(b.reward), 0n) };
}
