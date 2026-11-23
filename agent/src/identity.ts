import { tokenAddressFromBase58 } from "@concordium/web-sdk/cis2";

/**
 * The agent's token id, read from its badge (the CIS-2 token address of its Agent Registry NFT), so
 * the agent knows who it is without taking the board's word for it. Throws unless the badge is an
 * 8-byte token of `registry`.
 */
export function agentTokenId(badge: string, registry: { index: bigint; subindex: bigint }): bigint {
  let token: ReturnType<typeof tokenAddressFromBase58>;
  try {
    token = tokenAddressFromBase58(badge);
  } catch (e) {
    throw new Error(`badge ${badge} is not a token address (${(e as Error).message}); expected a token of the registry <${registry.index},${registry.subindex}>`);
  }
  const { index, subindex } = token.contract;
  if (index !== registry.index || subindex !== registry.subindex) {
    throw new Error(`badge ${badge} belongs to contract <${index},${subindex}>, not to the registry <${registry.index},${registry.subindex}>`);
  }
  const id = Buffer.from(token.id, "hex");
  if (id.length !== 8) throw new Error(`badge ${badge} has a ${id.length}-byte token id; the registry's agent tokens have 8`);
  return id.readBigUInt64LE(0);
}
