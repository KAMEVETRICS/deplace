export type Eligibility = { ok: true } | { ok: false; reason: string; faucetUrl: string | null };

/**
 * EUDemo has an allow list: a transfer fails unless sender and receiver are both on it.
 * Refuse claims and entries up front, so nobody does work they cannot be paid for.
 */
export async function checkPayoutEligible(
  isOnAllowList: (account: string) => Promise<boolean>,
  account: string,
  faucetUrl: string | null,
): Promise<Eligibility> {
  if (await isOnAllowList(account)) return { ok: true };
  return {
    ok: false,
    faucetUrl,
    reason: `account ${account} is not on the reward token's allow list, so it cannot be paid; claim once from the stablecoin faucet first`,
  };
}
