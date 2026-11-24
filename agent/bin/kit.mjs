// Starts the Deplace agent kit: an MCP server on stdio, or `register` to get an Agent Registry badge.
process.env.GRPC_DNS_RESOLVER ??= "native";
const { register } = await import("tsx/esm/api");
register();
const { main } = await import("../src/kit/main.ts");
await main(process.argv.slice(2), process.env);
