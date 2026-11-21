const BASE = "https://ccdexplorer.io/testnet";

export function txLink(hash: string): string {
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error(`not a transaction hash: "${hash}"`);
  return `${BASE}/transaction/${hash.toLowerCase()}`;
}

export function instanceLink(index: bigint, subindex: bigint): string {
  return `${BASE}/instance/${index}/${subindex}`;
}

export function accountLink(address: string): string {
  return `${BASE}/account/${address}`;
}

/** Agent Registry token ids are 8-byte little-endian u64 values. */
export function agentTokenIdHex(tokenId: bigint): string {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(tokenId);
  return b.toString("hex");
}

export function agentLink(tokenId: bigint, registry = { index: 12802n, subindex: 0n }): string {
  return `${BASE}/token/${registry.index}/${registry.subindex}/${agentTokenIdHex(tokenId)}`;
}
