import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AccountAddress, buildBasicAccountSigner } from "@concordium/web-sdk";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { BoardToolError, type BoardConnection } from "../src/board-client.js";
import { BoardLink, isTransportError } from "../src/kit/board-link.js";
import { KitError } from "../src/kit/errors.js";
import { RailViolation } from "../src/rails/guard.js";
import type { AgentKeys } from "../src/signer.js";

function keys(fill: number): AgentKeys {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyHex = privateKey.export({ format: "der", type: "pkcs8" }).subarray(16).toString("hex");
  return { address: AccountAddress.fromBuffer(new Uint8Array(32).fill(fill).buffer).address, privateKeyHex, signer: buildBasicAccountSigner(privateKeyHex) };
}
const me = keys(1);
const START = 1_000_000;

type Connection = BoardConnection;

/** A clock whose sleep moves it forward, so retries take no real time. */
function clock() {
  let t = START;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

/** A board connection whose tools answer from `tools` (given the call's time cap, if any); every call is recorded in `calls`. */
function connection(calls: { name: string; args: any }[], tools: Record<string, (args: any, timeoutMs?: number) => unknown>): Connection {
  const call = async (name: string, args: Record<string, any>, timeoutMs?: number): Promise<any> => {
    calls.push({ name, args });
    const tool = tools[name];
    if (!tool) throw new Error(`unexpected tool ${name}`);
    return tool(args, timeoutMs);
  };
  return {
    call: (name: string, args: Record<string, any>) => call(name, args),
    callWithin: (name: string, args: Record<string, any>, timeoutMs: number) => call(name, args, timeoutMs),
    async close() {},
  } as Connection;
}

function linkWith(connect: () => Promise<Connection>, fetchImpl: typeof fetch = async () => Promise.reject(new Error("no HTTP in this test"))) {
  const c = clock();
  const link = new BoardLink({ connect, origin: "http://board.test", fetch: fetchImpl, badge: "JyP9WVTtVnRuL8JUmLKZH", keys: me, agentTokenId: 1418n, now: c.now, sleep: c.sleep, log: () => {} });
  return { link, clock: c };
}

const busy = (tool: string) => new BoardToolError(tool, JSON.stringify({ error: "badge service unavailable (TypeError), retry later", retryable: true }));
const loginTools = (tokens: string[], tokenId = "1418") => ({
  request_challenge: () => ({ nonce: "n1", message: "Deplace/v1/login:n1" }),
  login: () => ({ token: tokens.shift() ?? "tok-last", identity: { account: me.address, tokenId } }),
});

describe("the kit's link to the board", () => {
  it("waits out a dropped connection before anything is signed, reconnecting", async () => {
    const calls: { name: string; args: any }[] = [];
    let connects = 0;
    const { link } = linkWith(async () => {
      connects++;
      if (connects <= 2) throw new TypeError("fetch failed");
      return connection(calls, { list_bounties: () => ({ bounties: [] }) });
    });
    expect(await link.call("list_bounties", {})).toEqual({ bounties: [] });
    expect(connects).toBe(3);
  });

  it("reconnects when a connection drops in the middle of the session", async () => {
    const calls: { name: string; args: any }[] = [];
    let connects = 0;
    let first = true;
    const { link } = linkWith(async () => {
      connects++;
      return connection(calls, {
        get_status: () => {
          if (first) {
            first = false;
            throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
          }
          return { status: { type: "Open" } };
        },
      });
    });
    expect(await link.call("get_status", { bounty_id: "5" })).toEqual({ status: { type: "Open" } });
    expect(connects).toBe(2);
  });

  it("gives up at the deadline and says nothing was signed or sent", async () => {
    const { link, clock: c } = linkWith(async () => {
      throw new TypeError("fetch failed");
    });
    const failure = await link.call("list_bounties", {}).catch((e) => e);
    expect(failure).toBeInstanceOf(KitError);
    expect(failure).toMatchObject({ retryable: true, message: expect.stringMatching(/nothing was signed or sent/) });
    expect(c.now()).toBeGreaterThan(START + 20_000);
    expect(c.now()).toBeLessThanOrEqual(START + 30_000);
  });

  it("waits out retryable refusals but passes final ones on at once", async () => {
    const calls: { name: string; args: any }[] = [];
    let reads = 0;
    const { link } = linkWith(async () =>
      connection(calls, {
        get_status: () => {
          if (++reads <= 2) throw busy("get_status");
          return { status: { type: "Open" } };
        },
        get_bounty: () => {
          throw new BoardToolError("get_bounty", JSON.stringify({ error: "no bounty 404" }));
        },
      }),
    );
    expect(await link.call("get_status", { bounty_id: "5" })).toEqual({ status: { type: "Open" } });
    expect(calls.filter((c) => c.name === "get_status")).toHaveLength(3);
    await expect(link.call("get_bounty", { bounty_id: "404" })).rejects.toThrow(/no bounty 404/);
    expect(calls.filter((c) => c.name === "get_bounty")).toHaveLength(1);
  });

  it("never retries submit_signed: a lost answer is reported as unknown, a refusal as it is", async () => {
    const calls: { name: string; args: any }[] = [];
    let relays = 0;
    const { link } = linkWith(async () =>
      connection(calls, {
        submit_signed: () => {
          if (++relays === 1) throw new TypeError("fetch failed");
          throw new BoardToolError("submit_signed", JSON.stringify({ error: "only transactions prepared and co-signed by this board's sponsor are relayed" }));
        },
      }),
    );
    await expect(link.relay("{}")).rejects.toMatchObject({ retryable: true, extra: { outcomeUnknown: true } });
    expect(calls.filter((c) => c.name === "submit_signed")).toHaveLength(1);
    await expect(link.relay("{}")).rejects.toBeInstanceOf(BoardToolError);
    expect(calls.filter((c) => c.name === "submit_signed")).toHaveLength(2);
  });

  it("logs in on first use, and again once the board forgets the session", async () => {
    const calls: { name: string; args: any }[] = [];
    let claims = 0;
    const { link } = linkWith(async () =>
      connection(calls, {
        ...loginTools(["tok-1", "tok-2"]),
        prepare_claim: () => {
          if (++claims === 1) throw new BoardToolError("prepare_claim", JSON.stringify({ error: "log in first (POST /auth/challenge, then /auth/login)" }));
          return { prepared: { txJson: "{}" } };
        },
      }),
    );
    await link.withSession((session) => link.call("prepare_claim", { session, bounty_id: "5" }));
    expect(calls.filter((c) => c.name === "login")).toHaveLength(2);
    expect(calls.filter((c) => c.name === "prepare_claim").map((c) => c.args.session)).toEqual(["tok-1", "tok-2"]);
    await link.withSession((session) => link.call("prepare_claim", { session, bounty_id: "6" }));
    expect(calls.filter((c) => c.name === "login")).toHaveLength(2); // the session is kept
  });

  it("refuses a session the board opened for another agent", async () => {
    const { link } = linkWith(async () => connection([], loginTools(["tok-1"], "7")));
    await expect(link.withSession(async () => "never")).rejects.toBeInstanceOf(RailViolation);
  });

  it("reads the board's config once", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ contract: { index: "13001", subindex: "0" }, escrowAccount: "x", rewardToken: "EUDemo", decimals: 6, faucetUrl: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const { link } = linkWith(async () => connection([], {}), fetchImpl);
    expect((await link.config()).contract).toEqual({ index: "13001", subindex: "0" });
    await link.config();
    expect(urls).toEqual(["http://board.test/config"]);
  });

  it("waits out a board that answers 502 over HTTP, and passes a 404 on", async () => {
    let n = 0;
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/specs/missing")) return new Response(JSON.stringify({ error: "no such spec" }), { status: 404 });
      return ++n === 1 ? new Response("Bad Gateway", { status: 502 }) : new Response(JSON.stringify({ reason: "needs the hash" }), { status: 200 });
    }) as unknown as typeof fetch;
    const { link } = linkWith(async () => connection([], {}), fetchImpl);
    expect(await link.get("/specs/abc")).toEqual({ reason: "needs the hash" });
    expect(n).toBe(2);
    await expect(link.get("/specs/missing")).rejects.toThrow(/no such spec/);
  });
});

describe("the kit's link to the board, when calls hang", () => {
  it("caps each attempt at what is left of the tool's deadline", async () => {
    const timeouts: number[] = [];
    const made = linkWith(async () =>
      connection([], {
        list_bounties: (_a, timeoutMs) => {
          timeouts.push(timeoutMs ?? -1);
          void made.clock.sleep(timeoutMs ?? 60_000); // the call hangs for as long as it is allowed to (60 s: the SDK's default)
          throw new McpError(ErrorCode.RequestTimeout, "Request timed out");
        },
      }),
    );
    const failure = await made.link.call("list_bounties", {}).catch((e) => e);
    expect(failure).toMatchObject({ retryable: true, message: expect.stringMatching(/nothing was signed or sent/) });
    expect(timeouts[0]).toBe(30_000);
    expect(made.clock.now() - START).toBeLessThanOrEqual(30_000);
  });

  it("gives submit_signed 45 seconds, and reports its timeout as an unknown outcome", async () => {
    const timeouts: number[] = [];
    const { link } = linkWith(async () =>
      connection([], {
        submit_signed: (_a, timeoutMs) => {
          timeouts.push(timeoutMs ?? -1);
          throw new McpError(ErrorCode.RequestTimeout, "Request timed out");
        },
      }),
    );
    await expect(link.relay("{}")).rejects.toMatchObject({ retryable: true, extra: { outcomeUnknown: true } });
    expect(timeouts).toEqual([45_000]);
  });

  it("works again on the next call once the network is back", async () => {
    let up = false;
    const { link } = linkWith(async () => {
      if (!up) throw new TypeError("fetch failed");
      return connection([], { list_bounties: () => ({ bounties: [] }) });
    });
    await expect(link.call("list_bounties", {})).rejects.toBeInstanceOf(KitError);
    up = true;
    expect(await link.call("list_bounties", {})).toEqual({ bounties: [] });
  });

  it("gives each GET a time limit, and waits out one that times out", async () => {
    const signals: unknown[] = [];
    let n = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal);
      if (++n === 1) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const { link } = linkWith(async () => connection([], {}), fetchImpl);
    expect(await link.get("/config")).toEqual({ ok: true });
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it("leaves the new connection alone when a call on the old one fails late", async () => {
    const calls: { name: string; args: any }[] = [];
    let connects = 0;
    const closed: number[] = [];
    let releaseSlow!: () => void;
    const slowFails = new Promise<void>((r) => (releaseSlow = r));
    const { link } = linkWith(async () => {
      const n = ++connects;
      const conn = connection(calls, {
        get_status: () => {
          if (n === 1) throw new TypeError("fetch failed");
          return { status: { type: "Open" } };
        },
        slow: async () => {
          if (n === 1) {
            await slowFails;
            throw new TypeError("fetch failed");
          }
          return { done: true };
        },
      });
      return { ...conn, close: async () => void closed.push(n) };
    });
    const slow = link.call("slow", {}); // in flight on connection 1
    await new Promise((r) => setTimeout(r, 0));
    expect(await link.call("get_status", { bounty_id: "5" })).toEqual({ status: { type: "Open" } }); // fails on 1, answers on 2
    releaseSlow(); // the old call fails now too
    expect(await slow).toEqual({ done: true }); // and is retried on connection 2
    expect(connects).toBe(2);
    expect(closed).not.toContain(2);
  });
});

describe("transport errors", () => {
  it("tells a network failure from a bug or a refusal", () => {
    expect(isTransportError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransportError(new StreamableHTTPError(502, "Bad Gateway"))).toBe(true);
    expect(isTransportError(new McpError(ErrorCode.RequestTimeout, "Request timed out"))).toBe(true);
    expect(isTransportError(new McpError(ErrorCode.ConnectionClosed, "Connection closed"))).toBe(true);
    expect(isTransportError(Object.assign(new Error("socket"), { cause: { code: "ECONNRESET" } }))).toBe(true);
    expect(isTransportError(new Error("getaddrinfo EAI_AGAIN deplace.space"))).toBe(true);
    expect(isTransportError(Object.assign(new Error("14 UNAVAILABLE: No connection established"), { code: "UNAVAILABLE" }))).toBe(true); // the Concordium node over gRPC
    expect(isTransportError(Object.assign(new Error("deadline exceeded"), { code: "DEADLINE_EXCEEDED" }))).toBe(true);
    expect(isTransportError(Object.assign(new Error("not found"), { code: "NOT_FOUND" }))).toBe(false);
    expect(isTransportError(new DOMException("The operation was aborted due to timeout", "TimeoutError"))).toBe(true);
    expect(isTransportError(new TypeError("Cannot read properties of undefined (reading 'status')"))).toBe(false);
    expect(isTransportError(new McpError(ErrorCode.InvalidParams, "bad args"))).toBe(false);
    expect(isTransportError(busy("login"))).toBe(false);
    expect(isTransportError(new RailViolation("no"))).toBe(false);
    expect(isTransportError(new KitError("no", true))).toBe(false);
  });
});
