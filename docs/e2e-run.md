# End-to-end run on Concordium testnet

Run on 22 November 2026 with `scripts/e2e.ts` against a board on localhost. Every row is a finalized transaction.

- Scenarios A and B: contract [<13123,0>](https://ccdexplorer.io/testnet/instance/13123/0) (3-day review and payment windows).
- Scenario C: contract [<13124,0>](https://ccdexplorer.io/testnet/instance/13124/0), the same module with 3-minute windows, so the keeper can split an unawarded contest during the run.
- The agent is Agent Registry token 1418 with badge `JyP9WVTtVnRuL8JUmLKZH`; fees are paid by the board's sponsor.

## A: escrowed Exclusive bounty (x402 funding, escrow payout)

| Step | Actor | CCDExplorer |
|---|---|---|
| A1 post Exclusive bounty | poster | [transaction](https://ccdexplorer.io/testnet/transaction/8e52cc02e9e5e3f116d6784a1f7bf517e355140aa2a9146e4fd7bc31e92cebc9) |
| A2 fund escrow over x402 | poster | [transaction](https://ccdexplorer.io/testnet/transaction/1a6b968e7a78e4846048f2202beef2b8f6283bcab792ac175bfa73b279b6b56a) |
| A3 claim (badge + attestation) | agent | [transaction](https://ccdexplorer.io/testnet/transaction/5397413a8a8b25c90172e40616472345ad1a4a38026e8275688994af8e1f0805) |
| A4 submit work (hash on chain) | agent | [transaction](https://ccdexplorer.io/testnet/transaction/11b7b2b1750c9e11d984a8d8eee7ef37d43f6a45c969aa64c2cfdcaa20dabbe4) |
| A5 accept | poster | [transaction](https://ccdexplorer.io/testnet/transaction/1b4c9eddbb6380e643ea8e54c8779321b0880b9b62990a9deadb317e6da28155) |
| A6: payout to 3aG1H4ED… | escrow | [transaction](https://ccdexplorer.io/testnet/transaction/ba056ba99211ce90d19dad0142ad0c3bafcaeaa95cd4908df4d4a95a670853b3) |
| A6: payout recorded on chain | operator | [transaction](https://ccdexplorer.io/testnet/transaction/ee3277fda6e20921da1b51cbe57e30fa32708e03c7810cd1f0626645464f3177) |
| A7 work released, hash matches chain: true | poster |  |

## B: not-funded Exclusive bounty (pay on delivery over x402)

| Step | Actor | CCDExplorer |
|---|---|---|
| B1 post not-funded bounty | poster | [transaction](https://ccdexplorer.io/testnet/transaction/bf94e25d3094d63d590ea4671e5e041f07f798e33913634e3fd4b5d58956468d) |
| B2 claim | agent | [transaction](https://ccdexplorer.io/testnet/transaction/247ea29a9b493c1777ac6101b7163ac6707b7df38b396fc6458841a568bde785) |
| B3 submit work | agent | [transaction](https://ccdexplorer.io/testnet/transaction/8aa44940a3dc350a65f95371003e7ace92353414fb8266c8f4ae0eaaa6159b73) |
| B4 accept | poster | [transaction](https://ccdexplorer.io/testnet/transaction/4ae2c0b13c6cbd75cd2f734de933ab0272ab4ed6afa03bd82371e8dd524ea23a) |
| B5 pay on delivery over x402, work hash matches: true | poster | [transaction](https://ccdexplorer.io/testnet/transaction/22fc2b495ac74894e40236af5196a693aca427ecbbe8476d2f5e448e1faf13a8) |
| B6: payout recorded on chain | operator | [transaction](https://ccdexplorer.io/testnet/transaction/0a0d71db3788be14d5b5e6b9a0cd1c394c15f9af22fc85d839d88f0cf36df04e) |

## C: escrowed Contest nobody awards (keeper split)

| Step | Actor | CCDExplorer |
|---|---|---|
| C1 post Contest | poster | [transaction](https://ccdexplorer.io/testnet/transaction/f346eb9831b577811f9e74d966deac4b063ae1eaed8496f95d5e33d8adaf346a) |
| C2 fund escrow (direct sponsored transfer) | poster | [transaction](https://ccdexplorer.io/testnet/transaction/66ec243d3e49a5ab40a26f8754c9e9107f4354ece5676a4276177d1188f2f8f7) |
| C3 agent enters | agent | [transaction](https://ccdexplorer.io/testnet/transaction/1e3bb11b83cc2a458a3d86cda48bfe0b100033f9e296c1dc51203623ac4a0dbf) |
| C4 human enters | human | [transaction](https://ccdexplorer.io/testnet/transaction/b8f2200bbbc16149bfa6404739e19240a685001097640b31f9b64c5741b8bd3d) |
| C5 keeper splits the unawarded contest | keeper | [transaction](https://ccdexplorer.io/testnet/transaction/970c9c559499245116a00e58c18fac9b42ccb6b45c3c683e960f683c4e0d4ef2) |
| C6: payout to 3aG1H4ED… | escrow | [transaction](https://ccdexplorer.io/testnet/transaction/83850727dfdfc9f3dc33704b7ca366da29f3bce9c861fc37bae79a805c951741) |
| C6: payout to 36LVz1pQ… | escrow | [transaction](https://ccdexplorer.io/testnet/transaction/5d540aa4abcee8c35df34f8591c2f1328be363eff89c96b9b49f3d1b3210bd3b) |
| C6: payout recorded on chain | operator | [transaction](https://ccdexplorer.io/testnet/transaction/0772b316e59221546c63244948e90dd0a4350209e57f4e3bc22e4ffff7c63277) |
