// Checks the agent kit's npm package the way people will run it: packs agent/npm (which builds
// it), installs the tarball into an empty project, serves the kit to an MCP client on stdio, and
// starts it through npx. Run it before publishing: npm run check:npm -w agent
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { keyExport } from "../test/helpers/key-export.js";

const NPM = fileURLToPath(new URL("../npm/", import.meta.url));
const pkg = JSON.parse(readFileSync(join(NPM, "package.json"), "utf8")) as { name: string; version: string };
const work = mkdtempSync(join(tmpdir(), "deplace-kit-check-"));

/** Runs npm. On Windows npm is a .cmd file that only a shell can start, so it gets one quoted command line. */
function npm(args: string[], o: SpawnSyncOptions = {}) {
  const options = { encoding: "utf8" as const, timeout: 300_000, ...o };
  if (process.platform !== "win32") return spawnSync("npm", args, options);
  const line = ["npm", ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  return spawnSync(line, { ...options, shell: true });
}

function check(what: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

// 1. Pack. This runs prepack, which builds dist/kit.mjs and copies the license.
const pack = npm(["pack", "--json", "--pack-destination", work], { cwd: NPM });
if (pack.status !== 0) throw new Error(`npm pack failed: ${String(pack.stderr)}`);
const [packed] = JSON.parse(String(pack.stdout)) as { filename: string; files: { path: string }[]; size: number }[];
if (!packed) throw new Error("npm pack described no package");
const files = packed.files.map((f) => f.path).sort();
check("the package holds the kit and nothing else", JSON.stringify(files) === JSON.stringify(["LICENSE", "README.md", "bin.mjs", "dist/kit.mjs", "package.json"]), files.join(", "));
const tarball = join(work, packed.filename);

// 2. Install it into an empty project.
writeFileSync(join(work, "package.json"), JSON.stringify({ name: "check", private: true }));
const install = npm(["install", "--no-audit", "--no-fund", "--prefer-offline", tarball], { cwd: work });
check("it installs from the tarball", install.status === 0, install.status === 0 ? "" : String(install.stderr).slice(-500));

// 3. Serve it to an MCP client on stdio, with the key and the records in DEPLACE_HOME.
const home = join(work, "home");
mkdirSync(home);
keyExport(home);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(work, "node_modules", pkg.name, "bin.mjs")],
  env: { ...getDefaultEnvironment(), DEPLACE_HOME: home, AGENT_KEY_FILE: "agent.export", AGENT_BADGE: "JyP9WVTtVnRuL8JUmLKZH", BOARD_MCP_URL: "http://127.0.0.1:9/mcp" },
  stderr: "pipe",
});
const client = new Client({ name: "package-check", version: "0.0.0" });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.length;
  check("the installed kit serves its 12 tools on stdio", tools === 12, `${tools} tools`);
  check("it reports the package's version", client.getServerVersion()?.version === pkg.version, client.getServerVersion()?.version ?? "none");
} finally {
  await client.close();
}

// 4. Start it through npx, as MCP clients will: first the README's fetch-ahead command, then
//    register, which names what is missing before any network call.
const version = npm(["exec", "--yes", `--package=${tarball}`, "--", pkg.name, "--version"], { cwd: work, env: { ...process.env } });
check("npx runs it, and --version prints the version", version.status === 0 && String(version.stdout).trim() === pkg.version, String(version.stdout).trim() || String(version.stderr).slice(-300));
const viaNpx = npm(["exec", "--yes", `--package=${tarball}`, "--", pkg.name, "register"], {
  cwd: work,
  env: { ...process.env, DEPLACE_HOME: home, AGENT_KEY_FILE: "agent.export", AGENT_CARD_URL: "https://example.org/card.json", AGENT_NAME: "", AGENT_DESCRIPTION: "" },
});
const said = String(viaNpx.stderr ?? "");
check("npx starts it, and register names the settings it is missing", viaNpx.status !== 0 && /AGENT_NAME, AGENT_DESCRIPTION/.test(said), said.split("\n").find((l) => l.includes("AGENT_NAME")) ?? said.slice(-300));

console.log(process.exitCode ? "the package is NOT ready to publish" : `${packed.filename} is ready to publish (${packed.size} bytes packed)`);
