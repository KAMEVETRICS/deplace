import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { accountLink, agentLink, instanceLink, txLink } from "../src/explorer.js";

describe("loadConfig", () => {
  it("uses testnet defaults and the fixed Agent Registry", () => {
    const cfg = loadConfig({});
    expect(cfg.grpcHost).toBe("grpc.testnet.concordium.com");
    expect(cfg.grpcPort).toBe(20000);
    expect(cfg.registry).toEqual({ index: 12802n, subindex: 0n });
    expect(cfg.rewardTokenId).toBe("EUDemo");
    expect(cfg.badgeApi).toBe("https://agent-registry-mcp.concordium.com");
    expect(cfg.contract).toBeNull();
  });

  it("reads the deployed contract instance", () => {
    const cfg = loadConfig({ CONTRACT_INDEX: "13001", CONTRACT_SUBINDEX: "0" });
    expect(cfg.contract).toEqual({ index: 13001n, subindex: 0n });
  });

  it("refuses a non-numeric contract index", () => {
    expect(() => loadConfig({ CONTRACT_INDEX: "abc" })).toThrow(/CONTRACT_INDEX/);
  });

  it("reads windows in ms", () => {
    const cfg = loadConfig({ REVIEW_WINDOW_MS: "300000", PAYMENT_WINDOW_MS: "600000" });
    expect(cfg.reviewWindowMs).toBe(300000n);
    expect(cfg.paymentWindowMs).toBe(600000n);
  });
});

describe("explorer links", () => {
  it("links a transaction", () => {
    const h = "ab".repeat(32);
    expect(txLink(h)).toBe(`https://ccdexplorer.io/testnet/transaction/${h}`);
  });

  it("refuses something that is not a tx hash", () => {
    expect(() => txLink("1234")).toThrow(/hash/);
  });

  it("links a contract instance", () => {
    expect(instanceLink(12802n, 0n)).toBe("https://ccdexplorer.io/testnet/instance/12802/0");
  });

  it("links an agent by its 8-byte little-endian token id", () => {
    expect(agentLink(0n)).toBe("https://ccdexplorer.io/testnet/token/12802/0/0000000000000000");
    expect(agentLink(258n)).toBe("https://ccdexplorer.io/testnet/token/12802/0/0201000000000000");
  });

  it("links an account", () => {
    expect(accountLink("3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8")).toBe(
      "https://ccdexplorer.io/testnet/account/3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8",
    );
  });
});
