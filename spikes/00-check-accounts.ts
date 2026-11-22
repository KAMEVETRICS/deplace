// Spike 00: are the five testnet accounts ready? Read-only. For each role it prints the CCD
// balance, the EUDemo balance and allow-list status, and whether secrets/<role>.export exists
// and is that account's export (only the address is read from it; keys are never printed).
// Run: npx tsx spikes/00-check-accounts.ts [sponsor=<address> operator=<address> ...]
// Addresses given on the command line are checked against the exports; without them the
// addresses come from the exports.
import { existsSync, readFileSync } from "node:fs";
import { AccountAddress, parseWallet } from "@concordium/web-sdk";
import { Cbor } from "@concordium/web-sdk/plt";
import { EXPLORER, grpc } from "./lib.ts";

const FAUCET = "https://allowlist.testnet.concordium.com";
// [role, needs EUDemo]
const ROLES: [string, boolean][] = [
  ["sponsor", false],
  ["operator", true],
  ["poster", true],
  ["worker-agent", true],
  ["worker-human", true],
];
const given = Object.fromEntries(process.argv.slice(2).map((a) => a.split("=", 2) as [string, string]));
const tokenId = process.env.REWARD_TOKEN_ID ?? "EUDemo";
const client = grpc();
const todo: string[] = [];

for (const [role, needsToken] of ROLES) {
  const file = `secrets/${role}.export`;
  const exported = existsSync(file) ? parseWallet(readFileSync(file, "utf8")).value.address : null;
  const address = given[role] ?? exported;
  if (!address) {
    console.log(`${role.padEnd(13)} no address given and no ${file}`);
    todo.push(`${role}: export the key to ${file}`);
    continue;
  }
  if (!exported) todo.push(`${role}: export the key to ${file}`);
  else if (exported !== address) todo.push(`${role}: ${file} is the export of ${exported}, not ${address}`);

  let info;
  try {
    info = await client.getAccountInfo(AccountAddress.fromBase58(address));
  } catch (e) {
    console.log(`${role.padEnd(13)} ${address}  not found on testnet (${(e as Error).message})`);
    todo.push(`${role}: ${address} is not a testnet account`);
    continue;
  }
  const ccd = info.accountAmount.microCcdAmount;
  const t = info.accountTokens.find((x) => x.id.value === tokenId);
  const onList = t?.state.moduleState ? Cbor.decode(t.state.moduleState, "TokenModuleAccountState").allowList === true : false;
  const balance = t ? `${Number(t.state.balance.value) / 10 ** t.state.balance.decimals}` : "0";
  const key = exported === address ? "export ok" : exported ? "export MISMATCH" : "export missing";
  console.log(`${role.padEnd(13)} ${address}  CCD ${Number(ccd) / 1e6}  ${tokenId} ${balance} (allow list: ${onList ? "yes" : "no"})  ${key}`);
  if (ccd === 0n) todo.push(`${role}: request CCD in the wallet (Activity -> Request CCD)`);
  if (needsToken && !onList) todo.push(`${role}: get ${tokenId} from ${FAUCET}`);
}

console.log(todo.length ? `\nStill to do:\n- ${todo.join("\n- ")}` : "\nAll five accounts are ready.");
console.log(`Explorer: ${EXPLORER}/account/<address>`);
process.exit(0);
