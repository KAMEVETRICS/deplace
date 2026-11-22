# Day-1 testnet checks

Run each once the accounts in `docs/setup-accounts.md` exist. Record what happened; later code copies the call shapes that work.

| Check | Script | Result | Notes |
|---|---|---|---|
| Accounts ready (CCD, EUDemo allow list, key exports) | `npx tsx spikes/00-check-accounts.ts` | 22 Nov: all five exist with 20,000 CCD, on the EUDemo allow list, at least 100 EUDemo each; all five key exports match | |
| Sponsored PLT transfer (EUDemo, memo) | `npx tsx spikes/01-sponsored-plt-transfer.ts` | 22 Nov: works. [4e2b8878](https://ccdexplorer.io/testnet/transaction/4e2b8878cd4ce0605faccf6977cf3603d3c5b81da46c53d57dabc97cf42d9b74): poster to worker-agent 1 EUDemo, memo `spike:1` arrives as CBOR text (`677370696b653a31`); sender cost 0, sponsor paid 6.24 CCD for 807 energy | fixed `TokenId.toString` (does not exist in web-sdk 12; use `.value`) |
| Sponsored contract update (CIS-8004 register paid by our sponsor) | `spikes/03-register-agent.ts register` | not run yet | covers spike 02 |
| Agent registration, badge, pinned card hash, badge check | `spikes/03-register-agent.ts card/register/badge/pin/check` (now `npm run register -w agent`) | not run yet | needs a public AGENT_CARD_URL |
| x402 `exact` payment in EUDemo through our facilitator | `npx tsx spikes/04-x402-payment.ts` | 22 Nov: works. HTTP 200 after payment; [7cf26865](https://ccdexplorer.io/testnet/transaction/7cf268658c64cdd313304ba6c0377858c2ff00d19526658157d2de4e93a3847b): poster to worker-agent 1 EUDemo, no memo, sender cost 0, sponsor paid 6.11 CCD | needs explicit EUDemo spend controls (a default x402 client refuses it) |
| Browser wallet signs a sponsored contract call | web app, manual | not run yet | `sendSponsoredTransaction` with the module schema |
| `getAgentWallet` return format | first agent login | not run yet | decoder accepts Option<AccountAddress> and Option<Address> |
| Contract deploy and init (operator pays, not sponsored) | `npx tsx scripts/deploy.ts` | 22 Nov: works. Module [0e0b8945](https://ccdexplorer.io/testnet/transaction/0e0b8945149aaa7f7896e0515c14e07550c067cf9dac42b9e83304da3f9ea797) `02f65a2e…ffc8` (96,353 energy, 744.5 CCD); instance [<13123,0>](https://ccdexplorer.io/testnet/instance/13123/0) init [f44a4dcb](https://ccdexplorer.io/testnet/transaction/f44a4dcbf6decf809a460b397fb6ce65600377a9709a650c42e0b2fbe619335e), 3-day windows; `view_config` decodes with the shared codec and the attestor matches `secrets/attestor.key` | the summary reports the module reference as a hex string; `deploy.ts` now derives it from the file (SHA-256) and skips redeploying a module already on chain |
