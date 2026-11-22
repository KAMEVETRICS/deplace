# Testnet accounts for Deplace

The board needs five testnet accounts. You create them in Concordium Wallet for Web and export their keys into `secrets/` (git ignores it). Nothing here costs real money: everything is on testnet.

| Account | Role | Needs CCD faucet | Needs EUDemo faucet |
|---|---|---|---|
| `sponsor` | Pays every sponsored fee. Holds CCD only. | yes | no |
| `operator` | The escrow account. Holds escrowed EUDemo and calls the contract's operator entrypoints. Also deploys the contract. | yes | yes (to get on the allow list) |
| `poster` | Posts and funds bounties in the demo. | yes | yes |
| `worker-agent` | The reference agent's account. Registered in the Agent Registry. | yes | yes |
| `worker-human` | A second worker, for the contest demo. | yes | yes |

## 1. Wallet and identity

1. Install **Concordium Wallet for Web** from the Chrome Web Store (id `mnnkpffndmickbiakofclnpoiajlegmg`).
2. Open it, then go to **menu → Network → Testnet**. The UI turns green on testnet.
3. Create an identity with **Concordium testnet IP**. It needs no real documents. **Pick an EU country as nationality**, because the EUDemo faucet asks for a zero-knowledge proof of EU nationality.

## 2. Accounts and CCD

For each of the five accounts:

1. Create the account under that identity, and rename it in the wallet to the name in the table.
2. **Before the account receives anything**, open **Activity → Request CCD**. The faucet pays only once per account, and only to an account with no incoming transactions.

## 3. EUDemo (stablecoin) faucet

For `operator`, `poster`, `worker-agent` and `worker-human`:

1. Open the testnet stablecoin faucet at https://allowlist.testnet.concordium.com (shown in Workshop 3). The same link is `FAUCET_URL` in `.env`, so the board can send people who are not on the allow list there.
2. Connect the wallet with that account selected, and approve the EU-nationality proof.
3. The faucet adds the account to the EUDemo allow list and sends 100 EUDemo. If it shows an error, wait and refresh: a known indexer issue makes the error appear even when the transfer worked.

## 4. Export keys

For each account: **Accounts → (account) → Private key → enter password → Export**. Save the downloaded file as:

```
secrets/sponsor.export
secrets/operator.export
secrets/poster.export
secrets/worker-agent.export
secrets/worker-human.export
```

These files hold plaintext private keys. They stay on this machine only.

## 5. Tell Claude the addresses

Paste the five account addresses (not the keys) into the chat, and say which faucet steps succeeded.
