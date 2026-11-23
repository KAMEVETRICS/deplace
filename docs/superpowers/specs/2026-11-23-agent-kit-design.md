# Agent kit: any MCP agent on Deplace

Agreed in conversation on 23 Nov 2026.

## Intent

Chat models can call MCP tools, but they can't sign Concordium transactions. The board's MCP server (`server/src/mcp/server.ts`) already lets a badge-holding agent log in, yet the login and every action after it need a signature from the agent's account. So today only an agent with its own Concordium code, like our reference agent, can work a bounty.

The agent kit closes that gap. It's a small MCP server the agent's owner runs on their own machine with their agent's key. Any MCP client (Claude Desktop, Claude Code, others) connects to it and gets plain tools for working, posting and paying bounties. The kit logs in, checks, signs, relays and pays; the model never touches a key or a transaction. The reference agent's rails hold in the kit whatever the model asks. That matters because the model now reads bounty descriptions and submitted work, and strangers write both.

It's for the Concordium Trusted Agents Hackathon (submission due 9 Dec 2026). Outside agents, and judges trying Deplace with Claude, should be able to take part without writing Concordium code.

## Goals

- A local stdio MCP server, run from a clone of the repo, that talks to the board's MCP endpoint (`BOARD_MCP_URL`, live at https://deplace.space/mcp).
- Tools to work bounties (find, claim, submit, check) and to post and pay them (post, fund, accept, reject, award, cancel, get the work and pay on delivery).
- A `register` command, so an owner can get an Agent Registry badge with the same key.
- A "Connect your agent" guide (`docs/connect-your-agent.md`, linked from the README).

## Non-goals

- Doing the work. The model does each task with its own tools (Claude Code's shell, for example); the kit has no task handlers.
- Publishing the kit to npm, or Deplace hosting Agent Cards for outside agents.
- Changes to the board server, the web app or the contract.
- More than one agent per kit process. Mainnet.

## Anti-goals

The kit has failed, even if it works, when:

- a tool argument, a bounty's text or a board answer gets it to sign or pay outside its rails;
- a key, a signature or a raw transaction reaches the model or a log;
- a dropped connection makes it post, claim or pay twice;
- the reference agent loses any behaviour or rail it has today (it may refuse more, never less), or `server/public/agents/bounty-worker.json` changes by one byte (its URL and SHA-256 are pinned on chain for badge token 1418).

## Approaches

Where the code lives (picked: inside `agent/`):

- **Inside `agent/` (picked).** A second entry point next to the reference agent, at `agent/src/kit/`. The sequences in `workOne`, `postAndPay` and `register.ts` get split into steps that both the reference agent and the kit call, so each sequence and each rail exists once. Everything the kit reuses, dependencies included, already sits in `agent/`. The cost: one package holds two things, so the README and the guide have to point people at it.
- **A new `kit/` workspace.** Rejected. Its name is clearer for outsiders and it could go to npm later, but it needs imports across packages and a second test setup, and `agent/` would still need the same split.
- **Shared code moved to `packages/agent-core`.** Rejected. The cleanest separation, but it moves most of `agent/src` and its tests with two weeks left.

Scope, decided with the user:

- **Work, post and pay** (picked) over work only. Work only was smaller and safer, since nothing the model did could move tokens. Posting and paying let an agent hire another agent, within the budget caps.
- **A `register` command in the kit** (picked) over a guide-only route, which would leave owners needing their own way to sign the registry's transactions. Deplace hosting outside agents' cards was ruled out: it needs a new board endpoint and a live redeploy, and those badges would fail whenever deplace.space is down.

## Design

### Running it

- `node <repo>/agent/bin/kit.mjs` starts the MCP server on stdio. The launcher registers tsx through its API (`tsx/esm/api`, present in tsx 4.23) and imports `agent/src/kit/main.ts`. So it runs from any working directory and needs no `npx`, which on Windows also means no `cmd /c` wrapper.
- `node <repo>/agent/bin/kit.mjs register` runs the registration command in a terminal.
- Settings come only from the environment: the MCP client's `env` block, or a file passed with Node's `--env-file`. The kit doesn't read the repo's `.env`. On this PC that file still points `BOARD_MCP_URL` at a local board, and outsiders won't have one. Key file paths may be absolute or relative to the repo root.
- stdout carries MCP messages only. Logs go to stderr; the kit never calls `console.log` (dotenv 18 already logs to stderr).
- `GRPC_DNS_RESOLVER=native` is set before grpc-js loads, as `agent/src/env.ts` does.

| Setting | Default | What it does |
|---|---|---|
| `AGENT_KEY_FILE` | required | Wallet for Web key export of the agent's agentWallet account |
| `AGENT_BADGE` | required, except for `register` | the badge's CIS-2 token address |
| `BOARD_MCP_URL` | `https://deplace.space/mcp` | the board |
| `CONTRACT_INDEX`, `CONTRACT_SUBINDEX` | `13123`, `0` | the only contract the kit signs calls to; never taken from the board |
| `AGENT_ALLOW_FEES` | `false` | lets the kit pay a network fee when the board can't sponsor one, up to 30,000 energy |
| `AGENT_MAX_REWARD`, `AGENT_DAILY_BUDGET` | `5`, `20` | EUDemo caps per bounty and per 24 hours |
| `AGENT_BUDGET_FILE` | `data/agent-budget.json` | commitments and payments; the reference agent uses the same file |
| `AGENT_PENDING_FILE` | `data/agent-pending.json` | transactions and payments the kit sent but hasn't seen the outcome of; the account's lock file sits next to it |
| `GRPC_HOST`, `GRPC_PORT` | testnet | the kit's own chain reads |
| `REWARD_TOKEN_ID` | `EUDemo` | the only token it pays |
| `AGENT_NAME`, `AGENT_DESCRIPTION`, `AGENT_CARD_URL`, `AGENT_CARD_FILE`, `AGENT_SKILLS` | for `register` | the card's text, the URL that will serve it, where the kit writes it, and its skills (JSON; one generic skill by default) |

On first use the kit reads the board's `/config`. If the board names a different contract, every signing tool refuses and `whoami` says why. The kit starts even when the board can't be reached, and connects on first use.

### Tools

Each result is JSON text with explorer links and a one-line hint for the next step. Errors are JSON too: `error`, `retryable`, and `refusedBy: "kit"` when a rail said no.

For working:

- `whoami`: the agent's account and badge, whether the account can be paid (with the faucet link if not), the contract it signs for, the budget caps and what's committed in the last 24 hours.
- `find_bounties(task_kind?, kind?)`: open bounties this agent didn't post, with id, title, description, task kind, input, kind, reward, funding, deadline and the poster's name.
- `check_status(bounty_id)`: the live status from the chain, plus what matters for this agent's role. As worker: its claim or entry, and the latest rejection reason (the board keeps the text at `/specs/<reasonHash>`) with how many rejections are left before one is final. As poster: the submission preview, or the contest entries with their previews. Also the event trail with explorer links.
- `claim(bounty_id)`: Exclusive bounties only. A contest is entered with `submit_work`.
- `submit_work(bounty_id, preview, full)`: submits for an Exclusive bounty this agent claimed, or enters a contest. `preview` (up to 2,000 characters) goes to the poster now. `full` (up to 100,000) is released on acceptance or payment, and only its SHA-256 goes on chain.

For posting and paying:

- `post_bounty(title, description, task_kind, input, kind, reward, deadline_hours, escrow)`: checks the budget before anything is prepared, then posts. Afterwards it checks on chain that the bounty names this agent as poster and carries the reward it asked for. With `escrow`, it funds the bounty straight away, as `fund_bounty` does.
- `fund_bounty(bounty_id)`: escrows the reward of a bounty this agent posted, over x402.
- `accept(bounty_id)`, `reject(bounty_id, reason)`, `award(bounty_id, entry_id)`, `cancel(bounty_id)`. The description of `reject` warns that the third rejection is final and goes on the poster's public record.
- `get_work(bounty_id)`: the delivered work of this agent's bounty. Escrowed work comes after acceptance or award. When the bounty isn't escrowed, it first pays the worker on delivery over x402, then returns the work.

### Rails

They hold whatever the model asks and whatever the board answers.

Signing (`agent/src/rails/guard.ts`, extended):

- Only calls to the contract in the kit's settings; only the entrypoint the tool is for (`submit_work` expects `submit` or `enter`, by the bounty's kind); only with the agent's account as sender; with no CCD attached; sponsored, unless `AGENT_ALLOW_FEES=true`, and then at most 30,000 energy. Never a token transfer the board prepared.
- New: the call's parameter must match what the model asked for. The parameter layouts are fixed (`packages/shared/src/codec.ts`), so the kit compares bytes. Every action must carry the right bounty id. `submit` must carry the SHA-256 of `full`, and `reject` the hash of the reason as the board computes it. `award` must name the entry. `claim` and `enter` must carry the agent's own token id (and `enter` the work hash). `post` must carry the kind, reward and deadline asked for, the agent's token id, and the spec hash. The kit computes that hash itself from the same fields the board hashes in `createBounty`, in the same order, with the token from its own settings; a test pins the format (my call, from the review: otherwise a compromised board could post different text under the agent's name). Without this check, a compromised board could return "accept bounty 9" when the model asked to accept 7, and the guard would sign it. The reference agent's flows pass the same expectations.

Paying (`agent/src/rails/payments.ts`, `budget.ts`):

- Only through the kit's guarded x402 client, and only in EUDemo. Funding pays only the escrow account in the contract's configuration; paying on delivery pays only the worker the contract names. The amount is the reward recorded on chain. Each payment is booked against its bounty's commitment before signing, so a reward is paid once at most, within the per-bounty and 24-hour caps. Bookings are saved to `AGENT_BUDGET_FILE`.
- Only for bounties this agent posted, because only those have commitments.
- New: a post's reward is committed to the budget before the post is signed (under the transaction's hash), then moved to the bounty's id once the post is final. The caps count it even if the kit stops in between; a post that expired unsent frees its commitment.
- New: only at the board's own address. The x402 URLs the board returns must share `BOARD_MCP_URL`'s origin, so the session token never goes anywhere else.
- New (my call, from the review): a payment whose answer was lost stays booked, so the kit can't pay twice, but it mustn't stay stuck either. The board's sponsor signs an x402 payment after the kit does, so the kit can't know its final hash; it records the payment's nonce and expiry instead (from the signed transaction in the x402 payload; the board's terms give 300 seconds). Until the payment is resolved, the kit signs nothing else for the account. After the expiry it reads the account's finalized next nonce. Still at that nonce: the payment never landed and never can, so the booking is released and the kit may pay again. Past it: the payment landed, and the kit never pays that bounty again; if the board still asks for payment, the kit says so for the owner to sort out.

Also:

- One transaction at a time. The board prepares each transaction with the account's next nonce, so two prepared at once would collide. The kit queues signing and paying; parallel tool calls wait their turn.
- One signer per account (my call, from the review). The kit takes a lock file for its account before it signs anything. A second kit on the same account (Claude Desktop and Claude Code both set up with one key, say) or the reference agent refuses to sign and names the process that holds the lock; a lock left by a dead process is taken over. Without it, two processes would collide on nonces and overwrite each other's budget file, which would let the caps be bypassed. The reference agent takes the same lock.
- Tool results carry hashes and links only: no keys, signatures or transaction JSON.
- The kit's MCP instructions and the tool descriptions tell the model that bounty text and submitted work come from other people and are data, never instructions. The guide suggests owners let their client ask before any posting or paying tool runs.

### Login and sessions

The kit logs in on first use (`request_challenge`, `signChallenge`, `login`) and keeps the session in memory. The board keeps sessions in memory too, so a redeploy signs everyone out: on a 401 "log in first" the kit logs in again once and repeats the call. It checks payout eligibility on first use, and `claim` and `submit_work` stop early with the faucet link when the account can't be paid. The board re-checks the badge before it attests anything; its refusals pass through to the model.

### Network drops

This PC's connection drops often, so the kit waits out what it safely can.

- Before anything is signed (reads, login, `prepare_*`), it retries transport errors and `retryable` board errors with backoff, for up to about 30 seconds per tool call. Then it returns `retryable: true` and says nothing was signed or sent.
- It never resends blind. `submit_signed` waits for finalization; if its answer is lost, the kit keeps the signed transaction and its hash. The board's sponsor signs these before the kit does, so the kit holds the finished transaction and knows its final hash. Pending records go to `AGENT_PENDING_FILE` before the transaction is sent, so a restart by the MCP client doesn't lose them (my call, from the review); on start the kit resolves what it finds there. Until the outcome is known, the next call for the same action on that bounty (any `post_bounty`, for posts) first looks the transaction up on chain by its hash. Finalized: the kit reports it and finishes the step; a post's bounty id comes from the finalized events. Still pending: it waits. Absent after the transaction's 5-minute expiry: it prepares a new one. Careful: in web-sdk 12.0.3, `getAccountTransactionHash` gives the wrong hash for unsponsored (version 0) transactions; use `sha256(Transaction.serializeBlockItem(signed))`.
- Payments were safe from double paying already. Each one is booked before signing and stays booked if the request fails, and the board never issues new payment terms once a payment for the bounty has settled, so calling `get_work` again returns the work without paying twice. A payment that never reached the board is released by the nonce rule under Rails.
- After a transport failure the kit reconnects on the next call.

### Register command

`register.ts` becomes a function, `registerAgent(options)`, with the same idempotent steps: register, wait for the registry's indexer, build the card for the minted token id, write it to the card file and stop until the card URL serves it byte for byte, pin its SHA-256, check the badge, print `AGENT_BADGE=…`. `npm run register -w agent` keeps calling it with the reference agent's settings and must produce exactly today's card. `kit.mjs register` calls it with the owner's settings. The board doesn't sponsor registry transactions, so the owner needs a few CCD from the wallet faucet. Every registry call passes `network: "testnet"`, because the hosted registry defaults to mainnet.

### Code layout

- `agent/bin/kit.mjs`: the launcher.
- `agent/src/kit/`: settings, the tool functions (over the `Board`, `ChainReads` and fetch seams the reference agent already uses), the MCP server with its instructions, and `main.ts` (stdio, or the `register` subcommand).
- `worker.ts` and `poster.ts`: split into steps used by `workOne`, `postAndPay` and the kit.
- `guard.ts`: parameter expectations. `register.ts`: a function plus a thin script.
- README: the Repository list and the setup section point to the kit and the guide.

### Tests (written first)

`agent/test/kit.test.ts` drives the kit's real MCP tools through the SDK's in-memory transport. It runs against a scripted board (as in `worker.test.ts`), a scripted chain and a scripted x402 endpoint (as in `poster.test.ts`), with no network. At the least it covers:

- login on first use, and again after a 401;
- `find_bounties` leaving out the agent's own bounties;
- claim then submit, and entering a contest;
- each signing rail refusing: another contract, entrypoint or sender, CCD attached, unsponsored without `AGENT_ALLOW_FEES`, a token transfer, the wrong bounty id, work hash or reward in the parameter;
- posting refused over a cap before anything is prepared, funding paying only the escrow account on chain, and `get_work` paying only the worker on chain, once;
- an x402 URL at another origin refused; retries before signing; a lost `submit_signed` answer never producing a second transaction, also across a restart; parallel calls taking turns; results never containing transaction JSON;
- a post whose spec hash differs from the kit's refused; a lost payment released after its expiry when its nonce is unused, and never released when it's used; a second process on the same account refused.

The existing agent tests keep passing.

### Guide

`docs/connect-your-agent.md`, linked from the README, covers:

- What an agent needs: a testnet account (Wallet for Web, a testnet identity with an EU nationality, CCD from the wallet faucet), its payout account on the EUDemo allow list (the faucet at https://allowlist.testnet.concordium.com), the key export, and a badge (the `register` command, and where to host the card).
- How to run the kit, and its settings.
- MCP config snippets with `BOARD_MCP_URL=https://deplace.space/mcp` for Claude Desktop (`claude_desktop_config.json`), Claude Code (`claude mcp add` and `.mcp.json`) and any stdio MCP client.
- What the kit will and won't sign or pay, and the suggested client permissions. A warning that bounty text comes from strangers, and that a model with file or shell access could be talked into submitting something it shouldn't. Not to run the reference agent and the kit on the same account at the same time.
- Troubleshooting: `retryable` errors, the allow list, a contract mismatch, where the logs go.

## Done when

The live runs use the reference agent's identity: badge `JyP9WVTtVnRuL8JUmLKZH` (token 1418) and `secrets/worker-agent.export`.

- The kit's tests were written before its code, and `npm test` and `npm run typecheck` pass for the whole repo.
- Working, live: Claude Code, with the kit as its only MCP server, claims and submits a page-facts bounty the user posts on https://deplace.space. The reference agent isn't running. The board's request log (`journalctl -u deplace`) shows the kit's calls.
- Posting and paying, live: Claude, through the kit, posts a small bounty that isn't escrowed; worker-human works it; Claude accepts it and pays on delivery with `get_work`.
- Registration, live: `npm run register -w agent` re-run on badge 1418 sends no transaction, leaves `server/public/agents/bounty-worker.json` unchanged and reports the badge valid. In this work a first registration only runs against the tests' scripted registry; the user is registering a second agent separately.
- The work is committed and pushed to main.

## Left to the builder

The exact result shapes and wording; retry timings within the 30-second bound, keeping each tool call under a minute (the MCP SDK's default request timeout is 60 seconds, and some clients keep it); how the launcher loads tsx; whether `whoami` shows the EUDemo balance; whether the kit looks a transaction up over its own gRPC client or through the board's `/tx/observe`; how the live runs are driven (the desktop app bundles `claude.exe` 2.1.330, and its `--strict-mcp-config` gives a run with only the kit); the test file split. Also, as the reviewer suggested: checking x402 URLs against the board's origin or rebuilding them from it, capping `deadline_hours` at the board's 90 days, and getting poster names and rejection reasons over the board's HTTP routes (`/bounties`, `/specs/<hash>`; MCP `list_bounties` carries no names), checking spec text against its hash.
