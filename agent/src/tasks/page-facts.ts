import { createHash } from "node:crypto";
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
export const pageFacts: TaskHandler = {
  kind: "page-facts",
  canHandle: (spec) => spec.taskKind === "page-facts" && urlOf(spec) !== null,
  async run(spec) {
    const url = urlOf(spec);
    if (!url) throw new Error("page-facts needs input.url (http or https)");
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
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
