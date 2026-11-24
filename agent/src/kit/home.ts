import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Where the kit keeps its records when it runs from the npm package, and where its relative paths
 * start: DEPLACE_HOME, or .deplace in the user's home folder. A clone keeps them in its data/
 * folder instead. npx runs the package from a cache that can be wiped at any time, and these
 * records (spending, unsettled transactions, the account lock) are what stop the kit paying twice,
 * so they can't live next to the code.
 */
export function kitHome(env: Record<string, string | undefined>, home: string = homedir()): string {
  const own = env.DEPLACE_HOME?.trim();
  if (!own) return join(home, ".deplace");
  if (!isAbsolute(own)) throw new Error(`DEPLACE_HOME must be an absolute path, such as ${join(home, ".deplace")}; got "${own}"`);
  return join(own);
}
