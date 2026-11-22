import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
});
