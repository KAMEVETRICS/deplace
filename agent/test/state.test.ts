import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AccountLock, LockHeld, lockFileFor } from "../src/rails/lock.js";
import { PendingStore, type PendingPayment, type PendingTx } from "../src/rails/pending.js";

const tmp = (prefix: string, name: string) => join(mkdtempSync(join(tmpdir(), prefix)), name);
const tx = (hash: string): PendingTx => ({ kind: "tx", action: "claim", bountyId: "5", hash, expiresAt: 1 });
const payment: PendingPayment = { kind: "payment", purpose: "deliver", bountyId: "9", ref: "bounty:9", nonce: "7", amount: "1000000", expiresAt: 2 };

describe("pending records", () => {
  it("are on disk as soon as add returns, and survive a restart", () => {
    const file = tmp("pending-", "p.json");
    new PendingStore(file).add(tx("aa".repeat(32)));
    expect(new PendingStore(file).list()).toEqual([tx("aa".repeat(32))]);
  });

  it("removes only the records that match", () => {
    const file = tmp("pending-", "p.json");
    const store = new PendingStore(file);
    store.add(tx("aa".repeat(32)));
    store.add(payment);
    expect(store.remove((r) => r.kind === "tx" && r.hash === "aa".repeat(32))).toBe(1);
    expect(store.list()).toEqual([payment]);
    expect(new PendingStore(file).list()).toEqual([payment]);
    expect(store.remove(() => false)).toBe(0);
  });

  it("refuses a file it can't read instead of forgetting what it holds", () => {
    const file = tmp("pending-", "p.json");
    writeFileSync(file, "{");
    expect(() => new PendingStore(file)).toThrow(/p\.json/);
  });

  it("starts empty without a file, and keeps nothing on disk when it has no file", () => {
    expect(new PendingStore(tmp("pending-", "missing.json")).list()).toEqual([]);
    const memory = new PendingStore(null);
    memory.add(tx("bb".repeat(32)));
    expect(memory.list()).toHaveLength(1);
  });
});

describe("account lock", () => {
  it("lets one process sign for an account and names it to the next", () => {
    const f = tmp("lock-", "agent-x.lock");
    new AccountLock(f, { pid: 100, isAlive: () => true }).acquire();
    let held: unknown;
    try {
      new AccountLock(f, { pid: 200, isAlive: () => true }).acquire();
    } catch (e) {
      held = e;
    }
    expect(held).toBeInstanceOf(LockHeld);
    expect((held as LockHeld).holderPid).toBe(100);
    expect((held as LockHeld).message).toMatch(/100/);
  });

  it("takes over a lock left by a process that is gone", () => {
    const f = tmp("lock-", "agent-x.lock");
    new AccountLock(f, { pid: 100, isAlive: () => true }).acquire();
    expect(() => new AccountLock(f, { pid: 200, isAlive: (pid) => pid !== 100 }).acquire()).not.toThrow();
    expect(() => new AccountLock(f, { pid: 300, isAlive: () => true }).acquire()).toThrow(LockHeld);
  });

  it("takes over a lock file it can't read", () => {
    const f = tmp("lock-", "agent-x.lock");
    writeFileSync(f, "not json");
    expect(() => new AccountLock(f, { pid: 200, isAlive: () => true }).acquire()).not.toThrow();
  });

  it("is taken again by its holder, and released only by it", () => {
    const f = tmp("lock-", "agent-x.lock");
    const holder = new AccountLock(f, { pid: 100, isAlive: () => true });
    holder.acquire();
    expect(() => holder.acquire()).not.toThrow();
    new AccountLock(f, { pid: 200, isAlive: () => true }).release();
    expect(existsSync(f)).toBe(true);
    holder.release();
    expect(existsSync(f)).toBe(false);
  });

  it("sits next to the pending records, one per account", () => {
    expect(lockFileFor(join("C:\\data", "agent-pending.json"), "4S3U")).toBe(join("C:\\data", "agent-4S3U.lock"));
  });
});
