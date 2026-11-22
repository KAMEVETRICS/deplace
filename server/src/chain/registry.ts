import { AccountAddress, ContractAddress, Parameter, ReceiveName, ReturnValue, type ConcordiumGRPCClient } from "@concordium/web-sdk";
import type { ContractRef } from "@deplace/shared";
import { bigintJson } from "./grpc.js";

/** CIS-8004 rejects with AgentNotFound (-7200) for an unknown token id. */
const AGENT_NOT_FOUND = -7200;

/**
 * Reads the agent's payment-routing wallet (`agentWallet`) straight from the Agent Registry
 * contract on chain. Null when unset (e.g. after a transfer) or when the agent does not exist.
 */
export async function registryAgentWallet(client: Pick<ConcordiumGRPCClient, "invokeContract">, registry: ContractRef, tokenId: bigint): Promise<string | null> {
  // CIS-2 token id for a u64: one length byte (8) then the 8 bytes little-endian.
  const param = Buffer.alloc(9);
  param[0] = 8;
  param.writeBigUInt64LE(tokenId, 1);
  const res = await client.invokeContract({
    contract: ContractAddress.create(registry.index, registry.subindex),
    method: ReceiveName.fromString("CIS-8004.getAgentWallet"),
    parameter: Parameter.fromBuffer(param.buffer.slice(param.byteOffset, param.byteOffset + param.length)),
  });
  if (res.tag === "failure") {
    const reason = res.reason as { tag?: string; rejectReason?: number } | null;
    if (reason?.tag === "RejectedReceive" && reason.rejectReason === AGENT_NOT_FOUND) return null;
    throw new Error(`CIS-8004.getAgentWallet rejected: ${JSON.stringify(reason, bigintJson)}`);
  }
  const b = res.returnValue ? ReturnValue.toBuffer(res.returnValue) : new Uint8Array();
  if (b.length === 1 && b[0] === 0) return null;
  // Option<AccountAddress> is 1 + 32 bytes; Option<Address> with the Account variant is 1 + 1 + 32.
  const raw = b.length === 33 && b[0] === 1 ? b.subarray(1) : b.length === 34 && b[0] === 1 && b[1] === 0 ? b.subarray(2) : null;
  if (!raw) throw new Error(`unexpected getAgentWallet return value ${Buffer.from(b).toString("hex")}`);
  return AccountAddress.fromBuffer(raw.slice().buffer).address;
}
