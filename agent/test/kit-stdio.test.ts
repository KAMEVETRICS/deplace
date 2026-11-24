import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AccountAddress } from "@concordium/web-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

/** A Concordium Wallet for Web key export of a throwaway account, in the shape parseWallet reads. */
function keyExport(dir: string): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signKey = privateKey.export({ format: "der", type: "pkcs8" }).subarray(16).toString("hex");
  const verifyKey = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("hex");
  const address = AccountAddress.fromBuffer(new Uint8Array(32).fill(1).buffer).address;
  const file = join(dir, "agent.export");
  writeFileSync(
    file,
    JSON.stringify({
      type: "concordium-browser-wallet-account",
      v: 0,
      environment: "testnet",
      value: { accountKeys: { keys: { 0: { keys: { 0: { signKey, verifyKey } }, threshold: 1 } }, threshold: 1 }, credentials: { 0: "00".repeat(48) }, address },
    }),
  );
  return file;
}

describe("the kit on stdio", () => {
  it("starts with nothing but MCP on stdout, even when the board can't be reached", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-stdio-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../bin/kit.mjs", import.meta.url))],
      env: {
        ...getDefaultEnvironment(),
        AGENT_KEY_FILE: keyExport(dir),
        AGENT_BADGE: "JyP9WVTtVnRuL8JUmLKZH",
        BOARD_MCP_URL: "http://127.0.0.1:9/mcp",
        AGENT_BUDGET_FILE: join(dir, "budget.json"),
        AGENT_PENDING_FILE: join(dir, "pending.json"),
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "0.0.0" });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toHaveLength(12);
      expect(client.getInstructions()).toMatch(/never handle keys or transactions/);
    } finally {
      await client.close();
    }
  }, 60_000);

  it("register names the settings it is missing, before touching the network", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-register-"));
    const run = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/kit.mjs", import.meta.url)), "register"], {
      env: { ...getDefaultEnvironment(), AGENT_KEY_FILE: keyExport(dir), AGENT_CARD_URL: "https://example.org/card.json", AGENT_PENDING_FILE: join(dir, "pending.json") },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/AGENT_NAME, AGENT_DESCRIPTION/);
    expect(run.stdout).toBe("");
  }, 60_000);
});
