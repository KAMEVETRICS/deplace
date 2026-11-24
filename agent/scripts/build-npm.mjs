// Builds the agent kit's npm package in agent/npm: bundles the kit's TypeScript, with the repo's
// shared code, into dist/kit.mjs and copies the license next to it. Third-party packages stay
// imports that npm installs from the package's dependencies, which must be the versions the agent
// is tested with. npm runs this before `npm pack` and `npm publish` (prepack).
import { copyFileSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const AGENT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NPM = join(AGENT, "npm");
const pkg = JSON.parse(readFileSync(join(NPM, "package.json"), "utf8"));
const tested = JSON.parse(readFileSync(join(AGENT, "package.json"), "utf8")).dependencies;

function fail(message) {
  console.error(`build-npm: ${message}`);
  process.exit(1);
}

// The MCP server reports KIT_VERSION, so it must be the package's version.
const kitVersion = readFileSync(join(AGENT, "src", "kit", "version.ts"), "utf8").match(/KIT_VERSION = "([^"]+)"/)?.[1];
if (kitVersion !== pkg.version) fail(`agent/src/kit/version.ts says ${kitVersion}, agent/npm/package.json says ${pkg.version}`);

for (const [name, version] of Object.entries(pkg.dependencies)) {
  if (tested[name] !== version) fail(`${name} is ${version} in agent/npm/package.json but ${tested[name] ?? "absent"} in agent/package.json, which the tests run with`);
}

/** Bundles the repo's own code (relative imports and @deplace/*); every other package stays an import. */
const ownCodeOnly = {
  name: "own-code-only",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.kind === "entry-point" || isAbsolute(args.path) || args.path.startsWith("@deplace/")) return undefined;
      return { path: args.path, external: true };
    });
  },
};

const result = await build({
  entryPoints: [join(AGENT, "src", "kit", "npm-entry.ts")],
  outfile: join(NPM, "dist", "kit.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  plugins: [ownCodeOnly],
  metafile: true,
  logLevel: "warning",
  banner: { js: `// deplace-kit ${pkg.version}: the Deplace agent kit, built from agent/src/kit in https://github.com/KAMEVETRICS/deplace. Apache-2.0.` },
});

// Every package the bundle imports must be one of the package's dependencies, or npx fails to start it.
const packageOf = (p) => p.split("/").slice(0, p.startsWith("@") ? 2 : 1).join("/");
const builtin = (p) => p.startsWith("node:") || builtinModules.includes(packageOf(p));
const imported = new Set(
  Object.values(result.metafile.outputs).flatMap((o) => o.imports.filter((i) => i.external && !builtin(i.path)).map((i) => packageOf(i.path))),
);
const undeclared = [...imported].filter((p) => !(p in pkg.dependencies));
if (undeclared.length > 0) fail(`the bundle imports ${undeclared.join(", ")}, which agent/npm/package.json doesn't list as dependencies`);

copyFileSync(join(AGENT, "..", "LICENSE"), join(NPM, "LICENSE"));
// On stderr, so that `npm pack --json` keeps clean JSON on stdout.
console.error(`built deplace-kit ${pkg.version}: agent/npm/dist/kit.mjs, importing ${[...imported].sort().join(", ")}`);
