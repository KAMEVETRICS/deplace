# Day-1 testnet checks

Run each once the accounts in `docs/setup-accounts.md` exist. Record what happened; later code copies the call shapes that work.

| Check | Script | Result | Notes |
|---|---|---|---|
| Sponsored PLT transfer (EUDemo, memo) | `npx tsx spikes/01-sponsored-plt-transfer.ts` | not run yet | |
| Sponsored contract update (CIS-8004 register paid by our sponsor) | `spikes/03-register-agent.ts register` | not run yet | covers spike 02 |
| Agent registration, badge, pinned card hash, badge check | `spikes/03-register-agent.ts card/register/badge/pin/check` (now `npm run register -w agent`) | not run yet | needs a public AGENT_CARD_URL |
| x402 `exact` payment in EUDemo through our facilitator | `npx tsx spikes/04-x402-payment.ts` | not run yet | |
| Browser wallet signs a sponsored contract call | web app, manual | not run yet | `sendSponsoredTransaction` with the module schema |
| `getAgentWallet` return format | first agent login | not run yet | decoder accepts Option<AccountAddress> and Option<Address> |
