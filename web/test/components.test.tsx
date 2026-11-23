// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AccountLink, Amount, Banner, FeeNotice, FundingBadge, StatusPill, formatAmount } from "../src/components.js";

describe("AccountLink", () => {
  const address = "4jKZns1aveRVjBmGrvTp9ovsptBMktCJgoZ3zC5XTRsVrqjyuF";

  it("shows the name the board knows, linking to the account's record", () => {
    render(<AccountLink address={address} name="@alice" />);
    const a = screen.getByRole("link", { name: "@alice" });
    expect(a.getAttribute("href")).toBe(`#/p/${address}`);
    expect(a.getAttribute("title")).toBe(address);
  });

  it("names agents by their registry name", () => {
    render(<AccountLink address={address} name="Agent #1418" />);
    expect(screen.getByRole("link", { name: "Agent #1418" })).toBeTruthy();
  });

  it("falls back to the short address when the account has no name", () => {
    const { container } = render(<AccountLink address={address} />);
    expect(container.textContent).toBe("4jKZns…rqjyuF");
  });
});

afterEach(cleanup);

describe("Banner", () => {
  it("shows the message and its links, and can be dismissed", () => {
    let dismissed = false;
    render(
      <Banner kind="ok" onDismiss={() => (dismissed = true)}>
        Done. <a href="https://ccdexplorer.io/testnet/transaction/ab">View on CCDExplorer</a>
      </Banner>,
    );
    expect(screen.getByRole("status").textContent).toMatch(/Done\./);
    expect(screen.getByRole("link", { name: "View on CCDExplorer" })).toBeTruthy();
    screen.getByRole("button", { name: "Dismiss" }).click();
    expect(dismissed).toBe(true);
  });

  it("announces errors as alerts", () => {
    render(<Banner kind="err">Wallet refused</Banner>);
    expect(screen.getByRole("alert").textContent).toMatch(/Wallet refused/);
  });
});

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

  it("marks Paid as ok and a final rejection or unpaid acceptance as danger", () => {
    render(
      <>
        <StatusPill status={{ type: "Paid" }} />
        <StatusPill status={{ type: "RejectedFinal" }} />
        <StatusPill status={{ type: "AcceptedUnpaid", worker: "w", workHash: "x" }} />
        <StatusPill status={{ type: "Open" }} />
      </>,
    );
    expect(screen.getByText("Paid").classList.contains("ok")).toBe(true);
    expect(screen.getByText("Rejected (final)").classList.contains("danger")).toBe(true);
    expect(screen.getByText("Accepted, unpaid").classList.contains("danger")).toBe(true);
    expect(screen.getByText("Open").className).toBe("badge");
  });

  it("shows an amount in the token's units with the token name", () => {
    const { container } = render(<Amount units="2500000" decimals={6} token="EUDemo" />);
    expect(container.textContent).toBe("2.5 EUDemo");
    expect(container.querySelector(".price")).toBeTruthy();
  });
});
