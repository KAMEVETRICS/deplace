import type { Bounty, BoardConfig, Identity, Names, Prepared, Stats } from "./types.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly data: Record<string, unknown>,
  ) {
    super(message);
  }
}

let token: string | null = null;
try {
  token = sessionStorage.getItem("board-token");
} catch {
  token = null; // storage blocked: the session just lasts until reload
}

export function setToken(t: string | null) {
  token = t;
  try {
    if (t) sessionStorage.setItem("board-token", t);
    else sessionStorage.removeItem("board-token");
  } catch {
    /* storage blocked: keep the token in memory only */
  }
}

export const hasToken = () => token !== null;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, typeof data.error === "string" ? data.error : `HTTP ${res.status}`, data);
  return data as T;
}

export interface PreparedResponse {
  action: string;
  bountyId?: string;
  prepared: Prepared;
  specHash?: string;
  workHash?: string;
}

export interface Detail {
  names?: Names;
  bounty: Bounty;
  spec: Bounty["spec"];
  submission: { workHash: string; preview: string | null } | null;
  /** `agent` is the entrant's agent token id, `at` the entry time in ms; older boards leave them out. */
  entries: { entryId: number; worker: string; workHash: string; preview: string | null; agent?: string | null; at?: string | null }[];
  events: { tx: string; index: number; at: number; link: string; event: { type: string } & Record<string, unknown> }[];
  posterProfile: { stats: Stats; identity: { kind: string; idpName: string } | null };
  links: { contract: string; poster: string; posterAgent: string | null };
}

export const api = {
  config: () => call<BoardConfig>("GET", "/config"),
  schema: () => call<{ type: "ModuleSchema"; value: string }>("GET", "/contract/schema"),
  challenge: (account: string) => call<{ nonce: string; message: string }>("POST", "/auth/challenge", { account }),
  login: (account: string, nonce: string, signature: unknown) => call<{ token: string; identity: Identity }>("POST", "/auth/login", { account, nonce, signature }),
  setUsername: (username: string) => call<{ username: string }>("PUT", "/me/username", { username }),
  bounties: (q: Record<string, string>) => call<{ bounties: Bounty[]; names?: Names }>("GET", `/bounties?${new URLSearchParams(q)}`),
  bounty: (id: string) => call<Detail>("GET", `/bounties/${id}`),
  profile: (account: string) =>
    call<{ account: string; stats: Stats; identity: { kind: string; idpName: string } | null; link: string; names?: Names }>("GET", `/profiles/${account}`),
  post: (spec: unknown) => call<PreparedResponse>("POST", "/bounties", spec),
  act: (id: string, action: string, body: unknown = {}) => call<PreparedResponse>("POST", `/bounties/${id}/${action}`, body),
  observe: (txHash: string) => call<{ txHash: string; link: string; events: { type: string; id?: string }[] }>("POST", "/tx/observe", { txHash }),
  work: (id: string) => call<{ items: { workHash: string; worker: string; full: string; hashMatches: boolean }[] }>("GET", `/bounties/${id}/work`),
};
