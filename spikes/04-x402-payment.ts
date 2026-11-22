// Spike 04: x402 `exact` payment in EUDemo through our own facilitator (sponsor pays the fee).
// The poster (client) pays 1 EUDemo to worker-agent to unlock a resource.
// Run: npx tsx spikes/04-x402-payment.ts
import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { CONCORDIUM_TESTNET_CAIP2, toConcordiumFacilitatorSigner } from "@x402/concordium";
import { ExactConcordiumScheme as FacilitatorScheme } from "@x402/concordium/exact/facilitator";
import { ExactConcordiumScheme as ServerScheme } from "@x402/concordium/exact/server";
import { ExactConcordiumScheme as ClientScheme } from "@x402/concordium/exact/client";
import { readFileSync } from "node:fs";
import { AccountAddress, buildBasicAccountSigner, parseWallet } from "@concordium/web-sdk";
import { Token, TokenId } from "@concordium/web-sdk/plt";
import { grpc } from "./lib.ts";

process.env.GRPC_DNS_RESOLVER ??= "native";
const network = CONCORDIUM_TESTNET_CAIP2 as `${string}:${string}`;

function keyOf(name: string) {
  const w = parseWallet(readFileSync(`secrets/${name}.export`, "utf8"));
  const key = w.value.accountKeys.keys[0]?.keys[0]?.signKey;
  if (!key) throw new Error(`${name}: no credential 0 key 0 in export`);
  return { address: w.value.address, key };
}
const sponsor = keyOf("sponsor");
const poster = keyOf("poster");
const worker = keyOf("worker-agent");

const tokenId = process.env.REWARD_TOKEN_ID ?? "EUDemo";
const decimals = (await Token.fromId(grpc(), TokenId.fromString(tokenId))).info.state.decimals;
const amount = (10n ** BigInt(decimals)).toString(); // 1 token

// Facilitator (in-process): verifies the payer's signed transaction, co-signs as sponsor, submits.
const signer = toConcordiumFacilitatorSigner(sponsor.address, sponsor.key, {
  host: "grpc.testnet.concordium.com",
  port: 20000,
  useTls: true,
  network,
});
const facilitator = new x402Facilitator().register(network, new FacilitatorScheme({ signer, requireFinalization: true }));
const facilitatorClient = {
  verify: (p: any, r: any) => facilitator.verify(p, r),
  settle: (p: any, r: any) => facilitator.settle(p, r),
  getSupported: async () => facilitator.getSupported() as never,
};

const resourceServer = new x402ResourceServer(facilitatorClient as never).register(network, new ServerScheme());
const app = express();
app.use(
  paymentMiddleware(
    { "GET /work": { accepts: { scheme: "exact", price: { amount, asset: tokenId }, network, payTo: worker.address }, description: "spike: unlock work" } },
    resourceServer,
  ),
);
app.get("/work", (_req, res) => res.json({ work: "the full deliverable" }));
const server = app.listen(4999);

const client = new x402Client().register(
  network,
  new ClientScheme({ accountAddress: AccountAddress.fromBase58(poster.address), signer: buildBasicAccountSigner(poster.key) }),
);
const paying = wrapFetchWithPayment(fetch, client);
const res = await paying("http://localhost:4999/work");
console.log("status", res.status, await res.text());
const receipt = res.headers.get("payment-response");
if (receipt) console.log("PAYMENT-RESPONSE", Buffer.from(receipt, "base64").toString("utf8"));
server.close();
