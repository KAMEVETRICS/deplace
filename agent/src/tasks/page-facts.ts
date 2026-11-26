import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { TaskHandler, TaskSpec } from "./types.js";

const MAX_BYTES = 2 * 1024 * 1024;

function urlOf(spec: TaskSpec): URL | null {
  const raw = spec.input?.url;
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

async function readLimited(res: Response): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error(`page is too large (over ${MAX_BYTES} bytes)`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Pauses before the 2nd and 3rd attempt. */
const RETRY_DELAYS_MS = [1_000, 2_000];

/**
 * Fetches one URL, retrying only when fetch fails before any response (a TypeError, such as a
 * failed DNS lookup or a refused connection). HTTP errors and timeouts are not retried.
 * Redirects come back as responses, so the caller can check each hop.
 */
async function fetchOnce(url: URL): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "manual" });
    } catch (e) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (!(e instanceof TypeError) || delay === undefined) throw e;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Addresses a poster must not be able to reach through the agent: its own machine, its network, cloud metadata. */
const INTERNAL = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) INTERNAL.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) INTERNAL.addSubnet(net, bits, "ipv6");

/** Whether an IP address is on the public internet: not loopback, private, link-local, CGNAT, multicast or reserved. */
export function isPublicAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return isPublicAddress(mapped);
  const family = isIP(ip);
  if (family === 4) return !INTERNAL.check(ip, "ipv4");
  if (family === 6) return !INTERNAL.check(ip, "ipv6");
  return false;
}

export interface PageFactsOptions {
  /** Which resolved addresses the agent may fetch from; public addresses only, unless a test says otherwise. */
  allowAddress?: (ip: string) => boolean;
}

const MAX_REDIRECTS = 5;

/**
 * Fetches a page the way a poster can't abuse: every hop's host must resolve only to addresses
 * the agent may reach, and redirects are followed by hand so each one is checked too. (A host
 * that changes its DNS answer between the check and the fetch can still slip through; this is a
 * demo agent, and its results are only a title, a word count and a hash.)
 */
async function fetchPage(start: URL, allowAddress: (ip: string) => boolean): Promise<{ res: Response; url: URL }> {
  let url = start;
  for (let hop = 0; ; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
    const blocked = addresses.find((a) => !allowAddress(a));
    if (addresses.length === 0 || blocked) throw new Error(`page-facts won't fetch ${host}: it resolves to ${blocked ?? "nothing"}, which is not a public address`);
    const res = await fetchOnce(url);
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return { res, url };
    if (hop >= MAX_REDIRECTS) throw new Error(`GET ${start} redirected more than ${MAX_REDIRECTS} times`);
    const next = new URL(location, url);
    if (next.protocol !== "https:" && next.protocol !== "http:") throw new Error(`GET ${url} redirected to a ${next.protocol} URL`);
    url = next;
  }
}

function visibleWords(html: string): number {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ");
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Deterministic demo task: fetch a public page and report its title, visible word
 * count and the SHA-256 of the body, so a poster can check the result automatically.
 */
export function makePageFacts(o: PageFactsOptions = {}): TaskHandler {
  const allowAddress = o.allowAddress ?? isPublicAddress;
  return {
    kind: "page-facts",
    canHandle: (spec) => spec.taskKind === "page-facts" && urlOf(spec) !== null,
    async run(spec) {
      const url = urlOf(spec);
      if (!url) throw new Error("page-facts needs input.url (http or https)");
      const { res } = await fetchPage(url, allowAddress);
      if (!res.ok) throw new Error(`GET ${url} answered HTTP ${res.status}`);
      const body = await readLimited(res);
      const html = body.toString("utf8");
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
      const facts = { url: url.toString(), status: res.status, title, words: visibleWords(html), sha256: createHash("sha256").update(body).digest("hex") };
      return {
        preview: `Fetched ${facts.url}: title "${facts.title}", ${facts.words} words. Full result (with the page hash) on acceptance.`,
        full: JSON.stringify(facts),
      };
    },
  };
}

/** The task as the reference agent runs it: public addresses only. */
export const pageFacts: TaskHandler = makePageFacts();
