import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Board } from "./worker.js";

export class BoardToolError extends Error {
  constructor(
    readonly tool: string,
    readonly detail: string,
  ) {
    super(`${tool}: ${detail}`);
    this.name = "BoardToolError";
  }
}

/** The board's MCP server over Streamable HTTP. */
export async function connectBoard(url: string): Promise<Board & { close(): Promise<void> }> {
  const client = new Client({ name: "bounty-reference-worker", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return {
    async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content?: { type: string; text?: string }[] };
      const text = r.content?.find((c) => c.type === "text")?.text ?? "";
      if (r.isError) throw new BoardToolError(name, text);
      return JSON.parse(text) as T;
    },
    close: () => client.close(),
  };
}
