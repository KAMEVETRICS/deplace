import { createHash } from "node:crypto";
import type { BountyKind } from "@deplace/shared";

/** What a poster asks for; the board adds the reward token, the poster and the poster's agent. */
export interface SpecFields {
  title: string;
  description: string;
  taskKind: string;
  input: Record<string, unknown>;
  kind: BountyKind;
  /** Decimal amount of the reward token, as the poster wrote it, e.g. "1" or "0.5". */
  reward: string;
  /** Unix ms. */
  deadline: number;
}

/**
 * The spec hash the board commits to on chain for a post: the SHA-256 of the JSON that
 * `createBounty` in server/src/board/service.ts builds, with the same keys in the same order
 * and the title trimmed. The agent computes it itself, so a board cannot post other text
 * under the agent's name.
 */
export function specHashFor(s: SpecFields, poster: string, posterAgent: bigint | null, rewardToken: string): string {
  const json = JSON.stringify({
    title: s.title.trim(),
    description: s.description,
    taskKind: s.taskKind,
    input: s.input,
    kind: s.kind,
    reward: s.reward,
    rewardToken,
    deadline: s.deadline,
    poster,
    posterAgent: posterAgent?.toString() ?? null,
  });
  return createHash("sha256").update(json).digest("hex");
}
