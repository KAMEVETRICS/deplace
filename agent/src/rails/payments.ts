import { x402Client } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";

type SchemeClient = Parameters<x402Client["register"]>[1];

export interface GuardedPaymentOptions {
  network: `${string}:${string}`;
  scheme: SchemeClient;
  /** The reward token, e.g. EUDemo. */
  asset: string;
  /** Per-payment cap in the token's smallest units. */
  maxAtomic: bigint;
  /** What the agent expects to pay right now: the escrow account or the worker on record, and the committed reward. */
  expected: () => { payTo: string; amount: string } | null;
  /**
   * Books the payment against the agent's budget just before it is signed; throw to refuse.
   * Returns an undo, which the client calls only when signing failed and no payment exists.
   */
  book: (amount: bigint) => () => void;
}

/**
 * An x402 client that pays only the reward token, only up to a per-payment cap, only the
 * payee and amount the agent expects, and only what its budget books. The default client
 * would refuse EUDemo outright (its default assets are USDR only, up to $1), so the token
 * has to be allowed explicitly; the cap set here is the agent's per-payment limit.
 */
export function guardedPaymentClient(o: GuardedPaymentOptions): x402Client {
  const onlyExpected = (_version: number, reqs: PaymentRequirements[]): PaymentRequirements[] => {
    const e = o.expected();
    if (!e) return [];
    return reqs.filter((r) => r.asset === o.asset && r.payTo === e.payTo && r.amount === e.amount);
  };
  const client = x402Client.fromConfig({
    schemes: [{ network: o.network, client: o.scheme }],
    policies: [onlyExpected],
    spendControls: { allowedAssets: [{ network: o.network, asset: o.asset, maxAmountPerPayment: o.maxAtomic.toString() }] },
  });

  // These run after the policy and spend controls picked a requirement: before signing, and
  // when signing failed. A payment that was signed stays booked even if the request fails,
  // because it may have been settled.
  // Keyed by the payment request, so payments made at the same time keep their own undo.
  const undos = new WeakMap<object, () => void>();
  client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
    try {
      undos.set(paymentRequired, o.book(BigInt(selectedRequirements.amount)));
    } catch (e) {
      return { abort: true as const, reason: (e as Error).message };
    }
  });
  client.onPaymentCreationFailure(async ({ paymentRequired }) => {
    undos.get(paymentRequired)?.();
    undos.delete(paymentRequired);
  });
  return client;
}
