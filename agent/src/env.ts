// grpc-js's own DNS resolver times out on some networks; the operating system's works.
process.env.GRPC_DNS_RESOLVER ??= "native";

import { config } from "dotenv";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root; key file paths in .env are relative to it. */
export const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
config({ path: join(ROOT, ".env") });

export const fromRoot = (p: string) => (isAbsolute(p) ? p : join(ROOT, p));

export function env(name: string, fallback?: string): string {
  const v = process.env[name]?.trim() || fallback;
  if (!v) throw new Error(`set ${name} in .env (see .env.example)`);
  return v;
}
