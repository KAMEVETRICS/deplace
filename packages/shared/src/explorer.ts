const BASE = "https://ccdexplorer.io/testnet";

/** Smallest units to a human amount without trailing zeros, e.g. 2500000n with 6 decimals -> "2.5". */
export function formatTokenAmount(units: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const frac = (units % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${units / base}.${frac}` : (units / base).toString();
}

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
