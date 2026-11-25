// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const ACCOUNT = "4jKZns1aveRVjBmGrvTp9ovsptBMktCJgoZ3zC5XTRsVrqjyuF";
const OTHER = "3qedXEmjY43FLLSpB8tsFAc2gZsmydxd7V6vYh1QJhDbukYVoQ";
const ZERO = { posted: 0, paidAsPoster: 0, unpaid: 0, rejectedFinal: 0, noAward: 0, paidAsWorker: 0 };
// One session object for every render, like the real provider's stable values: a fresh
// learnNames per render would rerun the page's effect forever.
const { session } = vi.hoisted(() => ({
  session: { config: null, names: {}, learnNames: () => {}, account: null as string | null, signOut: (() => {}) as () => void },
}));
vi.mock("../src/api.js", () => ({
  api: {
    profile: vi.fn(async () => ({ stats: { posted: 0, paidAsPoster: 0, unpaid: 0, rejectedFinal: 0, noAward: 0, paidAsWorker: 0 }, identity: null, link: "https://ccdexplorer.io/testnet/account/x" })),
    bounties: vi.fn(async () => ({ bounties: [] })),
  },
}));
vi.mock("../src/session.js", () => ({ useSession: () => session }));

const { Profile } = await import("../src/pages/Profile.js");

afterEach(() => {
  cleanup();
  session.account = null;
});

describe("Profile", () => {
  it("says so when an account has no verified identity", async () => {
    render(<Profile account={ACCOUNT} />);
    expect(await screen.findByText("Identity not found")).toBeTruthy();
    expect(ZERO.posted).toBe(0);
  });

  it("lets you sign out from your own record", async () => {
    const signOut = vi.fn();
    Object.assign(session, { account: ACCOUNT, signOut });
    render(<Profile account={ACCOUNT} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(signOut).toHaveBeenCalledOnce();
  });

  it("offers no Sign out on someone else's record", async () => {
    session.account = ACCOUNT;
    render(<Profile account={OTHER} />);
    await screen.findByText("Identity not found");
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });
});
