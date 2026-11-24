import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { kitHome } from "../src/kit/home.js";
import { loadKitSettings } from "../src/kit/settings.js";
import { keyExport } from "./helpers/key-export.js";

const NPM = fileURLToPath(new URL("../npm/", import.meta.url));
const BIN = join(NPM, "bin.mjs");
const VERSION = (JSON.parse(readFileSync(join(NPM, "package.json"), "utf8")) as { version: string }).version;

describe("the kit's home when it is installed from npm", () => {
  it("is .deplace in the user's home folder, unless DEPLACE_HOME names another", () => {
    expect(kitHome({}, join(tmpdir(), "someone"))).toBe(join(tmpdir(), "someone", ".deplace"));
    const own = join(tmpdir(), "own-deplace-home");
    expect(kitHome({ DEPLACE_HOME: `  ${own}  ` }, join(tmpdir(), "someone"))).toBe(own);
  });

  it("refuses a relative DEPLACE_HOME, naming it", () => {
    expect(() => kitHome({ DEPLACE_HOME: "deplace" })).toThrow(/DEPLACE_HOME/);
  });

  it("holds the kit's records and is where relative paths start", () => {
    const home = kitHome({}, join(tmpdir(), "someone"));
    const s = loadKitSettings({ AGENT_KEY_FILE: "agent.export" }, home);
    expect(s.keyFile).toBe(join(home, "agent.export"));
    expect(s.pendingFile).toBe(join(home, "data", "agent-pending.json"));
    expect(s.budgetFile).toBe(join(home, "data", "agent-budget.json"));
    expect(s.card.file).toBe(join(home, "data", "agent-card.json"));
  });
});

describe("the npm package's entry", () => {
  beforeAll(() => {
    const build = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/build-npm.mjs", import.meta.url))], { encoding: "utf8", timeout: 60_000 });
    expect(build.status, build.stderr).toBe(0);
  }, 60_000);

  it("serves the kit on stdio with a key path relative to DEPLACE_HOME, and says where its records are", async () => {
    const home = mkdtempSync(join(tmpdir(), "kit-home-"));
    keyExport(home);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN],
      env: { ...getDefaultEnvironment(), DEPLACE_HOME: home, AGENT_KEY_FILE: "agent.export", AGENT_BADGE: "JyP9WVTtVnRuL8JUmLKZH", BOARD_MCP_URL: "http://127.0.0.1:9/mcp" },
      stderr: "pipe",
    });
    let said = "";
    transport.stderr?.on("data", (d: Buffer) => (said += d.toString()));
    const client = new Client({ name: "npm-test", version: "0.0.0" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(12);
      expect(client.getServerVersion()?.version).toBe(VERSION);
      await vi.waitFor(() => expect(said).toContain(`records in ${join(home, "data")}`), { timeout: 10_000 });
    } finally {
      await client.close();
    }
  }, 60_000);

  it("--version prints the package's version and needs no settings", () => {
    const run = spawnSync(process.execPath, [BIN, "--version"], { env: getDefaultEnvironment(), encoding: "utf8", timeout: 60_000 });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`${VERSION}\n`);
  }, 60_000);

  it("register names the settings it is missing, before touching the network", () => {
    const home = mkdtempSync(join(tmpdir(), "kit-home-"));
    keyExport(home);
    const run = spawnSync(process.execPath, [BIN, "register"], {
      env: { ...getDefaultEnvironment(), DEPLACE_HOME: home, AGENT_KEY_FILE: "agent.export", AGENT_CARD_URL: "https://example.org/card.json" },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/AGENT_NAME, AGENT_DESCRIPTION/);
    expect(run.stdout).toBe("");
  }, 60_000);
});
