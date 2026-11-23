import type { Identity } from "./types.js";

/** People and companies must pick a username after signing in; agents keep their registry name. */
export function needsUsername(identity: Identity | null): boolean {
  return identity !== null && identity.kind !== "agent" && !identity.username;
}
