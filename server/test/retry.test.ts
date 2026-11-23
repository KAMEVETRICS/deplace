import { describe, expect, it } from "vitest";
import { isTransient, retrying } from "../src/chain/grpc.js";

// The error the board crashed on at startup: grpc-js could not resolve the testnet node.
const dns = Object.assign(new Error("Name resolution failed for target dns:grpc.testnet.concordium.com:20000"), { code: "UNAVAILABLE" });
const quiet = { log: () => {} };

describe("startup retries", () => {
  it("retries a failed DNS lookup until the node answers, waiting a little longer each time", async () => {
    let calls = 0;
    const waits: number[] = [];
    const value = await retrying(
      "reading the reward token",
      async () => {
        if (++calls < 3) throw dns;
        return 6;
      },
      { ...quiet, sleep: async (ms) => void waits.push(ms) },
    );
    expect(value).toBe(6);
    expect(calls).toBe(3);
    expect(waits).toEqual([2_000, 4_000]);
  });

  it("gives up after the last attempt with the node's own error", async () => {
    let calls = 0;
    const failing = retrying(
      "reading the contract config",
      async () => {
        calls++;
        throw dns;
      },
      { ...quiet, attempts: 4, sleep: async () => {} },
    );
    await expect(failing).rejects.toBe(dns);
    expect(calls).toBe(4);
  });

  it("does not retry an error that waiting will not fix", async () => {
    let calls = 0;
    const mismatch = new Error("attestor key mismatch");
    const failing = retrying(
      "reading the contract config",
      async () => {
        calls++;
        throw mismatch;
      },
      { ...quiet, sleep: async () => {} },
    );
    await expect(failing).rejects.toBe(mismatch);
    expect(calls).toBe(1);
  });

  it("recognises the node's transient failures and nothing else", () => {
    expect(isTransient(dns)).toBe(true);
    expect(isTransient({ code: 14 })).toBe(true);
    expect(isTransient({ code: "DEADLINE_EXCEEDED" })).toBe(true);
    expect(isTransient(new Error("getaddrinfo ENOTFOUND grpc.testnet.concordium.com"))).toBe(true);
    expect(isTransient({ code: "NOT_FOUND", message: "account not found" })).toBe(false);
    expect(isTransient(new Error("deplace.view_config rejected: Unauthorized"))).toBe(false);
  });
});
