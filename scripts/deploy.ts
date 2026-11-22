// Deploys and initializes bounty_board on testnet from the operator account.
// Deploy and init are NOT sponsored: a sponsored init was reported failing on testnet.
//
//   1. powershell scripts/build-contract.ps1        (writes dist/bounty_board.wasm.v1)
//   2. npx tsx scripts/deploy.ts [--demo]          (--demo: short review/payment windows)
//
// Writes CONTRACT_INDEX into .env and prints the CCDExplorer links.
import "../server/src/env-init.js";
import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  AccountAddress,
  CcdAmount,
  ContractName,
  Energy,
  ModuleReference,
  Parameter,
  Transaction,
  TransactionExpiry,
  TransactionHash,
} from "@concordium/web-sdk";
import { encodeInit, instanceLink, loadConfig, txLink } from "@bounty/shared";
import { grpcClient, bigintJson } from "../server/src/chain/grpc.js";
import { loadOrCreateAttestorSeed, loadWallet } from "../server/src/chain/wallet.js";
import { Attestor } from "../server/src/identity/attestor.js";

const demo = process.argv.includes("--demo");
const cfg = loadConfig(process.env);
const client = grpcClient(cfg);
const operator = loadWallet(cfg.keyFiles.operator);
const sender = AccountAddress.fromBase58(operator.address);
const attestorPub = new Attestor(loadOrCreateAttestorSeed(cfg.keyFiles.attestor)).publicKeyHex;
const reviewWindowMs = demo ? BigInt(process.env.DEMO_REVIEW_WINDOW_MS ?? 180_000) : cfg.reviewWindowMs;
const paymentWindowMs = demo ? BigInt(process.env.DEMO_PAYMENT_WINDOW_MS ?? 180_000) : cfg.paymentWindowMs;

const MODULE = "dist/bounty_board.wasm.v1";
if (!existsSync(MODULE)) throw new Error(`${MODULE} missing: run scripts/build-contract.ps1 first`);

async function send(tx: ReturnType<typeof Transaction.deployModule> | ReturnType<typeof Transaction.initContract>) {
  const { nonce } = await client.getNextAccountNonce(sender);
  const signable = tx.addMetadata({ sender, nonce, expiry: TransactionExpiry.futureMinutes(5) }).build();
  const hash = await client.sendTransaction(await Transaction.signAndFinalize(signable, operator.signer));
  const hex = TransactionHash.toHexString(hash);
  console.log(`  tx ${txLink(hex)}`);
  return (await client.waitForTransactionFinalization(hash)).summary as any;
}

console.log(`Deploying ${MODULE} from operator ${operator.address}`);
const deployed = await send(Transaction.deployModule({ source: new Uint8Array(readFileSync(MODULE)) }));
let moduleRef: ModuleReference.Type;
if (deployed.transactionType === "failed") {
  if (deployed.rejectReason?.tag !== "ModuleHashAlreadyExists") throw new Error(`deploy failed: ${JSON.stringify(deployed.rejectReason, bigintJson)}`);
  moduleRef = deployed.rejectReason.contents;
  console.log("  module already on chain, reusing it");
} else {
  moduleRef = deployed.moduleDeployed.contents;
}
console.log(`  module ${ModuleReference.toHexString(moduleRef)}`);

console.log(`Initializing bounty_board (review window ${reviewWindowMs} ms, payment window ${paymentWindowMs} ms)`);
const init = await send(
  Transaction.initContract(
    {
      amount: CcdAmount.zero(),
      moduleRef,
      initName: ContractName.fromString("bounty_board"),
      param: Parameter.fromBuffer(
        encodeInit({
          admin: operator.address,
          operator: operator.address,
          attestorHex: attestorPub,
          registry: cfg.registry,
          rewardToken: cfg.rewardTokenId,
          reviewWindowMs,
          paymentWindowMs,
        }).slice().buffer,
      ),
    },
    Energy.create(30_000),
  ),
);
if (init.transactionType === "failed") throw new Error(`init failed: ${JSON.stringify(init.rejectReason, bigintJson)}`);
const address = init.contractInitialized.address;
console.log(`  instance <${address.index},${address.subindex}>  ${instanceLink(address.index, address.subindex)}`);

const env = existsSync(".env") ? readFileSync(".env", "utf8") : readFileSync(".env.example", "utf8");
const set = (text: string, key: string, value: string) =>
  new RegExp(`^${key}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
writeFileSync(".env", set(set(env, "CONTRACT_INDEX", String(address.index)), "CONTRACT_SUBINDEX", String(address.subindex)));
console.log("Wrote CONTRACT_INDEX to .env");
