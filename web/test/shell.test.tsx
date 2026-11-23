// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Shell } from "../src/Shell.js";

afterEach(cleanup);

const ACCOUNT = "4jKZns1aveRVjBmGrvTp9ovsptBMktCJgoZ3zC5XTRsVrqjyuF";
const shell = (over: Partial<Parameters<typeof Shell>[0]> = {}) => (
  <Shell route="board" account={null} label={null} busy={false} onConnect={() => {}} {...over}>
    <p>page</p>
  </Shell>
);

describe("Shell", () => {
  it("renders the D stamp beside the Deplace wordmark", () => {
    render(shell());
    expect(screen.getAllByText("Deplace").length).toBeGreaterThan(0);
    expect(screen.getAllByText("D").length).toBeGreaterThan(0);
    expect(screen.getByText("page")).toBeTruthy();
  });

  it('marks the current page in the nav with aria-current="page"', () => {
    render(shell({ route: "post" }));
    const current = screen.getAllByRole("link", { current: "page" });
    expect(current.length).toBeGreaterThan(0);
    for (const a of current) expect(a.getAttribute("href")).toBe("#/post");
  });

  it("offers Connect wallet when signed out, and shows who is signed in otherwise", () => {
    const onConnect = vi.fn();
    const { rerender } = render(shell({ onConnect }));
    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));
    expect(onConnect).toHaveBeenCalledOnce();

    rerender(shell({ onConnect, account: ACCOUNT, label: "Verified person" }));
    expect(screen.queryByRole("button", { name: /connect wallet/i })).toBeNull();
    expect(screen.getByText("Verified person")).toBeTruthy();
    expect(screen.getByText("4jKZns…rqjyuF")).toBeTruthy();
  });

  it("disables Connect wallet while a wallet request is running", () => {
    render(shell({ busy: true }));
    expect((screen.getByRole("button", { name: /connect wallet/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
