/** What a bounty asks for, from its off-chain spec (the on-chain spec hash commits to it). */
export interface TaskSpec {
  taskKind: string;
  input: Record<string, unknown>;
}

/** A kind of work the agent can do. Add an LLM-backed handler here to take on open-ended bounties. */
export interface TaskHandler {
  kind: string;
  canHandle(spec: TaskSpec): boolean;
  /** `preview` is shown to the poster before acceptance; `full` is released on acceptance or payment. */
  run(spec: TaskSpec): Promise<{ preview: string; full: string }>;
}
