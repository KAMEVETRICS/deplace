import { describe, expect, it } from "vitest";
import { untilLoaded } from "../src/retry.js";

describe("loading what the app needs from the board", () => {
  it("keeps trying until the board answers, waiting longer after each failure", async () => {
    let calls = 0;
    const waits: number[] = [];
    const failures: number[] = [];
    const value = await untilLoaded(
      async () => {
        if (++calls < 3) throw new Error("Failed to fetch");
        return { rewardToken: "EUDemo" };
      },
      { signal: new AbortController().signal, onError: (_e, attempt) => failures.push(attempt), sleep: async (ms) => void waits.push(ms) },
    );
    expect(value).toEqual({ rewardToken: "EUDemo" });
    expect(calls).toBe(3);
    expect(failures).toEqual([1, 2]);
    expect(waits).toEqual([2_000, 4_000]);
  });

  it("never waits more than 30 s between tries", async () => {
    let calls = 0;
    const waits: number[] = [];
    await untilLoaded(
      async () => {
        if (++calls < 8) throw new Error("board down");
        return 1;
      },
      { signal: new AbortController().signal, sleep: async (ms) => void waits.push(ms) },
    );
    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });

  it("stops trying once the page is gone", async () => {
    const page = new AbortController();
    let calls = 0;
    const result = await untilLoaded(
      async () => {
        calls++;
        throw new Error("board down");
      },
      { signal: page.signal, sleep: async () => page.abort() },
    );
    expect(result).toBeUndefined();
    expect(calls).toBe(1);
  });
});
