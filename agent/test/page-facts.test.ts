import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pageFacts } from "../src/tasks/page-facts.js";

const PAGE = `<!doctype html><html><head><title> Example  Domain </title><style>p{color:red}</style>
<script>var hidden = "not counted words here";</script></head>
<body><h1>Example Domain</h1><p>This domain is for use in illustrative examples.</p></body></html>`;

let server: Server;
let base = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/page") res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    else if (req.url === "/big") res.writeHead(200, { "content-type": "text/html" }).end("a ".repeat(2_000_000));
    else res.writeHead(404).end("nope");
  });
  server.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("page-facts task", () => {
  it("handles only page-facts specs with a URL", () => {
    expect(pageFacts.canHandle({ taskKind: "page-facts", input: { url: "https://example.org" } })).toBe(true);
    expect(pageFacts.canHandle({ taskKind: "translate", input: { url: "https://example.org" } })).toBe(false);
    expect(pageFacts.canHandle({ taskKind: "page-facts", input: {} })).toBe(false);
    expect(pageFacts.canHandle({ taskKind: "page-facts", input: { url: "file:///etc/passwd" } })).toBe(false);
  });

  it("reports title, visible word count and the body's SHA-256", async () => {
    const out = await pageFacts.run({ taskKind: "page-facts", input: { url: `${base}/page` } });
    const full = JSON.parse(out.full);
    expect(full).toEqual({
      url: `${base}/page`,
      status: 200,
      title: "Example Domain",
      words: 10,
      sha256: createHash("sha256").update(PAGE).digest("hex"),
    });
    expect(out.preview).toMatch(/Example Domain/);
    expect(out.preview).not.toMatch(/sha256/); // the preview does not give the work away
  });

  it("fails loudly on HTTP errors and oversized pages", async () => {
    await expect(pageFacts.run({ taskKind: "page-facts", input: { url: `${base}/missing` } })).rejects.toThrow(/404/);
    await expect(pageFacts.run({ taskKind: "page-facts", input: { url: `${base}/big` } })).rejects.toThrow(/too large/);
  });

  /** Counts fetch calls; the first `failures` of them fail before any response, as a failed DNS lookup does. */
  function flakyFetch(failures: number) {
    const real = globalThis.fetch;
    const counter = { calls: 0 };
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (...args: Parameters<typeof fetch>) => {
      counter.calls++;
      if (counter.calls <= failures) throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND example.test") });
      return real(...args);
    });
    return { counter, restore: () => spy.mockRestore() };
  }

  it("retries a fetch that failed before any response, such as a failed DNS lookup", async () => {
    const f = flakyFetch(1);
    try {
      const out = await pageFacts.run({ taskKind: "page-facts", input: { url: `${base}/page` } });
      expect(JSON.parse(out.full).title).toBe("Example Domain");
      expect(f.counter.calls).toBe(2);
    } finally {
      f.restore();
    }
  });

  it("gives up after three failed attempts, and never retries an HTTP error", async () => {
    const down = flakyFetch(99);
    try {
      await expect(pageFacts.run({ taskKind: "page-facts", input: { url: `${base}/page` } })).rejects.toThrow(/fetch failed/);
      expect(down.counter.calls).toBe(3);
    } finally {
      down.restore();
    }
    const up = flakyFetch(0);
    try {
      await expect(pageFacts.run({ taskKind: "page-facts", input: { url: `${base}/missing` } })).rejects.toThrow(/404/);
      expect(up.counter.calls).toBe(1);
    } finally {
      up.restore();
    }
  });
});
