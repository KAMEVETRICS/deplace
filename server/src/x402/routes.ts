import { Router, type Request } from "express";
import { txLink } from "@bounty/shared";
import { BoardError, type BoardService } from "../board/service.js";
import type { DepositOutcome } from "../escrow/worker.js";

/** The x402 pieces the routes need; the real one wraps @x402/core and @x402/concordium. */
export interface X402Gateway {
  /** Payment terms for `amount` (smallest units) of the reward token to `payTo`, as header and body. */
  paymentRequired(o: { payTo: string; amount: bigint; resource: string; description: string }): Promise<{ header: string; body: unknown; requirements: unknown }>;
  /** Verifies a PAYMENT-SIGNATURE header against the terms and settles it (the sponsor pays the fee). */
  settle(paymentHeader: string, requirements: unknown): Promise<{ ok: true; tx: string; responseHeader: string; payer?: string } | { ok: false; error: string }>;
}

export interface PaymentOps {
  publicBaseUrl: string;
  /** Operator records the settlement as the bounty's payout; returns the record transaction. */
  recordPayout(id: bigint, payouts: { to: string; amount: bigint; tx: string }[]): Promise<string>;
  noteDeposit(tx: string): Promise<DepositOutcome>;
}

function bountyId(req: Request): bigint {
  const raw = String(req.params.id ?? "");
  if (!/^\d{1,20}$/.test(raw)) throw new BoardError(400, "bounty id must be a non-negative integer");
  return BigInt(raw);
}

/**
 * x402 on the board:
 *  - GET /bounties/:id/work  pay on delivery. For a not-funded bounty the poster pays the
 *    reward straight to the worker; the settlement is recorded as the payout and the full
 *    work is released. Escrowed work is released after acceptance without payment.
 *  - POST /bounties/:id/fund  funds escrow: the payment goes to the escrow account.
 */
export function x402Router(service: BoardService, gw: X402Gateway, ops: PaymentOps): Router {
  const r = Router();

  r.get("/bounties/:id/work", async (req, res) => {
    const who = service.session(req.header("authorization"));
    const id = bountyId(req);
    const b = await service.live(id);
    if (b.poster !== who.account) throw new BoardError(403, "only the bounty's poster can fetch the work");
    const items = await service.releasableWork(b);

    const owed = b.funding.type === "NotFunded" && b.status.type !== "Paid";
    if (!owed) {
      res.json({ bountyId: id, items });
      return;
    }
    const payee = await service.payee(b);
    if (!payee) throw new BoardError(409, `nothing is owed for bounty ${id}`);
    const terms = await gw.paymentRequired({
      payTo: payee,
      amount: b.reward,
      resource: `${ops.publicBaseUrl}/bounties/${id}/work`,
      description: `Reward for bounty ${id}, paid to the worker; unlocks the delivered work`,
    });
    const payment = req.header("payment-signature");
    if (!payment) {
      res.status(402).set("PAYMENT-REQUIRED", terms.header).json(terms.body);
      return;
    }
    const settled = await gw.settle(payment, terms.requirements);
    if (!settled.ok) {
      res.status(402).set("PAYMENT-REQUIRED", terms.header).json({ ...(terms.body as object), error: settled.error });
      return;
    }
    // The worker is paid at this point. Recording it is the operator's job; if that
    // fails the payment still stands, so release the work and report the problem.
    let recordTx: string | null = null;
    let recordError: string | null = null;
    try {
      recordTx = await ops.recordPayout(id, [{ to: payee, amount: b.reward, tx: settled.tx }]);
      await service.refresh(id);
    } catch (e) {
      recordError = (e as Error).message;
      console.error(`[x402] bounty ${id}: payment ${settled.tx} settled but recording failed:`, e);
    }
    res.set("PAYMENT-RESPONSE", settled.responseHeader).json({
      bountyId: id,
      items,
      payment: { tx: settled.tx, link: txLink(settled.tx), payer: settled.payer, recordTx, recordError },
    });
  });

  r.post("/bounties/:id/fund", async (req, res) => {
    const who = service.session(req.header("authorization"));
    const id = bountyId(req);
    const b = await service.live(id);
    if (b.poster !== who.account) throw new BoardError(403, "only the bounty's poster can fund it");
    if (b.funding.type !== "NotFunded") throw new BoardError(409, `bounty ${id} is already escrowed`);
    if (!["Open", "Claimed", "Submitted"].includes(b.status.type)) throw new BoardError(409, `bounty ${id} is ${b.status.type} and can no longer be funded`);
    const terms = await gw.paymentRequired({
      payTo: service.config.escrowAccount,
      amount: b.reward,
      resource: `${ops.publicBaseUrl}/bounties/${id}/fund`,
      description: `Escrow the reward for bounty ${id} (custodial escrow account)`,
    });
    const payment = req.header("payment-signature");
    if (!payment) {
      res.status(402).set("PAYMENT-REQUIRED", terms.header).json(terms.body);
      return;
    }
    const settled = await gw.settle(payment, terms.requirements);
    if (!settled.ok) {
      res.status(402).set("PAYMENT-REQUIRED", terms.header).json({ ...(terms.body as object), error: settled.error });
      return;
    }
    const funded = await ops.noteDeposit(settled.tx);
    await service.refresh(id);
    res.set("PAYMENT-RESPONSE", settled.responseHeader).json({ bountyId: id, funded, payment: { tx: settled.tx, link: txLink(settled.tx) } });
  });

  return r;
}
