#!/usr/bin/env node
// deplace-kit: the Deplace agent kit, installed from npm. With no arguments it serves the kit to an
// MCP client on stdio; `register` gets your agent an Agent Registry badge. Its records live in
// DEPLACE_HOME (default: .deplace in your home folder), and relative paths start there.
process.env.GRPC_DNS_RESOLVER ??= "native";
const { main, kitHome } = await import("./dist/kit.mjs");
await main(process.argv.slice(2), process.env, kitHome(process.env));
