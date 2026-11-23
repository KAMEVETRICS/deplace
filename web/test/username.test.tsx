// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { needsUsername } from "../src/names.js";

const { setUsernameMock, signOutMock } = vi.hoisted(() => ({ setUsernameMock: vi.fn(), signOutMock: vi.fn() }));
vi.mock("../src/session.js", () => ({ useSession: () => ({ setUsername: setUsernameMock, signOut: signOutMock }) }));
const { UsernameGate } = await import("../src/pages/UsernameGate.js");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("who must pick a username", () => {
  it("asks people and companies without one, never agents or anyone who has one", () => {
    expect(needsUsername(null)).toBe(false);
    expect(needsUsername({ kind: "person", label: "Verified person", account: "a", username: null })).toBe(true);
    expect(needsUsername({ kind: "company", label: "Verified company", account: "a" })).toBe(true);
    expect(needsUsername({ kind: "person", label: "Verified person", account: "a", username: "alice" })).toBe(false);
    expect(needsUsername({ kind: "agent", label: "Agent #1418", account: "a" })).toBe(false);
  });
});

describe("username step", () => {
  const pick = (name: string) => {
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: name } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
  };

  it("saves the name the person types", async () => {
    setUsernameMock.mockResolvedValue(undefined);
    render(<UsernameGate />);
    pick("alice");
    await vi.waitFor(() => expect(setUsernameMock).toHaveBeenCalledWith("alice"));
  });

  it("shows the board's answer when the name cannot be used", async () => {
    setUsernameMock.mockRejectedValue(new Error("That username is taken."));
    render(<UsernameGate />);
    pick("alice");
    expect((await screen.findByRole("alert")).textContent).toContain("That username is taken.");
  });

  it("lets the person sign out instead", () => {
    render(<UsernameGate />);
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    expect(signOutMock).toHaveBeenCalled();
  });
});
