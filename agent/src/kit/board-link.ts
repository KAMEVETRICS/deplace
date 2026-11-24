import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { BoardToolError, isRetryable, type BoardConnection } from "../board-client.js";
import { RailViolation } from "../rails/guard.js";
import type { AgentKeys } from "../signer.js";
import { login, type Board, type Relayed } from "../worker.js";
import { KitError } from "./errors.js";

/** The board's GET /config. */
export interface BoardConfigView {
  contract: { index: string; subindex: string };
  escrowAccount: string;
  rewardToken: string;
  decimals: number;
  faucetUrl: string | null;
}

type Connection = BoardConnection;

export interface BoardLinkOptions {
  /** connectBoard(BOARD_MCP_URL) in production. */
  connect: () => Promise<Connection>;
  /** new URL(BOARD_MCP_URL).origin */
  origin: string;
  fetch: typeof fetch;
  badge: string;
  keys: AgentKeys;
  /** The agent's own token id, from its badge: a session for any other agent is refused. */
  agentTokenId: bigint;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log: (m: string) => void;
}

/** How long a tool call may spend retrying before anything is signed. */
const RETRY_WINDOW_MS = 30_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000];
/** The least time one attempt gets, even at the end of a window. */
const MIN_ATTEMPT_MS = 1_000;
/** submit_signed waits for finalization; past this, its answer counts as lost. */
const RELAY_TIMEOUT_MS = 45_000;
/** A connection replaced after a failure is closed only this much later, so calls still on it can finish. */
const RETIRED_CLOSE_MS = 60_000;
const NETWORK_CODES = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/;

/**
 * A failure of the connection to the board, not of the board's answer: worth waiting out
 * before anything is signed. A TypeError counts only when fetch raised it, so a bug in the
 * kit is never mistaken for a dropped connection.
 */
export function isTransportError(e: unknown): boolean {
  if (e instanceof BoardToolError || e instanceof KitError || e instanceof RailViolation) return false;
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return true; // a request that ran out of time
  if (e instanceof StreamableHTTPError) return true;
  if (e instanceof McpError) return e.code === ErrorCode.ConnectionClosed || e.code === ErrorCode.RequestTimeout;
  const err = e as { message?: unknown; code?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
  if (e instanceof TypeError && (/fetch failed/i.test(e.message) || err?.cause !== undefined)) return true;
  // The Concordium node over gRPC: unreachable, or too slow to answer.
  if (err?.code === "UNAVAILABLE" || err?.code === 14 || err?.code === "DEADLINE_EXCEEDED" || err?.code === 4) return true;
  const text = [err?.message, err?.code, err?.cause?.code, err?.cause?.message].filter((x): x is string => typeof x === "string").join(" ");
  return NETWORK_CODES.test(text);
}

/** The board's JSON `error`, or the text itself. */
function errorText(detail: string): string {
  try {
    const error = (JSON.parse(detail) as { error?: unknown } | null)?.error;
    return typeof error === "string" ? error : detail;
  } catch {
    return detail; // plain text
  }
}

const describe = (e: unknown) => (e instanceof BoardToolError ? errorText(e.detail) : ((e as Error)?.message ?? String(e)));

/** The board forgot the session: it keeps sessions in memory, so a redeploy signs everyone out. */
const isLoginFirst = (e: unknown) => e instanceof BoardToolError && errorText(e.detail).startsWith("log in first");

/**
 * The kit's connection to the board's MCP endpoint and HTTP routes. Before anything is signed,
 * it waits out dropped connections (reconnecting) and refusals the board marks retryable, up to
 * a deadline. Sending a signed transaction is never retried: a lost answer is reported as such.
 */
export class BoardLink implements Board {
  readonly origin: string;
  private connection: Connection | null = null;
  private connecting: Promise<Connection> | null = null;
  private token: string | null = null;
  private loggingIn: Promise<string> | null = null;
  private configView: BoardConfigView | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: BoardLinkOptions) {
    this.origin = o.origin;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async connected(): Promise<Connection> {
    if (this.connection) return this.connection;
    this.connecting ??= this.o.connect().finally(() => {
      this.connecting = null;
    });
    this.connection = await this.connecting;
    return this.connection;
  }

  /**
   * Stops using a connection that failed, so the next call connects again. Only that connection:
   * a late failure on an old one leaves a newer one alone. It is closed a minute later, so calls
   * still on it (a submit_signed waiting for finalization) aren't cut off.
   */
  private retire(c: Connection) {
    if (this.connection === c) this.connection = null;
    const timer = setTimeout(() => {
      c.close().catch((e: unknown) => this.o.log(`closing an old connection failed (${describe(e)})`)); // it is no longer used either way
    }, RETIRED_CLOSE_MS);
    timer.unref?.();
  }

  /** Time left for one attempt before `deadline`. */
  private within(deadline: number): number {
    return Math.max(MIN_ATTEMPT_MS, deadline - this.now());
  }

  private async retrying<T>(what: string, attempt: () => Promise<T>, deadline: number): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await attempt();
      } catch (e) {
        const transport = isTransportError(e);
        if (!transport && !isRetryable(e)) throw e;
        const left = deadline - this.now();
        if (left <= 0) {
          const why = transport ? `could not reach the board for ${what} (${describe(e)})` : `the board could not answer ${what} just now (${describe(e)})`;
          throw new KitError(`${why}; nothing was signed or sent`, true);
        }
        const wait = Math.min(BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]!, left);
        this.o.log(`${what}: ${describe(e)}; trying again in ${Math.ceil(wait / 1000)} s`);
        await this.sleep(wait);
      }
    }
  }

  call<T>(name: string, args: Record<string, unknown>, deadline = this.now() + RETRY_WINDOW_MS): Promise<T> {
    return this.retrying(
      name,
      async () => {
        const c = await this.connected();
        try {
          return await c.callWithin<T>(name, args, this.within(deadline));
        } catch (e) {
          if (isTransportError(e)) this.retire(c);
          throw e;
        }
      },
      deadline,
    );
  }

  async relay(txJson: string): Promise<Relayed> {
    let c: Connection;
    try {
      c = await this.connected();
    } catch (e) {
      if (!isTransportError(e)) throw e;
      throw new KitError(`could not reach the board to send the transaction (${describe(e)}); it was not sent`, true);
    }
    try {
      return await c.callWithin<Relayed>("submit_signed", { tx_json: txJson }, RELAY_TIMEOUT_MS);
    } catch (e) {
      if (!isTransportError(e)) throw e;
      this.retire(c);
      throw new KitError(`the transaction was sent but the board's answer was lost (${describe(e)}); it may still go through, so the kit looks it up before trying again`, true, {
        outcomeUnknown: true,
      });
    }
  }

  get<T>(path: string, deadline = this.now() + RETRY_WINDOW_MS): Promise<T> {
    return this.retrying(
      `GET ${path}`,
      async () => {
        const res = await this.o.fetch(`${this.origin}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(this.within(deadline)) });
        const text = await res.text();
        if (res.status === 502 || res.status === 503 || res.status === 504) {
          // The board (or the proxy in front of it) is down for a moment.
          throw new BoardToolError(`GET ${path}`, JSON.stringify({ error: `HTTP ${res.status} ${errorText(text).slice(0, 200)}`, retryable: true }));
        }
        if (!res.ok) throw new BoardToolError(`GET ${path}`, text);
        return JSON.parse(text) as T;
      },
      deadline,
    );
  }

  async config(deadline?: number): Promise<BoardConfigView> {
    this.configView ??= await this.get<BoardConfigView>("/config", deadline);
    return this.configView;
  }

  private session(deadline: number): Promise<string> {
    if (this.token) return Promise.resolve(this.token);
    this.loggingIn ??= login({ board: { call: (name, args) => this.call(name, args, deadline) }, badge: this.o.badge, keys: this.o.keys }, this.o.agentTokenId)
      .then((s) => (this.token = s.token))
      .finally(() => {
        this.loggingIn = null;
      });
    return this.loggingIn;
  }

  async withSession<T>(fn: (token: string) => Promise<T>, deadline = this.now() + RETRY_WINDOW_MS): Promise<T> {
    const token = await this.session(deadline);
    try {
      return await fn(token);
    } catch (e) {
      if (!isLoginFirst(e)) throw e;
      if (this.token === token) this.token = null;
      this.o.log("the board forgot the session (it may have restarted); logging in again");
      return fn(await this.session(deadline));
    }
  }

  async close(): Promise<void> {
    const c = this.connection;
    this.connection = null;
    await c?.close();
  }
}
