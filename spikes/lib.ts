// Shared helpers for the day-1 spikes. Throwaway code: later tasks copy the call shapes that work.
// grpc-js's own DNS resolver times out on some networks; the OS resolver works.
process.env.GRPC_DNS_RESOLVER ??= "native";

import { readFileSync } from "node:fs";
import { credentials } from "@grpc/grpc-js";
import { ConcordiumGRPCNodeClient } from "@concordium/web-sdk/nodejs";
import {
  AccountAddress,
  buildAccountSigner,
  parseWallet,
  Transaction,
  TransactionExpiry,
  TransactionHash,
  type AccountSigner,
} from "@concordium/web-sdk";

export const EXPLORER = "https://ccdexplorer.io/testnet";

export function grpc(): ConcordiumGRPCNodeClient {
  return new ConcordiumGRPCNodeClient(
    process.env.GRPC_HOST ?? "grpc.testnet.concordium.com",
    Number(process.env.GRPC_PORT ?? 20000),
    credentials.createSsl(),
    { timeout: 30_000 },
  );
}

export interface Wallet {
  name: string;
  address: AccountAddress.Type;
  signer: AccountSigner;
}

export function loadWallet(name: string): Wallet {
  const w = parseWallet(readFileSync(`secrets/${name}.export`, "utf8"));
  return { name, address: AccountAddress.fromBase58(w.value.address), signer: buildAccountSigner(w) };
}

/**
 * The sponsor-first flow from Workshop 3: the board builds the transaction, the sponsor
 * signs as fee payer, the JSON travels to the sender, the sender signs and submits.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function sponsoredSend(client: ConcordiumGRPCNodeClient, initial: any, sender: Wallet, sponsor: Wallet) {
  const { nonce } = await client.getNextAccountNonce(sender.address);
  const tx = initial
    .addMetadata({ sender: sender.address, nonce, expiry: TransactionExpiry.futureMinutes(5) })
    .addSponsor(sponsor.address)
    .build();
  const sponsored = await Transaction.sponsor(tx, sponsor.signer);

  // Round-trip through JSON, as it would travel from the board to a browser or agent.
  const json = Transaction.toJSONString(sponsored);
  const received = Transaction.signableFromJSON(JSON.parse(json));

  const signed = await Transaction.sign(received, sender.signer);
  const hash = await client.sendTransaction(Transaction.finalize(signed));
  const hex = TransactionHash.toHexString(hash);
  console.log(`submitted ${hex}\n  ${EXPLORER}/transaction/${hex}`);
  const outcome = await client.waitForTransactionFinalization(hash);
  return { hash: hex, outcome };
}

export function describeOutcome(outcome: unknown): string {
  return JSON.stringify(outcome, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}
