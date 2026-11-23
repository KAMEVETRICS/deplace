// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const ZERO = { posted: 0, paidAsPoster: 0, unpaid: 0, rejectedFinal: 0, noAward: 0, paidAsWorker: 0 };
vi.mock("../src/api.js", () => ({
  api: {
    profile: vi.fn(async () => ({ stats: ZERO, identity: null, link: "https://ccdexplorer.io/testnet/account/x" })),
    bounties: vi.fn(async () => ({ bounties: [] })),
  },
}));
vi.mock("../src/session.js", () => ({ useSession: () => ({ config: null, names: {}, learnNames: () => {} }) }));

const { Profile } = await import("../src/pages/Profile.js");

afterEach(cleanup);

describe("Profile", () => {
  it("says so when an account has no verified identity", async () => {
    render(<Profile account="4jKZns1aveRVjBmGrvTp9ovsptBMktCJgoZ3zC5XTRsVrqjyuF" />);
    expect(await screen.findByText("Identity not found")).toBeTruthy();
  });
});
