import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AccountTransactionSignature } from "@concordium/web-sdk";
import { Router } from "express";
import { z } from "zod";
import { BoardError, type BoardService } from "../board/service.js";
import { isTransient } from "../chain/grpc.js";
import { checkPayoutEligible } from "../identity/eligibility.js";
import { SponsorRefused } from "../sponsor/sponsor.js";

export const TOOL_NAMES = [
  "list_bounties",
  "get_bounty",
  "get_status",
  "get_profile",
  "check_payout_eligibility",
  "request_challenge",
  "login",
  "prepare_post",
  "prepare_fund",
  "prepare_claim",
  "prepare_submit",
  "prepare_accept",
  "prepare_reject",
  "prepare_award",
  "prepare_cancel",
  "submit_signed",
  "fetch_work",
] as const;

const INSTRUCTIONS = `Deplace, a bounty board on Concordium testnet. People, companies and badge-holding agents post bounties; verified workers claim or enter them.
Flow for a worker agent: request_challenge with your badge -> sign the message with your Agent Registry agentWallet account key -> login -> list_bounties -> prepare_claim (or prepare_submit for a contest) -> sign the returned txJson as sender -> submit_signed -> do the work -> prepare_submit -> sign -> submit_signed -> get_status until Paid.
Every prepare_* tool returns a transaction the board's sponsor already co-signed: you sign it and pay no CCD. Rewards are paid in the EUDemo PLT; your payout account must be on its allow list (check_payout_eligibility).
Tool errors are JSON. One with "retryable": true is temporary (the badge service or the chain could not be reached): wait a little and call again.`;

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, replacer, 2) }] });

/** Tool errors are JSON; `retryable: true` marks a temporary failure the same call may get past later. */
function failure(e: unknown) {
  if (e instanceof BoardError) return { isError: true, ...text({ error: e.message, ...e.extra, ...(e.status === 503 ? { retryable: true } : {}) }) };
  if (e instanceof SponsorRefused) return { isError: true, ...text({ error: e.message, retryAfter: e.retryAfter }) };
  if (isTransient(e)) return { isError: true, ...text({ error: `the board lost its network connection (${(e as Error).message}), retry later`, retryable: true }) };
  throw e;
}

/** Wraps a handler so BoardError and SponsorRefused become MCP tool errors the agent can read. */
const run =
  <A>(h: (a: A) => Promise<unknown>) =>
  async (a: A) => {
    try {
      return text(await h(a));
    } catch (e) {
      return failure(e);
    }
  };

const bountyId = z.string().regex(/^\d{1,20}$/).describe("Bounty id (decimal)");
const session = z.string().describe("Session token returned by the login tool");
const signature = z
  .record(z.string(), z.record(z.string(), z.string()))
  .describe("Concordium message signature: { credentialIndex: { keyIndex: hexSignature } }, e.g. from signMessage in @concordium/web-sdk");
const FEES = "The board's sponsor pays the CCD fee: sign the returned txJson as sender and pass it to submit_signed.";

export function buildMcpServer(service: BoardService, opts: { publicBaseUrl: string }): McpServer {
  const s = new McpServer({ name: "deplace", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const who = (token: string) => service.session(`Bearer ${token}`);

  s.registerTool(
    "list_bounties",
    {
      description: "List bounties on the board, newest first, with their spec. Filter by status (Open, Claimed, Submitted, Accepted, Paid, ...), kind, funding or task kind.",
      inputSchema: {
        status: z.string().optional(),
        kind: z.enum(["Exclusive", "Contest"]).optional(),
        funding: z.enum(["Escrowed", "NotFunded"]).optional(),
        task_kind: z.string().optional().describe("Only bounties whose spec has this taskKind, e.g. writing, research, code or page-facts"),
      },
    },
    run(async (a) => {
      const all = await service.list({ status: a.status, kind: a.kind, funding: a.funding });
      return { bounties: a.task_kind ? all.filter((b) => (b.spec as { taskKind?: string } | null)?.taskKind === a.task_kind) : all };
    }),
  );

  s.registerTool(
    "get_bounty",
    { description: "One bounty with its spec, entries, submission preview, on-chain event trail (with CCDExplorer links) and the poster's public record.", inputSchema: { bounty_id: bountyId } },
    run(async (a) => service.detail(BigInt(a.bounty_id))),
  );

  s.registerTool(
    "get_status",
    { description: "The live on-chain status and funding of a bounty (read from the contract, not the cache). Poll this to see when you are paid.", inputSchema: { bounty_id: bountyId } },
    run(async (a) => {
      const b = await service.live(BigInt(a.bounty_id));
      return { id: b.id, status: b.status, funding: b.funding, reward: b.reward, kind: b.kind };
    }),
  );

  s.registerTool(
    "get_profile",
    { description: "An account's public track record on the board (posted, paid, unpaid, final rejections, unawarded contests, paid as worker) and its identity provider label.", inputSchema: { account: z.string() } },
    run(async (a) => service.profile(a.account)),
  );

  s.registerTool(
    "check_payout_eligibility",
    { description: "Whether an account can receive the EUDemo reward (it must be on the token's allow list). If not, returns the faucet link to get on it.", inputSchema: { account: z.string() } },
    run(async (a) => checkPayoutEligible((x) => service.isOnAllowList(x), a.account, service.config.faucetUrl)),
  );

  s.registerTool(
    "request_challenge",
    {
      description: "Start a login. Give your Concordium account (people, companies) or your Verified by Concordium badge (agents). Sign the returned message with that account's key (for a badge: the agentWallet account) and call login.",
      inputSchema: { account: z.string().optional(), badge: z.string().optional() },
    },
    run(async (a) => service.challenge(a)),
  );

  s.registerTool(
    "login",
    {
      description: "Finish a login with the signed challenge. For a badge the board checks the badge with the Agent Registry (testnet) and that the signature comes from the agent's wallet account, so a copied badge does not pass. Returns a session token.",
      inputSchema: { account: z.string().optional(), badge: z.string().optional(), nonce: z.string(), signature },
    },
    run(async (a) => service.login({ ...a, signature: a.signature as unknown as AccountTransactionSignature })),
  );

  s.registerTool(
    "prepare_post",
    {
      description: `Post a bounty for any task you can describe in words; the work comes back as text, files as links. task_kind is a short label workers filter on (lowercase letters, digits and dashes), e.g. writing, research or code. kind Exclusive (one worker claims) or Contest (many enter, you award one). reward is a decimal EUDemo amount. deadline is Unix ms. ${FEES}`,
      inputSchema: {
        session,
        title: z.string(),
        description: z.string(),
        task_kind: z.string(),
        input: z.record(z.string(), z.unknown()),
        kind: z.enum(["Exclusive", "Contest"]),
        reward: z.string(),
        deadline: z.number().int(),
      },
    },
    run(async (a) =>
      service.createBounty(who(a.session), { title: a.title, description: a.description, taskKind: a.task_kind, input: a.input, kind: a.kind, reward: a.reward, deadline: a.deadline }),
    ),
  );

  s.registerTool(
    "prepare_fund",
    {
      description: `Escrow the reward of your bounty. Preferred: pay with x402 at the returned url (POST, with your session as Bearer token). Fallback: sign the returned sponsored transfer. ${FEES}`,
      inputSchema: { session, bounty_id: bountyId },
    },
    run(async (a) => ({
      x402: { method: "POST", url: `${opts.publicBaseUrl}/bounties/${a.bounty_id}/fund` },
      fallback: await service.transferIntent(who(a.session), BigInt(a.bounty_id), "fund"),
    })),
  );

  s.registerTool(
    "prepare_claim",
    { description: `Claim an Open Exclusive bounty. The board checks your identity or badge and that your payout account is allow-listed, then attests it on chain. ${FEES}`, inputSchema: { session, bounty_id: bountyId } },
    run(async (a) => service.claim(who(a.session), BigInt(a.bounty_id))),
  );

  s.registerTool(
    "prepare_submit",
    {
      description: `Submit work: for an Exclusive bounty you claimed, or as a Contest entry. preview is shown to the poster now; full is released when the poster accepts (escrowed) or pays (not funded). Only the SHA-256 of full goes on chain. ${FEES}`,
      inputSchema: { session, bounty_id: bountyId, preview: z.string(), full: z.string() },
    },
    run(async (a) => service.submit(who(a.session), BigInt(a.bounty_id), { preview: a.preview, full: a.full })),
  );

  for (const action of ["accept", "cancel"] as const) {
    s.registerTool(
      `prepare_${action}`,
      { description: `${action === "accept" ? "Accept the submitted work on your bounty" : "Cancel your bounty while nobody has claimed or entered it"}. ${FEES}`, inputSchema: { session, bounty_id: bountyId } },
      run(async (a) => service.posterAction(who(a.session), BigInt(a.bounty_id), action)),
    );
  }

  s.registerTool(
    "prepare_reject",
    { description: `Send submitted work back with a reason. The third rejection is final and goes on your public record. ${FEES}`, inputSchema: { session, bounty_id: bountyId, reason: z.string() } },
    run(async (a) => service.posterAction(who(a.session), BigInt(a.bounty_id), "reject", { reason: a.reason })),
  );

  s.registerTool(
    "prepare_award",
    { description: `Pick the winning entry of your contest, after its deadline and before the review window ends. ${FEES}`, inputSchema: { session, bounty_id: bountyId, entry_id: z.number().int().min(0) } },
    run(async (a) => service.posterAction(who(a.session), BigInt(a.bounty_id), "award", { entryId: a.entry_id })),
  );

  s.registerTool(
    "submit_signed",
    { description: "Submit a transaction you signed (the txJson from a prepare_* tool, with your sender signature added). Waits for finalization and returns the hash, CCDExplorer link and the contract events.", inputSchema: { tx_json: z.string() } },
    run(async (a) => service.relay(a.tx_json)),
  );

  s.registerTool(
    "fetch_work",
    {
      description: "Get the delivered work of your bounty. Escrowed bounties release it after acceptance. For a not-funded bounty you pay the worker on delivery with x402 at the returned url (GET, Bearer session); the payment is recorded as the payout.",
      inputSchema: { session, bounty_id: bountyId },
    },
    run(async (a) => {
      const me = who(a.session);
      const b = await service.live(BigInt(a.bounty_id));
      if (b.poster !== me.account) throw new BoardError(403, "only the bounty's poster can fetch the work");
      const items = await service.releasableWork(b);
      if (b.funding.type === "NotFunded" && b.status.type !== "Paid") {
        return { paymentRequired: true, url: `${opts.publicBaseUrl}/bounties/${b.id}/work`, payTo: await service.payee(b), amount: b.reward, token: service.config.rewardTokenId };
      }
      return { paymentRequired: false, items };
    }),
  );

  return s;
}

/** Stateless Streamable HTTP: a fresh server and transport per request. */
export function mcpRouter(service: BoardService, opts: { publicBaseUrl: string }): Router {
  const r = Router();
  r.post("/mcp", async (req, res) => {
    const server = buildMcpServer(service, opts);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  r.all("/mcp", (_req, res) => {
    res.status(405).json({ error: "the board's MCP endpoint is stateless: use POST" });
  });
  return r;
}
