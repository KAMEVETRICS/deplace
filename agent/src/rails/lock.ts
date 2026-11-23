import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

/** Another live process signs for this account. */
export class LockHeld extends Error {
  constructor(
    readonly holderPid: number,
    file: string,
  ) {
    super(`another process (pid ${holderPid}) is already signing for this account (lock file ${file}); stop it, or use one kit or agent per account`);
    this.name = "LockHeld";
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}

function unlinkIfThere(file: string) {
  try {
    unlinkSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** Locks this process holds, released together when it exits. */
const held = new Set<AccountLock>();
let releaseOnExit = false;

/**
 * One signer per account. Two processes signing for one account would collide on nonces and
 * overwrite each other's budget file, which would let the spending caps be bypassed.
 */
export class AccountLock {
  private readonly pid: number;
  private readonly isAlive: (pid: number) => boolean;

  constructor(
    readonly file: string,
    o: { pid?: number; isAlive?: (pid: number) => boolean } = {},
  ) {
    this.pid = o.pid ?? process.pid;
    this.isAlive = o.isAlive ?? alive;
  }

  /** Takes the lock, or throws LockHeld naming the live process that has it. A lock left by a process that is gone is taken over. */
  acquire(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.file, "wx");
        try {
          writeSync(fd, JSON.stringify({ pid: this.pid, since: new Date().toISOString() }));
        } finally {
          closeSync(fd);
        }
        this.remember();
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const holder = this.holder();
      if (holder === this.pid) {
        this.remember();
        return;
      }
      if (holder !== null && this.isAlive(holder)) throw new LockHeld(holder, this.file);
      unlinkIfThere(this.file); // left by a process that is gone, or not a lock file anyone can read
    }
    throw new Error(`could not take the lock ${this.file}`);
  }

  /** Removes the lock file, only when this process holds it. */
  release(): void {
    held.delete(this);
    if (this.holder() === this.pid) unlinkIfThere(this.file);
  }

  private remember() {
    held.add(this);
    if (!releaseOnExit) {
      releaseOnExit = true;
      process.once("exit", () => {
        for (const lock of held) lock.release();
      });
    }
  }

  /** The pid in the lock file, or null when there is no file or it cannot be read as a lock. */
  private holder(): number | null {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    let pid: unknown;
    try {
      pid = (JSON.parse(text) as { pid?: unknown }).pid;
    } catch {
      return null; // not JSON: nobody can hold it
    }
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
  }
}

/** The account's lock file, next to the pending records. */
export function lockFileFor(pendingFile: string, account: string): string {
  return join(dirname(pendingFile), `agent-${account}.lock`);
}
