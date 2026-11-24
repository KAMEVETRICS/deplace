import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadKitSettings } from "../src/kit/settings.js";

describe("the kit's settings", () => {
  it("uses the live board's defaults", () => {
    const s = loadKitSettings({ AGENT_KEY_FILE: "k.export", AGENT_BADGE: "b" }, "C:\\repo");
    expect(s).toMatchObject({
      badge: "b",
      boardMcpUrl: "https://deplace.space/mcp",
      contract: { index: 13123n, subindex: 0n },
      registry: { index: 12802n, subindex: 0n },
      allowFees: false,
      maxEnergy: 30_000n,
      maxReward: "5",
      dailyBudget: "20",
      grpcHost: "grpc.testnet.concordium.com",
      grpcPort: 20000,
      rewardTokenId: "EUDemo",
    });
    expect(s.pendingFile).toBe(join("C:\\repo", "data", "agent-pending.json"));
    expect(s.budgetFile).toBe(join("C:\\repo", "data", "agent-budget.json"));
    expect(s.card).toEqual({ name: null, description: null, url: null, file: join("C:\\repo", "data", "agent-card.json"), skills: null });
  });

  it.runIf(process.platform === "win32")("resolves Windows key paths with backslashes, spaces or relative to the repo", () => {
    expect(loadKitSettings({ AGENT_KEY_FILE: "secrets\\worker-agent.export" }, "C:\\repo").keyFile).toBe(join("C:\\repo", "secrets", "worker-agent.export"));
    expect(loadKitSettings({ AGENT_KEY_FILE: "C:\\Users\\Some One\\agent.export" }, "C:\\repo").keyFile).toBe("C:\\Users\\Some One\\agent.export");
    expect(loadKitSettings({ AGENT_KEY_FILE: "  C:/Users/Some One/agent.export  " }, "C:\\repo").keyFile).toBe(join("C:/Users/Some One/agent.export"));
  });

  it.runIf(process.platform !== "win32")("resolves key paths with spaces or relative to the repo", () => {
    expect(loadKitSettings({ AGENT_KEY_FILE: "secrets/worker-agent.export" }, "/repo").keyFile).toBe("/repo/secrets/worker-agent.export");
    expect(loadKitSettings({ AGENT_KEY_FILE: "  /home/some one/agent.export  " }, "/repo").keyFile).toBe("/home/some one/agent.export");
  });

  it("takes the board, contract, caps and card from the environment", () => {
    const s = loadKitSettings(
      {
        AGENT_KEY_FILE: "k",
        BOARD_MCP_URL: "http://localhost:8787/mcp",
        CONTRACT_INDEX: "13124",
        AGENT_ALLOW_FEES: "true",
        AGENT_MAX_REWARD: "2.5",
        AGENT_DAILY_BUDGET: "10",
        AGENT_NAME: "My agent",
        AGENT_DESCRIPTION: "Does page facts",
        AGENT_CARD_URL: "https://example.org/card.json",
        AGENT_SKILLS: '[{"id":"page-facts","name":"Page facts"}]',
      },
      "C:\\repo",
    );
    expect(s).toMatchObject({ boardMcpUrl: "http://localhost:8787/mcp", contract: { index: 13124n, subindex: 0n }, allowFees: true, maxReward: "2.5", dailyBudget: "10" });
    expect(s.card).toMatchObject({ name: "My agent", description: "Does page facts", url: "https://example.org/card.json", skills: [{ id: "page-facts", name: "Page facts" }] });
  });

  it("refuses settings it can't read, naming them", () => {
    expect(() => loadKitSettings({}, "C:\\repo")).toThrow(/AGENT_KEY_FILE/);
    expect(() => loadKitSettings({ AGENT_KEY_FILE: "k", AGENT_ALLOW_FEES: "yes" }, "C:\\repo")).toThrow(/AGENT_ALLOW_FEES/);
    expect(() => loadKitSettings({ AGENT_KEY_FILE: "k", CONTRACT_INDEX: "abc" }, "C:\\repo")).toThrow(/CONTRACT_INDEX/);
    expect(() => loadKitSettings({ AGENT_KEY_FILE: "k", GRPC_PORT: "20000x" }, "C:\\repo")).toThrow(/GRPC_PORT/);
    expect(() => loadKitSettings({ AGENT_KEY_FILE: "k", BOARD_MCP_URL: "not a url" }, "C:\\repo")).toThrow(/BOARD_MCP_URL/);
    expect(() => loadKitSettings({ AGENT_KEY_FILE: "k", AGENT_MAX_REWARD: "lots" }, "C:\\repo")).toThrow(/AGENT_MAX_REWARD/);
    expect(() => loadKitSettings({ AGENT_KEY_FILE: "k", AGENT_SKILLS: '{"id":"x"}' }, "C:\\repo")).toThrow(/AGENT_SKILLS/);
  });
});
