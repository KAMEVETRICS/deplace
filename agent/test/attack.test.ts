import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pageFacts } from "../src/tasks/page-facts.js";
import type { TaskSpec } from "../src/tasks/types.js";

// A stand-in for something only the agent's machine can reach: an admin page on loopback.
let internal: Server;
let base = "";
beforeAll(async () => {
  internal = createServer((req, res) => {
    if (req.url === "/hop") {
      res.writeHead(302, { location: `${base}/admin` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><head><title>INTERNAL ADMIN PANEL</title></head><body>secret stuff</body></html>");
  });
  internal.listen(0, "127.0.0.1");
  await new Promise((r) => internal.once("listening", r));
  base = `http://127.0.0.1:${(internal.address() as AddressInfo).port}`;
});
afterAll(() => internal.close());

const spec = (url: string): TaskSpec => ({ title: "Facts", description: "", taskKind: "page-facts", input: { url }, kind: "Exclusive", reward: "1", deadline: Date.now() + 3_600_000 }) as unknown as TaskSpec;

/** Runs the task and reports whether the internal page's title came back to the poster. */
async function leaks(url: string): Promise<boolean> {
  if (!pageFacts.canHandle(spec(url))) return false;
  try {
    const out = await pageFacts.run(spec(url));
    return out.full.includes("INTERNAL ADMIN PANEL");
  } catch {
    return false;
  }
}

describe("page-facts against a poster aiming it at internal addresses", () => {
  it("won't fetch a loopback address", async () => {
    expect(await leaks(`${base}/admin`)).toBe(false);
  });

  it("won't fetch localhost by name", async () => {
    expect(await leaks(`${base.replace("127.0.0.1", "localhost")}/admin`)).toBe(false);
  });

  it("won't follow a redirect into an internal address", async () => {
    expect(await leaks(`${base}/hop`)).toBe(false);
  });

  it("won't take non-web schemes", () => {
    for (const u of ["file:///etc/passwd", "ftp://example.org/", "data:text/html,<title>x</title>", "javascript:alert(1)"]) expect(pageFacts.canHandle(spec(u)), u).toBe(false);
  });
});
