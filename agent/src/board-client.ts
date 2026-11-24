import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Board } from "./worker.js";

export class BoardToolError extends Error {
  /** The board marked the failure temporary (`"retryable": true`): the same call may work in a moment. */
  readonly retryable: boolean;

  constructor(
    readonly tool: string,
    readonly detail: string,
  ) {
    super(`${tool}: ${detail}`);
    this.name = "BoardToolError";
    this.retryable = markedRetryable(detail);
  }
}

/** A failure the board marked temporary, such as the badge service or the chain being unreachable. */
export function isRetryable(e: unknown): e is BoardToolError {
  return e instanceof BoardToolError && e.retryable;
}

/** The board's JSON error on one log line. */
export const oneLine = (e: BoardToolError) => `${e.tool}: ${e.detail.replace(/\s+/g, " ")}`;

/** The board's refusals are JSON; any other tool error (a crash inside the board) is plain text and not retryable. */
function markedRetryable(detail: string): boolean {
  try {
    return (JSON.parse(detail) as { retryable?: unknown } | null)?.retryable === true;
  } catch {
    return false; // plain text: not one of the board's refusals
  }
}

/** A connection to the board's MCP server: `call` with the SDK's default time limit, `callWithin` with one of its own. */
export interface BoardConnection extends Board {
  callWithin<T = any>(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<T>;
  close(): Promise<void>;
}

/** The board's MCP server over Streamable HTTP. */
export async function connectBoard(url: string): Promise<BoardConnection> {
  const client = new Client({ name: "deplace-reference-worker", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  async function call<T>(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const r = (await client.callTool({ name, arguments: args }, undefined, timeoutMs === undefined ? undefined : { timeout: timeoutMs })) as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
    };
    const text = r.content?.find((c) => c.type === "text")?.text ?? "";
    if (r.isError) throw new BoardToolError(name, text);
    return JSON.parse(text) as T;
  }
  return {
    call: <T>(name: string, args: Record<string, unknown>) => call<T>(name, args),
    callWithin: <T>(name: string, args: Record<string, unknown>, timeoutMs: number) => call<T>(name, args, timeoutMs),
    close: () => client.close(),
  };
}
