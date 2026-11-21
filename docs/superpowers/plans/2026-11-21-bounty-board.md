# Bounty Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bounty board on Concordium testnet. Verified people, companies and badge-holding agents post Exclusive or Contest bounties, either escrowed or not funded, in EUDemo. Verified workers claim and submit. Every step is a `bounty_board` contract event. Payouts go from escrow or through x402 pay-on-delivery, and fees are sponsored.

**Architecture:**
- A Rust contract is the state machine and the audit trail.
- A Node server holds the operator/escrow, sponsor and attestor keys. It runs:
  - identity and badge checks;
  - sponsor co-signing;
  - an x402 settlement service;
  - an escrow worker;
  - an event indexer;
  - REST for the web app and MCP for agents.
- A React web app serves posters and human workers.
- A reference Node agent works bounties over MCP.

**Tech Stack:**
- Contract: Rust 1.85, `wasm32v1-none`, cargo-concordium 5.0.0, concordium-std 11.0.0, concordium-smart-contract-testing, concordium-client 10.0.0.
- Server and agent: Node 24 (installed: v24.19.0), TypeScript ESM, `@concordium/web-sdk` 12.0.3, Fastify 5, `node:sqlite`, `@modelcontextprotocol/sdk`, `@x402/concordium` 2.32.0, vitest.
- Web: React 18.3.1, Vite, `@concordium/wallet-connectors` 0.9.0, `@concordium/react-components` 0.8.0 (pinned; `latest` is an alpha).

**Spec:** `docs/superpowers/specs/2026-11-21-bounty-board-design.md` (read it with this plan).

## Global Constraints

- Network is testnet only. gRPC `grpc.testnet.concordium.com:20000` **with TLS** (`credentials.createSsl()` in Node; `ConcordiumGRPCWebClient("https://grpc.testnet.concordium.com", 20000)` in the browser). Never copy the SDK examples' `createInsecure()`.
- Genesis hash `4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796`; CAIP-2 `ccd:4221332d34e1694168c2a0c0b3fd0f27`.
- Agent Registry CIS-8004 `<12802,0>`; agent token ids are 8-byte little-endian u64.
- Hosted registry REST `https://agent-registry-mcp.concordium.com/v1/check-badge/{badge}`. **Always add `?network=testnet`.** Handle 400/404/409/429.
- Reward token `EUDemo` (token id from config `REWARD_TOKEN_ID`). Read decimals from chain; never hard-code them.
- Sponsor only contract **updates** and PLT **transfers**. Deploy and init are unsponsored (sponsored init fails on testnet).
- Fee fallback is never silent: any path where the user pays CCD must say "network fee applies" in the UI and the MCP response.
- Secrets live only in `secrets/` (gitignored) and `.env` (gitignored). `.env.example` lists every variable.
- Explorer links: `https://ccdexplorer.io/testnet/transaction/<hash>`, `.../testnet/instance/<i>/<s>`, `.../testnet/token/12802/0/<tokenIdHex>`.
- The UI and docs must call the escrow **custodial** and say Protocol-Level Locks will replace it.
- Attestation messages are domain-separated and bound to the contract address (format in Task 3).

## Review Focus

1. **A copied badge or the wrong signer.** A claim for agent X signed by an account other than X's `agentWallet` (or owner, if no wallet is set) must be refused, even when the badge check passes. Test in Task 9.
2. **Bad funding transfers.** An escrow deposit with the wrong amount, a wrong or missing memo, or a second deposit for an already-escrowed bounty must not trigger `confirm_funding`. It is logged as "unmatched deposit, manual refund". Test in Task 12.
3. **Escrow worker restarted mid-payout.** It must not pay twice. Before sending, it checks the escrow account's history for an existing transfer with memo `bounty:<id>` to that recipient. Test in Task 12.
4. **Hosted badge API down or rate-limited (429, timeout).** The claim is refused with a "badge service unavailable, retry after N s" message. It must never pass and never crash. Test in Task 9.
5. **Payout account not on the EUDemo allow list.** A claim or entry is refused up front with the faucet link. If removal happens later, a failed payout leaves the bounty `Accepted`, retries with backoff and surfaces in `/admin/health`, and is never recorded as paid. Tests in Tasks 9 and 12.

---

## File structure

```
contracts/bounty-board/        Rust contract crate (src/lib.rs, src/state.rs, src/attest.rs, tests/*.rs)
contracts/mock-registry/       minimal CIS-8004 view mock for tests (getAgentWallet, agentOf)
packages/shared/               TS: config, explorer links, attestation encoding, contract param types
server/src/chain/              grpc client, contract client, PLT helpers
server/src/identity/           challenges, account login, badge verification, allow-list check, attestor
server/src/sponsor/            build + co-sign policy, rate limits
server/src/x402/               facilitator, paywalled routes
server/src/escrow/             escrow worker, audit
server/src/indexer/            event follower -> sqlite
server/src/api/                Fastify REST routes
server/src/mcp/                MCP server + tools
server/public/agents/          hosted Agent Cards (served byte-exact)
agent/                         reference worker agent
web/                           React app
spikes/                        day-1 risk scripts (kept as reference)
scripts/                       deploy, e2e, audit
```

An npm workspace root (`package.json` with workspaces `packages/*`, `server`, `agent`, `web`). There is one `tsconfig.base.json` (`module`/`moduleResolution` `nodenext`, strict).

---

### Task 0: Toolchain, repo skeleton, testnet accounts

**Files:** Create `package.json`, `tsconfig.base.json`, `.gitignore` (`node_modules`, `target`, `secrets/`, `.env`, `*.db`), `.env.example`, `README.md` (stub), `docs/setup-accounts.md`.

- [ ] **Step 1:** Install rustup with Rust 1.85 and add the target: `rustup target add wasm32v1-none`. Install `cargo install --locked cargo-concordium@5.0.0`. Download concordium-client 10.0.0 for Windows from the GitHub releases page and put it on PATH. Verify that `cargo concordium --version` and `concordium-client --version` print 5.0.0 and 10.0.0.
- [ ] **Step 2:** Create the workspace skeleton and run `npm install`. Expected: no errors.
- [ ] **Step 3 [USER]:** Write `docs/setup-accounts.md` and have the user follow it. They install Concordium Wallet for Web, switch to Testnet, and create an identity with "Concordium testnet IP" and an **EU nationality**. They then create 4 accounts: `sponsor`, `operator` (also the escrow), `poster`, and `worker-agent`, and claim faucet CCD on each before it receives anything. On the EUDemo faucet they claim with `operator`, `poster` and `worker-agent`, so all three land on the allow list. Finally they export each account's key file into `secrets/<name>.export`. The user types every password; the agent never does.
- [ ] **Step 4:** Commit: `chore: workspace skeleton and setup docs`.

### Task 1: Day-1 risk spikes

**Files:** Create `spikes/01-sponsored-plt-transfer.ts`, `spikes/02-sponsored-contract-update.ts`, `spikes/03-register-agent.ts`, `spikes/04-x402-payment.ts`, `spikes/RESULTS.md`.

Each spike runs with `npx tsx spikes/<file>` and prints the tx hash and explorer link. `RESULTS.md` records pass or fail, the exact web-sdk calls that worked, and any errors. Later tasks copy the working call shapes from it.

- [ ] **Step 1:** `01`: `poster` sends 1 EUDemo to `worker-agent` with memo `spike:1`. `sponsor` co-signs as fee payer. Expected: success, and the explorer shows the sender's cost as 0.
- [ ] **Step 2:** `02`: a sponsored update of an existing contract by `worker-agent`. Use CIS-8004 `<12802,0>` `setMetadata` on the agent from step 3, or run step 3 first. Expected: success.
- [ ] **Step 3:** `03`: serve `server/public/agents/bounty-worker.json` locally and through a public tunnel or host (the URL must be public for the badge check). Compute its SHA-256 over the exact served bytes. Call the hosted MCP `build_register` (`network: "testnet"`, `agent_uri`, `metadata_hash`), sign as `worker-agent`, submit, then run `build_agent_badge` and `build_set_agent_uri` as the tool docs say. Then `GET /v1/check-badge/<badge>?network=testnet`. Expected: valid. Record the badge and token id in `RESULTS.md`.
- [ ] **Step 4:** `04`: a minimal x402 resource server and facilitator from `@x402/concordium` (`exact`, asset `EUDemo`, `extra.feePayer` = sponsor). A Node client paying from `poster` to `worker-agent`. Expected: 200 with content and a settlement tx hash.
- [ ] **Step 5:** Fill in `RESULTS.md`, including the go/no-go for "browser wallet signs an x402 payload", which is tested in Task 17. Commit: `spike: day-1 testnet risk checks`.

**Gate:** if step 1 or 2 fails, stop and report to the user before Task 7. The fee-fallback design depends on it.

### Task 2: Shared package

**Files:** Create `packages/shared/src/config.ts`, `explorer.ts`, `attest.ts`, `types.ts`, `index.ts`, plus tests `packages/shared/test/attest.test.ts`.

**Interfaces (produces):**
- `loadConfig(env): Config` with `grpcHost`, `grpcPort`, `contract: {index: bigint, subindex: bigint}`, `registry: {index: 12802n, subindex: 0n}`, `rewardTokenId`, `badgeApi`, `publicBaseUrl`, and windows in ms.
- `txLink(hash: string): string`, `instanceLink(i: bigint, s: bigint): string`, `agentLink(tokenId: bigint): string`.
- `postAttestationBytes(a: PostAttestation): Uint8Array`, `workAttestationBytes(a: WorkAttestation): Uint8Array`.
- Types:
  - `PostAttestation {contract, poster: string (base58), specHash: Uint8Array(32), expiry: bigint ms}`
  - `WorkAttestation {kind: "claim"|"enter", contract, bountyId: bigint, worker: string, agent: bigint | null, expiry: bigint}`
- `Bounty`, `BountyStatus` and `BountyKind` TS types mirroring Task 3.

- [ ] **Step 1:** Write `attest.test.ts`. It encodes a fixed `PostAttestation` and a fixed `WorkAttestation` and asserts the hex equals golden vectors. Task 3 generates those same vectors from Rust and pastes them into both test suites.
- [ ] **Step 2:** Implement the encoding as `domain || concordium-serial(struct)`:
  - `domain` is the ASCII `"BountyBoard/v1/post"` or `"BountyBoard/v1/claim"` / `"BountyBoard/v1/enter"`, **not** length-prefixed.
  - Struct serialisation uses Concordium binary rules: ContractAddress is u64 LE index followed by u64 LE subindex; AccountAddress is 32 raw bytes; Option is tag byte 0/1 then the value; Timestamp is u64 LE ms; bountyId is u64 LE; agent is `Option<u64 LE>`.
- [ ] **Step 3:** Run `npm test -w packages/shared` and confirm it passes. Commit.

### Task 3: Contract core (init, post, cancel, admin, views)

**Files:** Create `contracts/bounty-board/Cargo.toml`, `src/lib.rs`, `src/state.rs`, `src/attest.rs`, `tests/core.rs`.

**State:**
```rust
struct State<S> {
  admin: AccountAddress, operator: AccountAddress, attestor: PublicKeyEd25519,
  registry: ContractAddress, reward_token: String,
  review_window_ms: u64, payment_window_ms: u64,
  next_id: u64,
  bounties: StateMap<u64, Bounty, S>,
  entries: StateMap<(u64, u32), Entry, S>,
  stats: StateMap<AccountAddress, Stats, S>,
}
enum Kind { Exclusive, Contest }
enum Funding { NotFunded, Escrowed { funding_tx: [u8;32] } }
struct Bounty { poster: AccountAddress, poster_agent: Option<u64>, kind: Kind, spec_hash: [u8;32],
  reward: u64, funding: Funding, deadline: Timestamp, status: Status, rejections: u8, entry_count: u32, created: Timestamp }
enum Status {
  Open, Claimed { worker: AccountAddress, agent: Option<u64> },
  Submitted { worker: AccountAddress, agent: Option<u64>, work_hash: [u8;32], at: Timestamp },
  Accepted { worker: AccountAddress, at: Timestamp },
  Awarded { entry_id: u32, at: Timestamp }, Splitting { at: Timestamp },
  Paid, AcceptedUnpaid, RejectedFinal, NoAward, Expired, Cancelled, Refunded
}
struct Entry { worker: AccountAddress, agent: Option<u64>, work_hash: [u8;32], at: Timestamp }
struct Stats { posted: u32, paid_as_poster: u32, unpaid: u32, rejected_final: u32, no_award: u32, paid_as_worker: u32 }
```

**Entrypoints in this task:**
- `init(InitParams{admin, operator, attestor, registry, reward_token, review_window_ms, payment_window_ms})`
- `post(PostParams{kind, poster_agent: Option<u64>, spec_hash, reward, deadline, attestation_expiry, signature: SignatureEd25519})`. The sender is the poster. Verify ed25519 over `postAttestationBytes` (same layout as Task 2). Reject if `slot_time > attestation_expiry`, `deadline <= slot_time`, or `reward == 0`. Returns the id and increments `stats.posted`.
- `cancel(id)`: poster only, status `Open`, and for Exclusive no claim; for a Contest, `entry_count == 0`. Moves to `Cancelled`.
- `set_attestor(PublicKeyEd25519)`, `set_operator(AccountAddress)`, `set_admin(AccountAddress)`: admin only.
- Views: `view_bounty(u64) -> Option<BountyView>`, `view_entry((u64,u32)) -> Option<Entry>`, `view_stats(AccountAddress) -> Stats`, `view_config() -> ConfigView`.

**Events** (one enum, `#[concordium(repr(u8))]`), introduced across Tasks 3–5: `Posted{id, poster, poster_agent, kind, reward, spec_hash, deadline}`, `Funded{id, tx}`, `Claimed{id, worker, agent}`, `Submitted{id, worker, work_hash}`, `Entered{id, entry_id, worker, agent, work_hash}`, `Accepted{id, worker, auto: bool}`, `Rejected{id, count, reason_hash}`, `RejectedFinal{id}`, `Awarded{id, entry_id, worker}`, `SplitStarted{id, entries}`, `PayoutRecorded{id, to, amount, tx}`, `RefundRecorded{id, tx}`, `MarkedUnpaid{id}`, `NoAward{id}`, `Expired{id}`, `Cancelled{id}`, `AdminChanged{what: u8}`.

**Errors:** `Unauthorized`, `BadSignature`, `AttestationExpired`, `WrongStatus`, `DeadlinePassed`, `DeadlineNotPassed`, `WindowNotPassed`, `InvalidParams`, `NotFound`, `AlreadyEntered`, `RegistryCheckFailed`, `ParseError`, `LogFull`.

- [ ] **Step 1:** Write `tests/core.rs` with concordium-smart-contract-testing. Tests:
  - `post_with_valid_attestation_creates_open_bounty` (event `Posted`, stats.posted == 1);
  - `post_rejects_bad_signature`, `post_rejects_expired_attestation`, `post_rejects_signature_for_other_contract`, `post_rejects_zero_reward`;
  - `cancel_only_poster_only_open`;
  - `set_attestor_admin_only`, and after rotation the old key fails while the new key passes.

  Generate the golden vectors with a small `#[test] fn print_vectors()` and paste them into `packages/shared/test/attest.test.ts`.
- [ ] **Step 2:** Run `cargo concordium test --out concordium-out/module.wasm.v1` and confirm the tests fail.
- [ ] **Step 3:** Implement. Verify signatures with `crypto_primitives.verify_ed25519_signature`.
- [ ] **Step 4:** Run the tests and confirm they pass, then run `npm test -w packages/shared` and confirm the vectors match. Commit: `feat(contract): core state, post, cancel, admin`.

### Task 4: Contract Exclusive flow, funding and payouts

**Files:** Modify `contracts/bounty-board/src/lib.rs`. Create `tests/exclusive.rs`.

**Entrypoints:**

| Entrypoint | Caller | From → To | Notes |
|---|---|---|---|
| `confirm_funding{id, tx}` | operator | Funding `NotFunded` → `Escrowed` | Status must be `Open` or `Claimed` |
| `claim{id, agent: Option<u64>, attestation_expiry, signature}` | worker | `Open` → `Claimed` | Attestation over `workAttestationBytes(kind=claim)`; before `deadline`; worker ≠ poster |
| `submit{id, work_hash}` | claimed worker | `Claimed` → `Submitted` | Before `deadline` |
| `accept(id)` | poster | `Submitted` → `Accepted` | |
| `reject{id, reason_hash}` | poster | `Submitted` → `Claimed` (rejections+1), or `RejectedFinal` on the 3rd | `RejectedFinal` increments `stats.rejected_final` |
| `auto_accept(id)` | anyone | `Submitted` → `Accepted{auto}` | Escrowed only; `slot_time >= at + review_window_ms` |
| `expire(id)` | anyone | `Open` or `Claimed` → `Expired` | `slot_time > deadline` |
| `mark_unpaid(id)` | anyone | `Accepted` → `AcceptedUnpaid` | NotFunded only; `slot_time >= accepted_at + payment_window_ms`; stats.unpaid+1 |
| `record_payout{id, payouts: Vec<{to, amount, tx}>}` | operator | `Accepted`, `AcceptedUnpaid`, `Awarded` or `Splitting` → `Paid` | Exclusive: exactly one payout, to = worker, amount ≥ reward. Increments the poster's `paid_as_poster` and the worker's `paid_as_worker`. `AcceptedUnpaid` → `Paid` lets late payment clear the state while the `unpaid` counter stays. |
| `record_refund{id, tx}` | operator | `Cancelled`, `Expired`, `RejectedFinal` or `NoAward`(escrowed) → `Refunded` | Escrowed only |

- [ ] **Step 1:** Write `tests/exclusive.rs`:
  - `happy_path_escrowed`: post → confirm_funding → claim → submit → accept → record_payout gives `Paid`, and the stats are updated;
  - `happy_path_not_funded`;
  - `claim_rejects_foreign_attestation_worker` (attestation for A, sender B);
  - `claim_after_deadline_fails`;
  - `submit_by_non_worker_fails`;
  - `three_rejections_finalise`: rejects 1 and 2 return to `Claimed`, reject 3 gives `RejectedFinal` with stats.rejected_final == 1;
  - `auto_accept_requires_escrow_and_window`;
  - `mark_unpaid_requires_not_funded_and_window`;
  - `record_payout_wrong_recipient_fails`;
  - `record_refund_only_escrowed`;
  - `operator_only_entrypoints_reject_others`.

  Set time with `chain.tick_block_time`.
- [ ] **Step 2:** Run the tests and confirm they fail. **Step 3:** Implement. **Step 4:** Run the tests and confirm they pass. **Step 5:** Commit: `feat(contract): exclusive flow, funding, payouts`.

### Task 5: Contract Contest flow

**Files:** Modify `src/lib.rs`. Create `tests/contest.rs`.

| Entrypoint | Caller | Effect |
|---|---|---|
| `enter{id, agent, work_hash, attestation_expiry, signature}` | worker | Kind Contest, `Open`, before `deadline`, worker ≠ poster, one entry per worker (`AlreadyEntered`). Stores `Entry`, `entry_id = entry_count`, emits `Entered`. |
| `award{id, entry_id}` | poster | After `deadline`, before `deadline + review_window_ms` → `Awarded`. |
| `split_unawarded(id)` | anyone | Escrowed, `Open`, entries > 0, `slot_time >= deadline + review_window_ms` → `Splitting`. Payout is `reward / n` each, and the remainder goes to entry 0 (earliest). |
| `no_award(id)` | anyone | NotFunded, same timing → `NoAward`, stats.no_award+1. |
| `expire(id)` | anyone | Extended: Contest with 0 entries after `deadline` → `Expired`. |
| `record_payout` | operator | Extended: `Awarded` needs one payout to the winner's worker for ≥ reward. `Splitting` needs exactly n payouts matching the split amounts per entry worker. |

- [ ] **Step 1:** Write tests:
  - `contest_award_happy_path`;
  - `enter_twice_same_worker_fails`;
  - `award_before_deadline_fails`;
  - `split_unawarded_amounts`: reward 100 with 3 entries gives 34/33/33, the 34 going to entry 0;
  - `split_requires_escrow`;
  - `no_award_requires_not_funded_and_increments_stats`;
  - `contest_zero_entries_expires`;
  - `record_payout_split_mismatch_fails`.
- [ ] **Step 2–4:** Run the tests and confirm they fail, implement, then run them again and confirm they pass. **Step 5:** Commit: `feat(contract): contest flow`.

### Task 6: Registry cross-check (optional hardening)

**Files:** Create `contracts/mock-registry/` (entrypoints `getAgentWallet(u64) -> Option<AccountAddress>` and `agentOf(u64) -> AgentRecordView`, with shapes copied from the deployed `<12802,0>` schema, recorded in `spikes/RESULTS.md`). Modify `claim` and `enter`. Create `tests/registry.rs`.

- [ ] **Step 1:** Tests:
  - `claim_with_agent_requires_sender_is_agent_wallet`;
  - `claim_with_agent_falls_back_to_owner_when_no_wallet`;
  - `claim_with_revoked_agent_fails`.
- [ ] **Step 2–4:** Implement with `host.invoke_contract_read_only` on `state.registry`. **Skip condition:** if the deployed schema's return types can't be parsed in-contract within 2 hours, revert this task, keep the attestation-only check, and note it in the design doc. **Step 5:** Commit.

### Task 7: Deploy, init, and TS contract client

**Files:** Create `scripts/deploy.ts`, `server/src/chain/grpc.ts`, `server/src/chain/contract.ts`, `server/src/chain/plt.ts`, `server/test/contract.test.ts`.

**Interfaces (produces):**
- `grpcClient(cfg): ConcordiumGRPCNodeClient` (TLS).
- `BountyContract` with:
  - `view(id): Promise<Bounty|null>`, `stats(addr): Promise<Stats>`;
  - `buildUpdate(entrypoint: string, params: unknown, sender: string): Promise<UnsignedUpdate>`, which serialises with the embedded schema;
  - `getEvents(fromBlock: bigint): AsyncIterable<{block, txHash, event: BountyEvent}>`.
- `plt.transferPayload(to, amount, memo)`, `plt.tokenInfo()`, `plt.isOnAllowList(account): Promise<boolean>`, and `plt.findTransfers(account, {memo, to}): Promise<TxRef[]>`.

- [ ] **Step 1:** Build with `cargo concordium build --schema-embed --out dist/bounty_board.wasm.v1`, then deploy and init from `operator` (unsponsored) with `scripts/deploy.ts`. Initial values:
  - admin = operator;
  - attestor = the public key from `secrets/attestor.key` (generate it if missing);
  - review window 3 days, payment window 3 days. The `.env` overrides of 5 min are for demo runs; that needs a contract param, so deploy a separate demo instance with short windows.

  Write the instance to `.env` as `CONTRACT_INDEX`. Print the instance link.
- [ ] **Step 2:** `contract.test.ts` round-trips param serialisation for every entrypoint against the schema (offline), and decodes a captured `Posted` event fixture.
- [ ] **Step 3:** Implement, then run `npm test -w server` and confirm it passes. Commit: `feat: deploy script and contract client` (include the instance index in the README).

### Task 8: Indexer

**Files:** Create `server/src/indexer/db.ts`, `server/src/indexer/follow.ts`, `server/test/indexer.test.ts`.

**Interfaces:** `openDb(path): Db` (`node:sqlite`; tables `bounties`, `entries`, `events(tx_hash, block, kind, json)`, `cursor`), `applyEvent(db, ev): void`, and `follow(contract, db): Promise<void>`, which resumes from `cursor`.

- [ ] **Step 1:** Tests:
  - applying the event fixtures of a whole Exclusive and a whole Contest lifecycle yields the expected rows;
  - applying the same event twice is a no-op (keyed by tx hash plus event index).
- [ ] **Step 2–4:** Run the tests and confirm they fail, implement, then run them again and confirm they pass. **Step 5:** Commit.

### Task 9: Identity and badge verification, and the attestor

**Files:** Create `server/src/identity/challenge.ts`, `account.ts`, `badge.ts`, `attestor.ts`, `eligibility.ts`, and tests `server/test/identity.test.ts`.

**Interfaces:**
- `issueChallenge(subject: string): {nonce: string, expiresAt: number}` (single-use, 5 min, kept in memory).
- `verifyAccountSignature(account, nonce, signature): Promise<boolean>`, using web-sdk `verifyMessageSignature` against on-chain account keys.
- `classifyAccount(account): Promise<{kind: "person"|"company", idpIndex: number, idpName: string}>`. IDP 4 (testnet) means company. The IDP name comes from wallet-proxy `/v2/ip_info`.
- `verifyAgent(badgeOrTokenId, nonce, signature): Promise<{ok: true, tokenId, payoutAccount} | {ok: false, reason, retryAfter?}>`. It:
  1. calls the hosted check-badge (testnet);
  2. resolves the payout account through `getAgentWallet`, or the owner from `agentOf`;
  3. verifies the signature against that account.
- `checkPayoutEligible(account): Promise<{ok: boolean, faucetUrl?: string}>`, the allow-list check.
- `attestPost(...)` and `attestWork(...)`, which return `{expiry, signatureHex}` using the Task 2 bytes.

- [ ] **Step 1:** Tests, using mocked fetch and mocked chain:
  - `agent_signature_from_other_account_rejected` (Review Focus 1);
  - `badge_revoked_409_rejected`;
  - `badge_429_returns_retryAfter_not_ok` (Review Focus 4);
  - `badge_timeout_returns_unavailable`;
  - `challenge_single_use_and_expiry`;
  - `company_classified_by_idp4`;
  - `not_on_allow_list_refused_with_faucet_url` (Review Focus 5);
  - `attestation_verifies_with_contract_vectors`.
- [ ] **Step 2–4:** Run the tests and confirm they fail, implement, then run them again and confirm they pass. **Step 5:** Commit.

### Task 10: Sponsor service

**Files:** Create `server/src/sponsor/policy.ts`, `server/src/sponsor/sponsor.ts`, and `server/test/sponsor.test.ts`.

**Interfaces:**
- `prepareSponsored(intent: Intent, sender: string): Promise<{txJson: string, expiresAt: number, feeSponsored: true}>`.
- `Intent` is a union:
  - `{type:"contract", entrypoint, params}`;
  - `{type:"plt-transfer", to, amount, memo}`.
- The server builds the payload itself (never from client bytes), and the sponsor signs it, using the call shape from `spikes/RESULTS.md`.
- `policy.allow(intent, sender)` accepts only:
  - bounty_board entrypoints;
  - PLT transfers of `REWARD_TOKEN_ID` either to the escrow account with memo `fund:<id>`, or poster → recorded worker with memo `bounty:<id>`.

  It rate-limits to 30 per hour per sender and 10 per hour per badge, and warns when the sponsor's CCD drops below `SPONSOR_MIN_CCD`.

- [ ] **Step 1:** Tests:
  - `refuses_foreign_contract`;
  - `refuses_transfer_to_unrelated_account`;
  - `refuses_wrong_token`;
  - `rate_limit_trips_at_31`;
  - `prepared_tx_has_sponsor_and_sender_nonce`.
- [ ] **Step 2–4:** Run the tests and confirm they fail, implement, then run them again and confirm they pass. **Step 5:** Commit.

### Task 11: x402 facilitator and paywalled routes

**Files:** Create `server/src/x402/facilitator.ts`, `server/src/x402/routes.ts`, and `server/test/x402.test.ts`.

**Behaviour (spec, "x402" section):**
- `GET /bounties/:id/work`:
  - answers `402` with `PAYMENT-REQUIRED` (`exact`, asset `REWARD_TOKEN_ID`, `payTo` = worker or winner payout account, `amount` = reward, `extra.feePayer` = sponsor) when the status is `Accepted`/`Awarded`/`AcceptedUnpaid` **and** the bounty is NotFunded;
  - for an Escrowed bounty, returns the work without payment once `Paid`, to the poster only (with an auth challenge);
  - answers `409` otherwise.
- On a valid `PAYMENT-SIGNATURE` it settles, calls `record_payout` as operator, and returns the full work with `PAYMENT-RESPONSE`.
- `POST /bounties/:id/fund` answers `402` with `payTo` = escrow. Settlement then runs `confirm_funding`.
- The server only ever serves the stored work whose SHA-256 equals the on-chain `work_hash`. It returns 500 and alerts otherwise.

- [ ] **Step 1:** Tests:
  - `work_requires_payment_when_not_funded`;
  - `work_402_payTo_is_worker_not_board`;
  - `work_409_before_accept`;
  - `paid_work_hash_matches_onchain`;
  - `fund_402_payTo_is_escrow`;
  - `settlement_failure_does_not_record_payout`.

  Mock the facilitator settle.
- [ ] **Step 2–4:** Run the tests and confirm they fail, implement, then run them again and confirm they pass. **Step 5:** Commit.

### Task 12: Escrow worker and audit

**Files:** Create `server/src/escrow/worker.ts`, `scripts/audit.ts`, and `server/test/escrow.test.ts`.

**Interfaces:**
- `tick(db, contract, plt): Promise<void>`. It is idempotent and does this:
  - **Matches deposits** to escrow with memo `fund:<id>` and amount ≥ reward for `Open`/`Claimed` NotFunded bounties, then calls `confirm_funding`. Others are logged as unmatched.
  - **Pays out** `Accepted` + Escrowed (to the worker) and `Splitting` (n transfers), then calls `record_payout`.
  - **Refunds** `Cancelled`/`Expired`/`RejectedFinal`/`NoAward` + Escrowed, then calls `record_refund`.
  - **Before any transfer**, calls `plt.findTransfers(escrow, {memo:"bounty:<id>"|"refund:<id>", to})`, and reuses an existing tx instead of sending again.
- `scripts/audit.ts`: for every Escrowed bounty, matches the funding tx, payout and refund txs on-chain and compares the escrow balance against the sum of escrowed-but-unpaid bounties. It prints a table and exits non-zero on mismatch.

- [ ] **Step 1:** Tests:
  - `unmatched_amount_not_confirmed`;
  - `wrong_memo_not_confirmed`;
  - `second_deposit_not_confirmed` (Review Focus 2);
  - `restart_after_transfer_before_record_does_not_double_pay` (Review Focus 3);
  - `payout_failure_not_allow_listed_leaves_accepted` (Review Focus 5);
  - `split_sends_n_transfers_with_remainder_to_entry0`;
  - `refund_states`.
- [ ] **Step 2–4:** Run the tests and confirm they fail, implement, then run them again and confirm they pass. **Step 5:** Commit.

### Task 13: REST API

**Files:** Create `server/src/api/app.ts`, `server/src/api/routes/*.ts`, `server/src/main.ts`, and `server/test/api.test.ts`.

**Routes:**
- `GET /bounties?status&kind&funding`, `GET /bounties/:id` (spec JSON + chain state + explorer links), and `GET /profiles/:account` (stats + IDP label).
- `POST /auth/challenge` and `POST /auth/verify` (account or agent; returns a session token).
- `POST /bounties` (stores the spec JSON, returns `specHash`, the attestation and the prepared sponsored `post` tx).
- `POST /bounties/:id/claim` (runs the eligibility checks, then returns the attestation and the prepared tx).
- `POST /bounties/:id/submit` (stores the preview and full work, returns `work_hash` and the prepared tx; contest uses `enter`).
- `POST /bounties/:id/{accept|reject|award|cancel}` returns a prepared tx.
- `POST /tx/submit` (relays a sender-signed sponsored tx, returns the hash and link).
- `GET /admin/health` (sponsor balance, unmatched deposits, failed payouts).
- The x402 routes from Task 11.
- `main.ts` starts the API, the indexer follower and the escrow worker loop (every 15 s).

- [ ] **Step 1:** Tests (Fastify `inject`, mocked chain):
  - `claim_without_session_401`;
  - `claim_ineligible_returns_reason`;
  - `post_returns_spec_hash_matching_body`;
  - `submit_stores_work_and_hash_matches`;
  - `bounty_detail_includes_explorer_links`;
  - `fee_fallback_flag_surfaces_in_response`.
- [ ] **Step 2–4:** Run the tests and confirm they fail, implement, then run them again and confirm they pass. **Step 5:** Commit.

### Task 14: MCP server

**Files:** Create `server/src/mcp/server.ts`, `server/src/mcp/tools.ts`, and `server/test/mcp.test.ts`.

Use Streamable HTTP at `/mcp`. The tools are thin wrappers over the Task 13 route handlers (shared functions, not HTTP calls):

| Tool | What it wraps |
|---|---|
| `list_bounties`, `get_bounty`, `get_profile` | read routes |
| `request_challenge`, `verify_agent` | auth |
| `prepare_post`, `prepare_fund` | returns x402 requirements for funding |
| `prepare_claim`, `prepare_submit` | the matching route |
| `prepare_accept`, `prepare_reject`, `prepare_award`, `prepare_cancel` | the matching route |
| `submit_signed` | `POST /tx/submit` |
| `fetch_work` | returns x402 requirements, or the work |
| `check_payout_eligibility`, `get_status` | eligibility check, status |

Each tool description says which identity it needs and that fees are sponsored.

- [ ] **Step 1:** Test: an MCP client from the SDK, in process, lists the 16 tools and calls `list_bounties` and `prepare_claim` (mocked) with the expected shapes.
- [ ] **Step 2–4:** Run the test and confirm it fails, implement, then run it again and confirm it passes. **Step 5:** Commit.

### Task 15: Agent Card hosting and agent registration script

**Files:** Create `server/public/agents/bounty-worker.json`, a route that serves `/agents/:name.json` byte-exact (`readFile` buffer, `content-type: application/json`, no re-serialisation), `agent/src/register.ts`, and `server/test/card.test.ts`.

- [ ] **Step 1:** Test `served_bytes_sha256_equals_file_sha256`.
- [ ] **Step 2:** Implement. `register.ts` turns spike 03 into a repeatable script (idempotent: if the agent is already registered and the hash matches, print the badge and exit).
- [ ] **Step 3:** Run against testnet. Expected: check-badge valid. Commit.

### Task 16: Reference worker agent

**Files:** Create `agent/src/main.ts`, `agent/src/tasks/page-facts.ts`, `agent/src/signer.ts`, `agent/test/page-facts.test.ts`.

**Interfaces:** `interface TaskHandler { kind: string; canHandle(spec): boolean; run(spec): Promise<{preview: string, full: string}> }`. `page-facts` fetches `spec.input.url` and returns the title, word count and SHA-256 of the body.

**Loop:**
1. Connect to MCP at `BOARD_MCP_URL`.
2. Check its own payout eligibility.
3. `list_bounties{status:"Open", taskKind:"page-facts"}`.
4. Pick the first one.
5. Challenge, then sign.
6. `prepare_claim` (or skip it for a contest).
7. Sign and `submit_signed`.
8. Run the task.
9. `prepare_submit`, sign and submit.
10. Poll `get_status` until `Paid`.
11. Print each explorer link.

The agent also has a `--post` mode, which posts a Not-funded page-facts bounty and pays for delivery through x402. That shows agents on the poster side.

- [ ] **Step 1:** Unit test `page-facts` with a local HTTP fixture (title, word count and hash asserted).
- [ ] **Step 2–4:** Run the test and confirm it fails, implement, then run it again and confirm it passes. **Step 5:** Commit.

### Task 17: Web app

**Files:** `web/` (Vite React TS). Pages: `Board`, `BountyDetail`, `PostBounty`, `MyBounties`, `Profile`. Shared: `useWallet` (wallet-connectors, browser wallet), `api.ts`, `ExplorerLink`, `FundingBadge` (labels "Escrowed (custodial)" / "Not funded").

- [ ] **Step 1:**
  - Board lists bounties with kind and funding badges.
  - PostBounty asks for kind, title, description, task kind and input, reward, deadline, and "Fund now". Fund now runs the x402 fund flow or falls back to a sponsored transfer.
  - MyBounties offers accept, reject and award, and "Unlock work (pay worker)" through x402.
  - Profile shows the IDP label and stats.
- [ ] **Step 2:** Spike-check the browser wallet signing the x402 payload. If it can't, use the documented fallback and show a note.
- [ ] **Step 3:** Add a component test (vitest + testing-library) for `FundingBadge` and a "fee applies" banner that shows when the server flags a fallback.
- [ ] **Step 4:** Manual check against testnet in the browser pane: post → fund → see Escrowed. Commit.

### Task 18: End-to-end demo, README, submission draft

**Files:** Create `scripts/e2e.ts`, `README.md`, `docs/submission.md`, `docs/demo-script.md`.

- [ ] **Step 1:** `e2e.ts` runs on testnet against the demo instance, with short windows:
  - (a) Escrowed Exclusive: poster posts and funds, the agent claims, submits and gets paid from escrow;
  - (b) Not-funded Exclusive: paid on delivery through x402;
  - (c) Escrowed Contest with 2 entries (agent + poster's second account): no award, so `split_unawarded` and the split payout run.

  It prints every tx link into `docs/e2e-run.md`, then runs `scripts/audit.ts`. Expected: all states reach `Paid`, and the audit exits 0.
- [ ] **Step 2:** Run all the tests: `cargo concordium test` (contracts) and `npm test --workspaces`. Expected: all pass.
- [ ] **Step 3:** The README covers prerequisites, account setup (link to `docs/setup-accounts.md`), env vars, deploy, run server, web, agent, MCP config snippets (Claude Code / Claude Desktop), the trust model (custodial escrow, attestor, what is on-chain) and explorer links.
- [ ] **Step 4:** `docs/submission.md` holds the description, the Concordium components used and how, the path to mainnet (spec section), the CCDExplorer links (contract instance, agent token, e2e txs) and the 3-minute video script in `docs/demo-script.md`. Commit.

---

## Self-review notes

- **Spec coverage:** everything in the spec has a task:
  - identity: 9;
  - badge plus challenge: 9, 15;
  - EUDemo and the allow list: 0, 9, 12;
  - sponsorship: 1, 10;
  - Exclusive and Contest rules: 4, 5;
  - x402 (both uses): 11, 16, 17;
  - escrow plus audit: 12;
  - MCP for both sides: 14;
  - web: 17;
  - registry cross-call (optional): 6;
  - e2e, README, submission: 18.
- **Not covered:** the optional ZK attribute gate is a non-goal, done only if time allows after Task 18.
