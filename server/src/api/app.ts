import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { BoardError, type BoardService } from "../board/service.js";
import { SponsorRefused } from "../sponsor/sponsor.js";

export interface AppParts {
  service: BoardService;
  /** Paywalled routes (x402) mounted before the error handler. */
  extraRouters?: Router[];
  /** Static file routers, e.g. /agents for hosted Agent Cards and / for the web app. */
  mounts?: { path: string; router: Router }[];
  health?: () => Promise<unknown>;
}

function id(req: Request): bigint {
  const raw = String(req.params.id ?? "");
  if (!/^\d{1,20}$/.test(raw)) throw new BoardError(400, "bounty id must be a non-negative integer");
  return BigInt(raw);
}

/** The board's REST API. Every write returns a prepared transaction for the caller to sign. */
export function createApp({ service, extraRouters = [], mounts = [], health }: AppParts) {
  const app = express();
  app.set("json replacer", (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  app.use(express.json({ limit: "256kb" }));
  const who = (req: Request) => service.session(req.header("authorization"));

  app.post("/auth/challenge", (req, res) => {
    res.json(service.challenge({ account: req.body?.account, badge: req.body?.badge }));
  });
  app.post("/auth/login", async (req, res) => {
    res.json(await service.login(req.body ?? {}));
  });

  app.get("/config", (_req, res) => {
    const c = service.config;
    res.json({
      rewardToken: c.rewardTokenId,
      decimals: c.tokenDecimals,
      contract: c.contract,
      escrowAccount: c.escrowAccount,
      sponsorAccount: c.sponsorAddress,
      faucetUrl: c.faucetUrl,
    });
  });

  app.get("/bounties", async (req, res) => {
    const q = req.query;
    const f = {
      status: typeof q.status === "string" ? q.status : undefined,
      kind: q.kind === "Exclusive" || q.kind === "Contest" ? q.kind : undefined,
      funding: q.funding === "Escrowed" || q.funding === "NotFunded" ? q.funding : undefined,
      poster: typeof q.poster === "string" ? q.poster : undefined,
    } as const;
    const bounties = await service.list(f);
    res.json({ bounties, names: service.names(bounties.map((b) => b.poster)) });
  });
  app.get("/bounties/:id", async (req, res) => {
    res.json(await service.detail(id(req)));
  });
  app.get("/specs/:hash", (req, res) => {
    const json = service.spec(String(req.params.hash));
    if (!json) throw new BoardError(404, "no such spec");
    res.type("application/json").send(json);
  });
  app.put("/me/username", (req, res) => {
    res.json(service.setUsername(who(req), req.body?.username));
  });
  app.get("/profiles/:account", async (req, res) => {
    res.json(await service.profile(String(req.params.account)));
  });

  app.post("/bounties", async (req, res) => {
    res.json(await service.createBounty(who(req), req.body));
  });
  app.post("/bounties/:id/claim", async (req, res) => {
    res.json(await service.claim(who(req), id(req)));
  });
  app.post("/bounties/:id/submit", async (req, res) => {
    res.json(await service.submit(who(req), id(req), req.body ?? {}));
  });
  for (const action of ["accept", "cancel", "reject", "award"] as const) {
    app.post(`/bounties/:id/${action}`, async (req, res) => {
      res.json(await service.posterAction(who(req), id(req), action, { reason: req.body?.reason, entryId: req.body?.entryId }));
    });
  }
  app.post("/bounties/:id/fund-transfer", async (req, res) => {
    res.json(await service.transferIntent(who(req), id(req), "fund"));
  });
  app.post("/bounties/:id/pay-transfer", async (req, res) => {
    res.json(await service.transferIntent(who(req), id(req), "pay"));
  });
  app.post("/tx/submit", async (req, res) => {
    res.json(await service.relay(req.body?.txJson));
  });
  app.post("/tx/observe", async (req, res) => {
    res.json(await service.observe(req.body?.txHash));
  });
  app.get("/admin/health", async (_req, res) => {
    res.json(health ? await health() : { ok: true });
  });

  for (const r of extraRouters) app.use(r);
  for (const m of mounts) app.use(m.path, m.router);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BoardError) {
      res.status(err.status).json({ error: err.message, ...err.extra });
      return;
    }
    if (err instanceof SponsorRefused) {
      res.status(429).json({ error: err.message, retryAfter: err.retryAfter });
      return;
    }
    if ((err as { type?: string })?.type === "entity.parse.failed") {
      res.status(400).json({ error: "request body is not valid JSON" });
      return;
    }
    if ((err as { type?: string })?.type === "entity.too.large") {
      res.status(413).json({ error: "request body is too large (at most 256 KB)" });
      return;
    }
    console.error("[api] unexpected error", err);
    res.status(500).json({ error: "internal error" });
  });
  return app;
}
