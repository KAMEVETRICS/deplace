# Deplace: plan (draft, awaiting decisions)

## Checkpoint 1 idea text (due Sun 22 Nov 23:59 UTC)

> Deplace is a marketplace where people post small paid tasks and AI agents do the work, with every step answerable to a real person on Concordium testnet. A poster with a verified Concordium identity funds a bounty in a PLT stablecoin. Only agents with a valid "Verified by Concordium" badge from the Agent Registry, who can also sign a fresh challenge with their registered key, can claim it. A Rust contract records each claim, submission and payout on-chain, and sponsored transactions pay the fees, so neither side needs CCD. Agents find and work bounties through an MCP server, and posters review the work and release payment in a web app.

## Constraint found in the research

**Smart contracts cannot hold PLTs. Only accounts can** (Workshop 3, 06:26). A Rust contract can't hold EUDemo or EURR in escrow, and Protocol-Level Locks don't reach testnet until January 2027.

A second constraint: EUDemo has an **allow list**, so the sender and the receiver must both be on it. The faucet adds an account only after a ZK proof of EU nationality. The escrow account and every agent's payout account would each have to claim from the faucet once, using a testnet identity with an EU nationality.

## Escrow options

| Option | How it works | Trade-off |
|---|---|---|
| **A. Escrow account plus contract state machine (recommended)** | A board-run escrow account holds the PLTs. The poster funds it with a PLT transfer whose memo is the bounty id. The Rust contract `deplace` is the source of truth: post, fund confirmation, claim, submit, accept, cancel and refund. The payout service moves PLTs only when the contract state says so, and the payout tx hash is written back to the contract. | It's custodial: you trust the board operator. Every move can be checked against the contract on-chain. The path to mainnet is clear: swap the escrow account for Protocol-Level Locks in Jan 2027 with no change to the contract or the UI. |
| B. CCD escrow inside the contract | The contract holds CCD itself. | Trustless today, but it drops the PLT stablecoin requirement and is weaker on "payments". |
| C. No escrow | The poster pays the agent directly on accept, and the contract only records it. | Simplest, but the agent has no payment guarantee, which weakens the pitch. |

## Proposed architecture (with A)

- `contracts/deplace` (Rust, concordium-std 11): bounties, status transitions, claims bound to the agent's CIS-8004 token id, a submission hash, an accept, and a payout tx-hash record. Events give the on-chain audit trail.
- `server/` (TypeScript, Node, web-sdk 12.0.3, TLS): REST API, badge check (hosted MCP / REST with `network: testnet`), challenge-response against the agent's registered key, sponsor co-signing for contract updates and PLT transfers, escrow payout worker, MCP server for agents (Streamable HTTP).
- `web/` (React + Vite, Wallet for Web via wallet-connectors 0.9): post and fund, review, accept.
- `agent/`: the reference worker. It registers in the Agent Registry with a real `metadata_hash`, discovers bounties over MCP, claims, does a small deterministic task (for example summarising a URL or converting a file), submits, and gets paid.
- Optional: an EU-residency ZK gate per bounty, through the V0 hosted verifier.

## Early risks to test first (day 1–2)

1. Sponsored **contract update** and sponsored **PLT TokenUpdate** on testnet. A sponsored *init* has been reported failing, so we'd deploy and init unsponsored.
2. Getting EUDemo onto the escrow and agent accounts through the faucet's allow list. The fallback is to request our own PLT through the issuance form today, which would make us its governance account.
3. Registering an agent with a correct `metadata_hash`, so the badge check passes.
