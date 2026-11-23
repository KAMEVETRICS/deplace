import { describe, expect, it } from "vitest";
import { AccountAddress, CcdAmount, SequenceNumber, Transaction, TransactionExpiry } from "@concordium/web-sdk";
import type { WalletApi } from "@concordium/browser-wallet-api-helpers";
import type { Prepared } from "../src/types.js";
import { sendPrepared, signChallenge } from "../src/wallet.js";

const addr = (fill: number) => AccountAddress.fromBuffer(new Uint8Array(32).fill(fill).buffer);
const me = addr(1);

/** A sponsored transfer, as the board prepares one for the person to sign. */
function sponsoredTransfer(): Prepared {
  const tx = Transaction.transfer({ amount: CcdAmount.fromMicroCcd(1n), toAddress: addr(2) })
    .addMetadata({ sender: me, nonce: SequenceNumber.create(1), expiry: TransactionExpiry.futureMinutes(5) })
    .addSponsor(addr(3))
    .build();
  return { txJson: Transaction.toJSONString(tx), feeSponsored: true, sender: me.address, expiresAt: 0 };
}

/** Concordium Wallet for Web refusing every request the way its page API does: `throw new Error(response.message)`. */
const refusing = (message: string) =>
  ({
    sendSponsoredTransaction: async () => {
      throw new Error(message);
    },
    signMessage: async () => {
      throw new Error(message);
    },
  }) as unknown as WalletApi;

describe("wallet requests", () => {
  it("tells the person to unlock the wallet when it answers 'Site is not whitelisted'", async () => {
    await expect(sendPrepared(refusing("Site is not whitelisted"), me.address, sponsoredTransfer(), null)).rejects.toThrow(/Unlock the wallet/);
  });

  it("gives the same advice when the refusal comes while signing in", async () => {
    await expect(signChallenge(refusing("Site is not whitelisted"), me.address, "Deplace/v1/login:n1")).rejects.toThrow(/Unlock the wallet/);
  });

  it("passes any other refusal through as the wallet worded it", async () => {
    await expect(sendPrepared(refusing("User rejected the request"), me.address, sponsoredTransfer(), null)).rejects.toThrow("User rejected the request");
  });
});
