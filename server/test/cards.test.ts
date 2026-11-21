import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentCardRouter } from "../src/api/cards.js";

const dir = mkdtempSync(join(tmpdir(), "cards-"));
// Odd spacing and a trailing newline on purpose: any re-serialization would change the bytes.
const card = '{ "name":"worker",\n  "url" : "https://x/agents/w.json" }\n';
writeFileSync(join(dir, "bounty-worker.json"), card);

let base = "";
let close = () => {};
beforeAll(async () => {
  const app = express();
  app.use("/agents", agentCardRouter(dir));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

describe("agent cards", () => {
  it("served_bytes_sha256_equals_file_sha256", async () => {
    const res = await fetch(`${base}/agents/bounty-worker.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(sha(Buffer.from(await res.arrayBuffer()))).toBe(sha(card));
  });

  it("404s for unknown cards and refuses path tricks", async () => {
    expect((await fetch(`${base}/agents/nope.json`)).status).toBe(404);
    expect((await fetch(`${base}/agents/..%2Fsecret.json`)).status).toBe(404);
    expect((await fetch(`${base}/agents/bounty-worker.txt`)).status).toBe(404);
  });
});
