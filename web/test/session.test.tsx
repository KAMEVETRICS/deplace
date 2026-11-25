// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/** A stand-in for Concordium Wallet for Web that records the listeners the app adds. */
const { provider, listeners } = vi.hoisted(() => {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const provider = {
    on(event: string, fn: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(fn);
      return provider;
    },
    removeListener(event: string, fn: (...args: unknown[]) => void) {
      listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
      return provider;
    },
  };
  return { provider, listeners };
});
vi.mock("../src/wallet.js", () => ({
  connectWallet: vi.fn(async () => ({ provider, account: "4jKZns1aveRVjBmGrvTp9ovsptBMktCJgoZ3zC5XTRsVrqjyuF" })),
  signChallenge: vi.fn(async () => ({ 0: { 0: "ab" } })),
  sendPrepared: vi.fn(),
}));
vi.mock("../src/api.js", () => ({
  api: {
    config: vi.fn(async () => ({ decimals: 6, rewardToken: "EUDemo" })),
    schema: vi.fn(async () => ({ type: "ModuleSchema", value: "" })),
    challenge: vi.fn(async () => ({ nonce: "n", message: "m" })),
    login: vi.fn(async () => ({ token: "t", identity: { kind: "person", label: "Verified person", account: "4jKZns1aveRVjBmGrvTp9ovsptBMktCJgoZ3zC5XTRsVrqjyuF", username: "alice" } })),
  },
  ApiError: class extends Error {},
  setToken: vi.fn(),
}));
const { SessionProvider, useSession } = await import("../src/session.js");

const ME = "4jKZns1aveRVjBmGrvTp9ovsptBMktCJgoZ3zC5XTRsVrqjyuF";
const OTHER = "3qedXEmjY43FLLSpB8tsFAc2gZsmydxd7V6vYh1QJhDbukYVoQ";

function Probe() {
  const s = useSession();
  return (
    <div>
      <p>account: {s.account ?? "none"}</p>
      <p>toast: {s.toast?.text ?? ""}</p>
      <button onClick={() => void s.connect()}>connect</button>
    </div>
  );
}

async function signedIn() {
  render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "connect" }));
  await screen.findByText(`account: ${ME}`);
}

const fire = (event: string, ...args: unknown[]) => act(() => (listeners[event] ?? []).forEach((f) => f(...args)));

afterEach(() => {
  cleanup();
  for (const k of Object.keys(listeners)) delete listeners[k];
});

describe("the session follows the wallet", () => {
  it("signs out when the wallet switches to another account, and says why", async () => {
    await signedIn();
    fire("accountChanged", OTHER);
    expect(await screen.findByText("account: none")).toBeTruthy();
    expect(screen.getByText(/switched accounts/)).toBeTruthy();
    expect(listeners.accountChanged ?? []).toHaveLength(0);
  });

  it("stays signed in when the wallet reports the same account", async () => {
    await signedIn();
    fire("accountChanged", ME);
    expect(screen.getByText(`account: ${ME}`)).toBeTruthy();
  });

  it("signs out when the wallet disconnects the site", async () => {
    await signedIn();
    fire("accountDisconnected", ME);
    expect(await screen.findByText("account: none")).toBeTruthy();
  });
});
