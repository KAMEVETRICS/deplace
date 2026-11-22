// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FeeNotice, FundingBadge, StatusPill, formatAmount } from "../src/components.js";

afterEach(cleanup);

describe("FundingBadge", () => {
  it("says the escrow is custodial", () => {
    render(<FundingBadge funding={{ type: "Escrowed", fundingTx: "ab".repeat(32) }} />);
    expect(screen.getByText("Escrowed (custodial)")).toBeTruthy();
  });

  it("marks unfunded bounties as a promise", () => {
    render(<FundingBadge funding={{ type: "NotFunded" }} />);
    expect(screen.getByText("Not funded")).toBeTruthy();
    expect(screen.getByTitle(/promise/i)).toBeTruthy();
  });
});

describe("FeeNotice", () => {
  it("shows the fee banner when the server says the fee is not sponsored", () => {
    render(<FeeNotice prepared={{ txJson: "{}", feeSponsored: false, notice: "Network fee applies: test" }} />);
    expect(screen.getByRole("alert").textContent).toMatch(/network fee applies/i);
  });

  it("shows nothing when the fee is sponsored", () => {
    const { container } = render(<FeeNotice prepared={{ txJson: "{}", feeSponsored: true }} />);
    expect(container.textContent).toBe("");
  });
});

describe("formatting", () => {
  it("formats token amounts from smallest units", () => {
    expect(formatAmount("2000000", 6)).toBe("2");
    expect(formatAmount("1500000", 6)).toBe("1.5");
    expect(formatAmount("1", 6)).toBe("0.000001");
    expect(formatAmount("0", 6)).toBe("0");
  });

  it("labels statuses in words", () => {
    render(<StatusPill status={{ type: "AcceptedUnpaid", worker: "w", workHash: "x" }} />);
    expect(screen.getByText("Accepted, unpaid")).toBeTruthy();
  });
});
