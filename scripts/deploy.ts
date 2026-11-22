// Deploys and initializes deplace on testnet from the operator account.
// Deploy and init are NOT sponsored: a sponsored init was reported failing on testnet.
//
//   1. powershell scripts/build-contract.ps1        (writes dist/deplace.wasm.v1)
//   2. npx tsx scripts/deploy.ts [--demo]          (--demo: short review/payment windows)
//
// Writes CONTRACT_INDEX into .env and prints the CCDExplorer links.
import "../server/src/env-init.js";
import "dotenv/config";
import { createHash } from "node:crypto";
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
import { encodeInit, instanceLink, loadConfig, txLink } from "@deplace/shared";
import { grpcClient, bigintJson, isNotFound } from "../server/src/chain/grpc.js";
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

const MODULE = "dist/deplace.wasm.v1";
if (!existsSync(MODULE)) throw new Error(`${MODULE} missing: run scripts/build-contract.ps1 first`);

type Meta = { sender: AccountAddress.Type; nonce: Awaited<ReturnType<typeof client.getNextAccountNonce>>["nonce"]; expiry: TransactionExpiry.Type };

async function send(build: (m: Meta) => Transaction.Signable) {
  const { nonce } = await client.getNextAccountNonce(sender);
  const signable = build({ sender, nonce, expiry: TransactionExpiry.futureMinutes(5) });
  const hash = await client.sendTransaction(await Transaction.signAndFinalize(signable, operator.signer));
  const hex = TransactionHash.toHexString(hash);
  console.log(`  tx ${txLink(hex)}`);
  return (await client.waitForTransactionFinalization(hash)).summary as any;
}

// A module's reference is the SHA-256 of its versioned bytes, so it is known before deploying.
// (The finalized summary reports it as a plain hex string, not a ModuleReference.)
const source = new Uint8Array(readFileSync(MODULE));
const moduleRef = ModuleReference.fromHexString(createHash("sha256").update(source).digest("hex"));

async function onChain(ref: ModuleReference.Type): Promise<boolean> {
  try {
    await client.getModuleSource(ref);
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

// Deploying costs hundreds of CCD (by size), and a repeat deploy of the same module only fails.
if (await onChain(moduleRef)) {
  console.log(`Module ${ModuleReference.toHexString(moduleRef)} is already on chain, reusing it`);
} else {
  console.log(`Deploying ${MODULE} from operator ${operator.address}`);
  const deployed = await send((m) => Transaction.deployModule({ source }).addMetadata(m).build());
  if (deployed.transactionType === "failed") throw new Error(`deploy failed: ${JSON.stringify(deployed.rejectReason, bigintJson)}`);
  console.log(`  module ${ModuleReference.toHexString(moduleRef)}`);
}

console.log(`Initializing deplace (review window ${reviewWindowMs} ms, payment window ${paymentWindowMs} ms)`);
const init = await send((m) =>
  Transaction.initContract(
    {
      amount: CcdAmount.zero(),
      moduleRef,
      initName: ContractName.fromString("deplace"),
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
  )
    .addMetadata(m)
    .build(),
);
if (init.transactionType === "failed") throw new Error(`init failed: ${JSON.stringify(init.rejectReason, bigintJson)}`);
const address = init.contractInitialized?.address as { index: bigint; subindex: bigint } | undefined;
if (address?.index === undefined) throw new Error(`init went through but no instance address in the summary: ${JSON.stringify(init, bigintJson)}`);
console.log(`  instance <${address.index},${address.subindex}>  ${instanceLink(address.index, address.subindex)}`);

const env = existsSync(".env") ? readFileSync(".env", "utf8") : readFileSync(".env.example", "utf8");
const set = (text: string, key: string, value: string) =>
  new RegExp(`^${key}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
writeFileSync(".env", set(set(env, "CONTRACT_INDEX", String(address.index)), "CONTRACT_SUBINDEX", String(address.subindex)));
console.log("Wrote CONTRACT_INDEX to .env");
