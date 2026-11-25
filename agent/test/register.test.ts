import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AccountAddress, SequenceNumber, buildBasicAccountSigner } from "@concordium/web-sdk";
import { REFERENCE_AGENT_CARD, chainSubmitter, registerAgent, type BuiltTx, type RegisterOptions } from "../src/registry.js";

const OWNER = "4S3UrfhQbefa5SmR9qFsfTdVqYpSN9s4DVcmyVjTbNkoDtMxGs";
const URL_ = "https://raw.githubusercontent.com/someone/agent/main/card.json";
const CARD_JSON = '{"name":"My agent","capabilities":{"extensions":[]}}';
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const built = (receive: string): BuiltTx => ({ contract_address: { index: 12802, subindex: 0 }, receive_name: receive, parameter_hex: "00" });

interface Scenario {
  /** What agents_by_owner answers, one per call; the last answer repeats. */
  agents: unknown[][];
  /** The bytes the card URL serves. */
  served?: string;
  badgeValid?: boolean;
  /** The card file already written by an earlier run. */
  cardOnDisk?: string;
  /** An earlier run sent the register transaction. */
  registeredBefore?: string;
}

function setup(s: Scenario) {
  const dir = mkdtempSync(join(tmpdir(), "register-"));
  const calls: { name: string; args: any }[] = [];
  const submitted: string[] = [];
  const log: string[] = [];
  const file = join(dir, "card.json");
  const registeredFile = join(dir, "register-tx.txt");
  if (s.cardOnDisk !== undefined) writeFileSync(file, s.cardOnDisk);
  if (s.registeredBefore !== undefined) writeFileSync(registeredFile, s.registeredBefore + "\n");
  const answers = [...s.agents];
  const tools: Record<string, (args: any) => unknown> = {
    agents_by_owner: () => ({ agents: answers.length > 1 ? answers.shift() : answers[0] }),
    build_register: () => built("cis8004.register"),
    build_agent_card: () => ({ agent_card_json: CARD_JSON, metadata_hash_hex: sha(CARD_JSON) }),
    build_set_agent_uri: () => built("cis8004.setAgentURI"),
    token_address: () => ({ token_address: "JyP9WVTtVnRuL8JUmLKZH" }),
    check_badge: () => ({ badge_valid: s.badgeValid ?? true, issues: s.badgeValid === false ? [{ message: "card hash does not match" }] : [] }),
  };
  const o: RegisterOptions = {
    owner: OWNER,
    submit: async (tx, onSent) => {
      submitted.push(tx.receive_name);
      onSent?.("ab".repeat(32));
    },
    registry: {
      async call(name, args) {
        calls.push({ name, args });
        const tool = tools[name];
        if (!tool) throw new Error(`unexpected registry tool ${name}`);
        return tool(args) as never;
      },
    },
    fetch: (async (url: string) => {
      if (url !== URL_) throw new TypeError("fetch failed");
      return new Response(s.served ?? "", { status: s.served === undefined ? 404 : 200 });
    }) as unknown as typeof fetch,
    card: { name: "My agent", description: "Works Deplace bounties.", url: URL_, file, skills: [{ id: "deplace-bounties", name: "Deplace bounties" }] },
    registeredFile,
    registryContract: { index: 12802n, subindex: 0n },
    log: (m) => void log.push(m),
    sleep: async () => {},
  };
  return { o, calls, submitted, log, file, registeredFile };
}

const mine = (extra: Record<string, unknown> = {}) => ({ token_id: 77, agent_uri: URL_, status: "Active", ...extra });

describe("registering an agent", () => {
  it("registers once, then writes the card for the minted token and stops until it's served", async () => {
    const r = setup({ agents: [[], [mine()]] });
    const out = await registerAgent(r.o);
    expect(r.submitted).toEqual(["cis8004.register"]);
    expect(out).toEqual({ step: "card-written", file: r.file, url: URL_, tokenId: "77" });
    expect(readFileSync(r.file, "utf8")).toBe(CARD_JSON);
    expect(readFileSync(r.registeredFile, "utf8").trim()).toBe("ab".repeat(32));
    expect(r.calls.find((c) => c.name === "build_register")!.args).toMatchObject({ sender: OWNER, agent_uri: URL_ });
  });

  it("never registers twice while the registry's indexer catches up", async () => {
    const r = setup({ agents: [[]], registeredBefore: "cd".repeat(32) });
    expect(await registerAgent(r.o)).toEqual({ step: "indexer-behind", tx: "cd".repeat(32) });
    expect(r.submitted).toEqual([]);
  });

  it("pins the served card's hash and checks the badge", async () => {
    const r = setup({ agents: [[mine({ metadata_hash_hex: null })]], cardOnDisk: CARD_JSON, served: CARD_JSON });
    const out = await registerAgent(r.o);
    expect(r.submitted).toEqual(["cis8004.setAgentURI"]);
    expect(r.calls.find((c) => c.name === "build_set_agent_uri")!.args).toEqual({ token_id: "77", metadata_hash_hex: sha(CARD_JSON), sender: OWNER });
    expect(out).toEqual({ step: "badge", badge: "JyP9WVTtVnRuL8JUmLKZH", valid: true, issues: [], tokenId: "77" });
  });

  it("sends nothing when everything is in place", async () => {
    const r = setup({ agents: [[mine({ metadata_hash_hex: sha(CARD_JSON) })]], cardOnDisk: CARD_JSON, served: CARD_JSON });
    expect(await registerAgent(r.o)).toMatchObject({ step: "badge", valid: true });
    expect(r.submitted).toEqual([]);
    expect(existsSync(r.registeredFile)).toBe(false);
  });

  it("says so when the URL serves other bytes than the card", async () => {
    const r = setup({ agents: [[mine()]], cardOnDisk: CARD_JSON, served: "an older card" });
    expect(await registerAgent(r.o)).toEqual({ step: "card-not-served", url: URL_, served: sha("an older card"), expected: sha(CARD_JSON) });
    expect(r.submitted).toEqual([]);
  });

  it("reports an invalid badge with the registry's reasons", async () => {
    const r = setup({ agents: [[mine({ metadata_hash_hex: sha(CARD_JSON) })]], cardOnDisk: CARD_JSON, served: CARD_JSON, badgeValid: false });
    expect(await registerAgent(r.o)).toMatchObject({ step: "badge", valid: false, issues: ["card hash does not match"] });
  });

  it("writes the register transaction down before it leaves, so a lost answer never mints a second agent", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const privateKeyHex = privateKey.export({ format: "der", type: "pkcs8" }).subarray(16).toString("hex");
    const keys = { address: AccountAddress.fromBuffer(new Uint8Array(32).fill(1).buffer).address, privateKeyHex, signer: buildBasicAccountSigner(privateKeyHex) };
    const node = {
      getNextAccountNonce: async () => ({ nonce: SequenceNumber.create(1), allFinal: true }),
      sendTransaction: async () => {
        throw new TypeError("fetch failed"); // the answer is lost: the transaction may or may not have left
      },
    };
    const recorded: string[] = [];
    const submit = chainSubmitter(keys, { host: "unused", port: 1 }, () => {}, node as never);
    await expect(submit(built("cis8004.register"), (tx) => recorded.push(tx))).rejects.toThrow(/fetch failed/);
    expect(recorded).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
  });

  it("leaves an agent with another card alone and registers a new one", async () => {
    const elsewhere = { token_id: 3, agent_uri: "https://elsewhere.example/card.json", status: "Active" };
    const r = setup({ agents: [[elsewhere], [elsewhere, mine()]] });
    expect(await registerAgent(r.o)).toMatchObject({ step: "card-written", tokenId: "77" });
    expect(r.submitted).toEqual(["cis8004.register"]);
  });

  it("asks the registry for the reference agent's card with the same input as before", async () => {
    const r = setup({ agents: [[mine()]] });
    await registerAgent({ ...r.o, card: { ...REFERENCE_AGENT_CARD, url: URL_, file: r.file } });
    expect(r.calls.find((c) => c.name === "build_agent_card")!.args).toEqual({
      name: "Deplace reference worker",
      description: "Reference worker agent for Deplace: claims page-facts bounties, fetches the page and reports its title, visible word count and SHA-256.",
      agent_uri: URL_,
      owner_account: OWNER,
      token_id: "77",
      skills: [{ id: "page-facts", name: "Page facts", description: "Fetch a public URL and report its title, visible word count and SHA-256.", tags: ["bounty", "web"] }],
    });
  });
});

describe("finishing an agent registered without a card", () => {
  /** An agent minted by another tool that stopped before linking its card (no agent_uri on chain). */
  const unfinished = (extra: Record<string, unknown> = {}) => ({ token_id: 1501, agent_uri: null, status: "Active", metadata_hash_hex: "3d".repeat(32), agent_wallet: OWNER, ...extra });

  it("writes the card for that agent instead of registering another", async () => {
    const r = setup({ agents: [[unfinished()]] });
    expect(await registerAgent(r.o)).toEqual({ step: "card-written", file: r.file, url: URL_, tokenId: "1501" });
    expect(r.submitted).toEqual([]);
    expect(r.calls.find((c) => c.name === "build_agent_card")!.args).toMatchObject({ token_id: "1501", agent_uri: URL_, owner_account: OWNER });
    expect(r.log.join("\n")).toMatch(/finishing agent #1501/);
  });

  it("links the card's URL on chain together with its hash once the card is served", async () => {
    const r = setup({ agents: [[unfinished({ metadata_hash_hex: sha(CARD_JSON) })]], cardOnDisk: CARD_JSON, served: CARD_JSON });
    expect(await registerAgent(r.o)).toEqual({ step: "badge", badge: "JyP9WVTtVnRuL8JUmLKZH", valid: true, issues: [], tokenId: "1501" });
    expect(r.submitted).toEqual(["cis8004.setAgentURI"]);
    expect(r.calls.find((c) => c.name === "build_set_agent_uri")!.args).toEqual({ token_id: "1501", agent_uri: URL_, metadata_hash_hex: sha(CARD_JSON), sender: OWNER });
  });

  it("finishes the newest one when several have no card, and never a revoked one", async () => {
    const r = setup({
      agents: [[unfinished({ token_id: 5 }), unfinished({ token_id: 12, status: "Revoked" }), unfinished({ token_id: 9, agent_uri: "" }), unfinished({ token_id: 7 })]],
    });
    expect(await registerAgent(r.o)).toMatchObject({ step: "card-written", tokenId: "9" });
    expect(r.submitted).toEqual([]);
  });

  it("doesn't take one over while its own registration is still being indexed", async () => {
    const r = setup({ agents: [[unfinished()]], registeredBefore: "cd".repeat(32) });
    expect(await registerAgent(r.o)).toEqual({ step: "indexer-behind", tx: "cd".repeat(32) });
    expect(r.submitted).toEqual([]);
  });

  it("warns when the agent pays out to another account than this one", async () => {
    const other = "3qedXEmjY43FLLSpB8tsFAc2gZsmydxd7V6vYh1QJhDbukYVoQ";
    const r = setup({ agents: [[unfinished({ agent_wallet: other })]] });
    await registerAgent(r.o);
    expect(r.log.join("\n")).toMatch(new RegExp(`agentWallet is ${other}`));
  });
});
