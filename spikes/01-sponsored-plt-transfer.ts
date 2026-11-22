// Spike 01: poster sends 1 EUDemo to worker-agent with memo "spike:1"; sponsor pays the fee.
// Run: npx tsx spikes/01-sponsored-plt-transfer.ts
import { Transaction } from "@concordium/web-sdk";
import { CborAccountAddress, CborMemo, Token, TokenAmount, TokenId, createTokenUpdatePayload } from "@concordium/web-sdk/plt";
import { describeOutcome, grpc, loadWallet, sponsoredSend } from "./lib.ts";

const client = grpc();
const tokenId = TokenId.fromString(process.env.REWARD_TOKEN_ID ?? "EUDemo");
const token = await Token.fromId(client, tokenId);
const decimals = token.info.state.decimals;
console.log(`token ${TokenId.toString(tokenId)}: decimals=${decimals}`);

const poster = loadWallet("poster");
const worker = loadWallet("worker-agent");
const sponsor = loadWallet("sponsor");

const payload = createTokenUpdatePayload(tokenId, {
  transfer: {
    amount: TokenAmount.fromDecimal(1, decimals),
    recipient: CborAccountAddress.fromAccountAddress(worker.address),
    memo: CborMemo.fromString("spike:1"),
  },
});

const { outcome } = await sponsoredSend(client, Transaction.tokenUpdate(payload), poster, sponsor);
console.log(describeOutcome(outcome));
