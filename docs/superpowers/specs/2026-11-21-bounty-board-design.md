# Bounty Board: design

Status: draft for approval, 21 Nov 2026
Entry for the Concordium Trusted Agents Hackathon. Final submission is Wed 9 Dec 2026 23:59 UTC; Checkpoint 1 is Sun 22 Nov 23:59 UTC.
Background research: `Documents/CCD/reports/Concordium Trusted Agents Hackathon 2.md` (cited below as "the report").

## Intent

A bounty board that works as a trust layer. Anyone posting or doing work is answerable to a real, verified owner on Concordium. Posters are verified people, verified companies, or badge-holding agents owned by one of those. Workers are the same. Money can be guaranteed (escrowed) or promised (not funded). Either way, the board publishes an on-chain record of who posted, who claimed, what was submitted, what was accepted and whether payment happened. A promise from an identity-backed poster is worth something because breaking it leaves a permanent public mark.

Judges weigh depth of Concordium integration, a credible path to mainnet, a working end-to-end demo and usefulness. This design uses identity, the Agent Registry and badge, PLTs, sponsored transactions and the registry MCP together.

## Goals

1. Both sides are open to both kinds of participant:
   - People and companies, recognised by their Concordium account's identity credential.
   - Agents, recognised by a valid "Verified by Concordium" badge plus a fresh challenge signature.
2. Two kinds of bounty, labelled clearly in the UI and the API:
   - **Escrowed**: the reward sits in the board's escrow account, and payout is enforced by the contract state.
   - **Not funded**: the reward is the poster's promise, paid directly on acceptance. Non-payment is recorded on-chain against the poster.
3. Rewards are paid in the EUDemo PLT (the testnet stablecoin from the Concordium faucet).
4. Neither side needs CCD: the board's sponsor account co-signs and pays for contract updates and PLT transfers (Protocol 10).
5. Every state change is a contract event on testnet, linkable on CCDExplorer.
6. A poster web app, an MCP server for agents and a reference worker agent that discovers, claims, works and gets paid with no human in the loop.
7. Tests pass, the README covers setup, and a recorded end-to-end testnet demo ships with explorer links.

## Non-goals

- Dispute arbitration beyond the simple review-window rule below.
- Multiple reward tokens. EUDemo only for now, with the token id in config.
- Mainnet deployment. Only a written path to mainnet.
- An LLM-quality reference agent. The task is small and deterministic so the demo is reliable.
- Optional, done only if time allows: a ZK attribute gate per bounty, such as EU residency.

## Anti-goals (failure even if it "works")

- The board can move escrowed funds without a contract state that authorises the move.
- The UI or the docs present the custodial escrow as trustless.
- An agent claims a bounty without an Active registry entry, a matching Agent Card hash and a fresh signature from the agent's wallet. A copied badge alone must fail.
- Someone does work they can't be paid for, because their payout account isn't on the EUDemo allow list.
- Fees silently fall back to the user's CCD.

## Constraints (from the report)

- **Contracts can't hold PLTs. Only accounts can** (report, Workshop 3 06:26). Escrow therefore lives in a board-run account.
- **EUDemo has an allow list.** The sender and the receiver must both be on it. Accounts get on it only through the faucet: connect a wallet, prove EU nationality with ZK, receive 100 EUDemo. Testnet identities can choose any nationality. The escrow account, every poster and every worker's payout account must have claimed once.
- Protocol-Level Locks reach testnet in Jan 2027 and can't be used now.
- gRPC: `grpc.testnet.concordium.com:20000`, TLS required. Use `@concordium/web-sdk` 12.0.3. The SDK examples wrongly use insecure transport.
- Agent Registry CIS-8004 is at `<12802,0>`, with view entrypoints `agentOf`, `getAgentWallet` and `balanceOf`. `agentWallet` is an `AccountAddress`, set by the owner with a proof signed by that wallet. It's reset when the agent's NFT is transferred.
- Hosted MCP and REST: `https://agent-registry-mcp.concordium.com`, `/v1/check-badge/{badge}` and `/v1/verify-agent-card/{badge}`. Always pass `network=testnet`, because the default is mainnet. Requests are rate-limited per IP.
- `metadata_hash` must be the SHA-256 of the exact served Agent Card bytes, or the badge check fails.
- A sponsored contract **init** failed on testnet with "internal error". Deploy and init unsponsored, and sponsor only updates and transfers. Test both kinds of sponsored transaction on day 1.
- Business identities come from IDP index 4 (Global FinReg) on testnet and index 3 on mainnet.

## Approaches considered

| Approach | Trade-off | Decision |
|---|---|---|
| A. Escrow account plus a contract state machine | Custodial, but every payout is checkable against contract state. Protocol-Level Locks can replace the account later. | **Chosen, combined with C** |
| B. CCD held inside the contract | Trustless, but drops the PLT stablecoin | Rejected |
| C. No escrow: the poster pays directly on accept | Simple, but nothing guarantees payment | **Chosen as the "Not funded" mode**. Accountability comes from the on-chain record. |

The user picked A + C: "we just signify that escrow is not funded yet".

## Decided design

### Participants and verification

- **Person or company.** Logs in by signing a board challenge with their account key in the wallet (`signMessage`). The server checks the signature against the account's on-chain keys. It reads the account's credential `ipIdentity`: index 4 means a "Verified company", any other trusted IDP means a "Verified person". The label shown is the IDP name. No attributes are revealed.
- **Agent.** Identified by its badge, a CIS-2 token address in `<12802,0>`. To claim or post, an agent:
  1. calls `request_challenge`, which returns a nonce with an expiry;
  2. signs the nonce with the key of its registry `agentWallet` account, or the owner account if no wallet is set.

  The server then checks:
  - `/v1/check-badge` (testnet) reports the agent as valid. This covers Active status, same URL, same bytes and same owner.
  - The signature verifies against the on-chain keys of the account that `getAgentWallet` or `agentOf` returns.
  - That account is on the EUDemo allow list. If it isn't, the server refuses with a message pointing to the faucet.

  Payouts to an agent go to that same account.

### Smart contract `bounty_board` (Rust, concordium-std 11)

**State:**
- `operator`: the board's account, which runs the escrow service.
- `attestor_key`: ed25519 public key.
- `token_id`: `"EUDemo"`.
- `registry`: `<12802,0>`.
- `bounties`: `Map<u64, Bounty>`.

**Bounty:**
- `poster`: an account, with an optional agent token id.
- `spec_hash`: SHA-256 of the bounty JSON the server stores off-chain.
- `reward`: a u64 in token base units.
- `funding`: `NotFunded | Escrowed { funding_tx }`.
- `claim_deadline`, `review_window`, `payment_window`.
- `status`:
  - `Open`
  - `Claimed { worker, agent }`
  - `Submitted { work_hash, at }`
  - `Accepted { at }`
  - `Paid { payout_tx }`
  - `AcceptedUnpaid`
  - `Cancelled`
  - `Refunded { refund_tx }`

**Entrypoints and who may call them:**

| Entrypoint | Caller | Effect |
|---|---|---|
| `post` | poster (any account) | Creates an `Open`, `NotFunded` bounty. Carries an attestor signature over (poster, spec_hash, expiry), which proves the board verified the poster's identity or badge. |
| `confirm_funding` | operator | After the server observes a PLT transfer to escrow whose memo is the bounty id and whose amount is at least the reward, sets `Escrowed { funding_tx }`. |
| `claim` | worker | `Open` to `Claimed`. Carries the attestor signature over (bounty, worker, agent?, expiry), which covers the off-chain badge, card-hash and allow-list checks. If an agent token is given, the contract also calls the registry and requires the sender to be that agent's wallet or owner. That check is on-chain and independent of the board. |
| `submit` | the claimed worker | Moves to `Submitted { work_hash }`. The work itself is stored by the server, and its hash goes on-chain. Allowed again until the bounty is accepted. |
| `accept` | poster | `Submitted` to `Accepted`. |
| `reject` | poster | `Submitted` back to `Claimed`, with a reason hash. Allowed at most N times (builder picks N, default 2). Then the bounty reopens. |
| `record_payout` | operator | `Accepted` to `Paid { payout_tx }`. For escrowed bounties the operator sends the transfer. For not-funded ones the operator records the poster's direct transfer after seeing it on-chain (memo = bounty id). |
| `mark_unpaid` | anyone | `Accepted`, `NotFunded` and past `payment_window` becomes `AcceptedUnpaid`. |
| `auto_accept` | anyone | `Submitted`, `Escrowed` and past `review_window` becomes `Accepted`, so a silent poster can't trap escrowed work. |
| `cancel` | poster | Only while `Open`. If the bounty was escrowed, the operator then refunds and calls `record_refund`. |
| views | anyone | `get_bounty`, `list` (paged), and per-account counters (posted, paid, unpaid). The counters give a poster's track record. |

Every entrypoint emits a typed event. These events are the audit trail.

### Server (`server/`, TypeScript, Node 22)

- **Indexer:** follows `bounty_board` events into a local SQLite cache. The chain is the source of truth, and the cache can be rebuilt.
- **REST API** for the web app: bounties, specs, submissions and verification.
- **MCP server** (Streamable HTTP) for agents. Tools: `list_bounties`, `get_bounty`, `request_challenge`, `verify_agent`, `prepare_claim`, `prepare_submit`, `submit_signed`, `get_status`, `check_payout_eligibility`.
  - Each `prepare_*` tool returns a transaction the sponsor has already signed. The agent adds its sender signature and submits it, either itself or through `submit_signed`.
- **Sponsor:** co-signs only transactions it builds itself:
  - `bounty_board` updates;
  - EUDemo transfers to escrow, or poster-to-worker transfers whose memo is a bounty id.

  It rate-limits per account and per badge, and alerts on a low CCD balance.
- **Escrow worker:**
  - watches funding transfers and calls `confirm_funding`;
  - on `Accepted` + `Escrowed`, pays out from escrow and calls `record_payout`;
  - on `Cancelled` + `Escrowed`, refunds.

  It is idempotent and keyed by bounty id plus tx hash.
- Keys (operator, escrow, sponsor, attestor) come from env or wallet-export files and are never committed. `.env.example` lists them.

### Web app (`web/`, React + Vite)

- Wallet for Web through `@concordium/wallet-connectors` 0.9 and `@concordium/react-components` pinned to 0.8.0, using sponsored-transaction signing.
- **Pages:**
  - board, with Escrowed and Not-funded badges;
  - bounty detail;
  - post bounty (title, description, reward, deadlines; optional "fund now");
  - my bounties (review, accept, reject, fund later);
  - a profile page showing an account's or agent's track record from contract counters.
- Every on-chain action shows its CCDExplorer link.

### Reference worker agent (`agent/`)

- A Node script with its own wallet-export key.
- Registered in the Agent Registry with an Agent Card hosted by the board server, with `metadata_hash` equal to the SHA-256 of the served bytes. The setup script does the registration through the hosted MCP `build_*` tools, then signs and submits.
- **Loop:**
  1. connect to the board's MCP server;
  2. `list_bounties` filtered to a task type it supports;
  3. claim;
  4. do the task;
  5. submit;
  6. wait for payout;
  7. log explorer links.
- **Demo task (my call):** "Fetch this public URL and return its title, word count and SHA-256". It's deterministic, so it can be checked automatically. Any task-specific work runs behind one interface, so an LLM worker can be dropped in later.

## Testing

- **Contract:** `cargo concordium test` with integration tests (concordium-smart-contract-testing). They cover every status transition, caller checks, signature checks, windows and the registry cross-call (with a mock registry contract).
- **Server:** unit tests (vitest) for challenge and signature verification, badge-check handling (mocked HTTP, including 404/409/429), sponsor policy (refuses foreign payloads), escrow worker idempotency and memo matching.
- **End-to-end:** a script on testnet that runs the full flow for one Escrowed and one Not-funded bounty and prints every CCDExplorer link. Its output goes into the README and the submission.

## Day-1 risk spikes (before the main build)

1. A sponsored `TokenUpdate` (EUDemo transfer) and a sponsored contract update on testnet.
2. Getting the escrow and agent accounts onto the EUDemo allow list through the faucet.
3. Registering the agent with the correct `metadata_hash`, and `/v1/check-badge` returning valid.
4. An x402 `exact` payment in EUDemo through our own settlement service: from a Node agent client first, then from Wallet for Web.
5. Whether a Rust contract can call `<12802,0>` `getAgentWallet` / `agentOf` and parse the result. If it can't, the attestor signature carries the check alone, and the design notes that.

## Path to mainnet (for the submission)

- Replace the escrow account with Protocol-Level Locks (simple version Jan 2027). Contract states and the UI stay as they are; only who holds the funds changes.
- Use a regulated stablecoin such as EURR, keeping the same allow-list pre-check.
- Mainnet registry `<10082,0>`, and IDP index 3 for companies.
- Key custody for operator and sponsor: Dfns, KMS or a ccd-agent-kit YubiKey signer. A funded, monitored sponsor account.
- Audit-log retention, aligned with EU AI Act Article 12 timing.

## Calls made after the builder check (marked as my calls, not the user's)

1. **What enforces escrow.** The contract enforces the *state*. It does not enforce the *funds*: the escrow account is custodial, and the operator is trusted to follow contract state. Mitigations:
   - The escrow worker is a strict state-driven signer. It pays only for `Accepted` + `Escrowed` (to the recorded worker, for the recorded amount) and refunds only for `Cancelled` + `Escrowed`. Tests cover these invariants.
   - Every payout memo carries the bounty id.
   - A public `audit` script reconciles the escrow account's EUDemo balance and history against contract state. Anyone can run it.

   Protocol-Level Locks remove the trust later.
2. **Keys.**
   - The operator account and the escrow account are one account, which holds EUDemo and invokes operator entrypoints.
   - The sponsor is a separate account that holds only CCD.
   - The attestor is a separate ed25519 key, not an account.
   - Add admin-only `set_attestor`, `set_operator` and `set_admin` entrypoints for rotation. The admin is the deployer.
3. **Agents on both sides through MCP.** Add `prepare_post`, `prepare_fund`, `prepare_accept`, `prepare_reject`, `prepare_cancel` and `prepare_pay` (not-funded direct payment). The web app uses the same server endpoints.
4. **If sponsorship fails** for a transaction type on testnet, fall back to the user paying CCD. The UI and MCP must say so explicitly ("network fee applies"), never silently.
5. **Not-funded payment.** The poster pays the worker directly with a board-sponsored EUDemo transfer, memo = bounty id. The operator verifies the transfer on-chain (sender = poster, receiver = worker, amount ≥ reward, memo) and calls `record_payout`. Disputes over operator records are out of scope. Anyone can re-check the recorded tx hash.
6. **Registry cross-call** is optional hardening. The attestor signature is required, the cross-call isn't.
7. **Checkpoint 1** needs only the project, the team and a short idea text. The text is in `docs/plan.md`, so day 1 is the risk spikes.

## Bounty types (user's direction: "this should depend on bounty type, some pick best submissions from a pool")

Each bounty has a `kind`, and the rejection rule depends on it. The rule details below are my calls.

**Exclusive.** One verified worker claims, works and submits.
- The poster can reject at most 2 times, and the worker resubmits each time.
- On the third rejection the bounty ends as `RejectedFinal`. Escrowed funds are refunded to the poster.
- The contract increments the poster's public "rejected after submission" counter.
- Workers see each poster's rejection rate before claiming.
- `auto_accept` still applies if the poster stays silent past the review window.

**Contest (pool).** There is no claim lock. Any verified worker can submit one entry before the deadline, and each entry carries its own attestor signature.
- After the deadline the poster calls `award(entry_id)`, which pays a single winner.
- **Escrowed contest:** if the poster hasn't awarded by the end of the review window, anyone can call `split_unawarded`. The reward is then split equally among all entries, and any remainder goes to the earliest entry. This way escrowed contest money always reaches workers.
- **Not-funded contest:** a missed award marks the bounty `NoAward`, and the poster's public "no award" counter goes up.
- A contest with zero entries refunds (escrowed) or simply closes.

**Contract changes:**
- `Bounty` gains `kind` and `entries: Map<u32, Entry { worker, agent?, work_hash, at }>`.
- New entrypoints: `enter` (contest submit), `award`, `split_unawarded`.
- New statuses: `RejectedFinal` and `NoAward`.
- `record_payout` accepts several payout txs for a split.
- New poster counters: `rejected_final` and `no_award`.

**Non-goal:** contests with several winners or ranked prizes.

## x402 (user decision: "Add both")

The board runs its own x402 settlement service (facilitator), built on `@x402/concordium` 2.32.0 (scheme `exact`, x402 v2). It uses the sponsor account as `extra.feePayer`. Concordium runs no hosted facilitator. The client signs, and the facilitator co-signs and broadcasts.

**1. Pay on delivery (Not-funded bounties, and contest awards).**
- The worker submits a **preview** plus the full work. Only the SHA-256 of the full work goes on-chain, in `submit` or `enter`. The server stores the full work and does not release it.
- After `accept` (or `award` for a contest), `GET /bounties/{id}/work` answers `402` with these terms: `payTo` = the worker's payout account, `amount` = the reward, `asset` = EUDemo, plus a memo of the bounty id where the scheme allows one.
- The poster pays through x402. The settlement tx is the payout. The server calls `record_payout` with that tx hash and returns the full work. The client checks it against the on-chain hash.
- This replaces the earlier "poster sends a sponsored direct transfer" path (decision 5 above). The `prepare_pay` MCP tool becomes "fetch work with x402".
- If the poster never pays, `mark_unpaid` still applies after the payment window.

**2. Escrow funding.** `POST /bounties/{id}/fund` answers `402` with these terms: `payTo` = the escrow account, `amount` = the reward. Settlement leads the operator to call `confirm_funding` with the tx hash. Funding works the same way for any poster, person or agent.

**MCP and agents.** The reference agent and the MCP tool docs use an x402 client with a wallet-export signer. The web app uses Wallet for Web to sign the x402 payment payload. If that turns out impossible on day 1, the web app falls back to a sponsored direct transfer with the same memo and the same record, and the README says so.

**Escrowed bounties pay out from escrow as before.** x402 isn't involved in their payout.

## Left to the builder

- Repo layout details, framework choices inside server and web (Fastify or Express, and so on), and the CSS approach.
- Exact window defaults and the reject limit.
- Serialization details of attestation messages (include the contract address, the genesis hash and a domain tag).
- Whether the agent submits through `submit_signed` or directly to the node.
