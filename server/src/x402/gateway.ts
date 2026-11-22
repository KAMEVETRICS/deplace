import { x402Facilitator } from "@x402/core/facilitator";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { x402ResourceServer } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { CONCORDIUM_TESTNET_CAIP2, toConcordiumFacilitatorSigner } from "@x402/concordium";
import { ExactConcordiumScheme as FacilitatorScheme } from "@x402/concordium/exact/facilitator";
import { ExactConcordiumScheme as ServerScheme } from "@x402/concordium/exact/server";
import type { X402Gateway } from "./routes.js";

export interface GatewayOptions {
  /** The sponsor co-signs every payment as fee payer (`extra.feePayer`) and submits it. */
  sponsorAddress: string;
  sponsorKeyHex: string;
  grpcHost: string;
  grpcPort: number;
  tokenId: string;
}

/**
 * x402 `exact` payments in the reward PLT through the board's own facilitator. Concordium
 * runs no hosted facilitator, so the board embeds one: it checks the payer's partly signed
 * transfer, adds the sponsor's signature, submits it and waits for finalization.
 */
export async function createX402Gateway(o: GatewayOptions): Promise<X402Gateway> {
  const network = CONCORDIUM_TESTNET_CAIP2 as `${string}:${string}`;
  const signer = toConcordiumFacilitatorSigner(o.sponsorAddress, o.sponsorKeyHex, { host: o.grpcHost, port: o.grpcPort, useTls: true, network });
  const facilitator = new x402Facilitator().register(network, new FacilitatorScheme({ signer, requireFinalization: true }));
  const resourceServer = new x402ResourceServer({
    verify: (p, r) => facilitator.verify(p, r),
    settle: (p, r) => facilitator.settle(p, r),
    getSupported: async () => facilitator.getSupported() as never,
  }).register(network, new ServerScheme());
  await resourceServer.initialize();

  return {
    async paymentRequired({ payTo, amount, resource, description }) {
      const [requirements] = await resourceServer.buildPaymentRequirements({
        scheme: "exact",
        payTo,
        price: { amount: amount.toString(), asset: o.tokenId },
        network,
        maxTimeoutSeconds: 300,
      });
      if (!requirements) throw new Error("x402: no payment requirements built");
      const body = await resourceServer.createPaymentRequiredResponse([requirements], { url: resource, description, mimeType: "application/json" });
      return { header: encodePaymentRequiredHeader(body), body, requirements };
    },

    async settle(paymentHeader, requirements, expectedPayer) {
      let payload;
      try {
        payload = decodePaymentSignatureHeader(paymentHeader);
      } catch (e) {
        return { ok: false, error: `malformed PAYMENT-SIGNATURE header: ${(e as Error).message}` };
      }
      const req = requirements as PaymentRequirements;
      const verified = await resourceServer.verifyPayment(payload, req);
      if (!verified.isValid) return { ok: false, error: verified.invalidMessage ?? verified.invalidReason ?? "payment is not valid" };
      // Refuse before settling: a payment from another account would move money the board cannot attribute.
      if (expectedPayer && verified.payer !== expectedPayer) return { ok: false, error: `the payment must come from the poster's account ${expectedPayer}` };
      const settled = await resourceServer.settlePayment(payload, req);
      if (!settled.success) return { ok: false, error: settled.errorMessage ?? settled.errorReason ?? "settlement failed" };
      return { ok: true, tx: settled.transaction, payer: settled.payer, responseHeader: encodePaymentResponseHeader(settled) };
    },
  };
}
