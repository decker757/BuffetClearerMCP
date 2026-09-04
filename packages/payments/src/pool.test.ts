import { describe, expect, it } from "vitest";
import { WalletPool, type PoolEntry } from "./pool.js";
import { PolicyError } from "./types.js";

const entries = (): PoolEntry[] => [
  { seed: "s1", address: "r1", state: "idle" },
  { seed: "s2", address: "r2", state: "idle" },
];

describe("wallet pool", () => {
  it("hands out idle wallets, marks them funded, and refuses when exhausted", () => {
    const pool = new WalletPool(entries());
    const a = pool.acquire("s_1");
    const b = pool.acquire("s_2");
    expect(new Set([a.address, b.address])).toEqual(new Set(["r1", "r2"]));
    expect(pool.counts()).toMatchObject({ idle: 0, funded: 2 });
    expect(() => pool.acquire("s_3")).toThrow(PolicyError);
    try {
      pool.acquire("s_3");
    } catch (e) {
      expect((e as PolicyError).rule).toBe("pool_exhausted");
    }
  });

  it("walks the lifecycle and returns to idle without the session id", () => {
    const pool = new WalletPool(entries());
    const w = pool.acquire("s_1");
    pool.transition(w.address, "paying");
    pool.transition(w.address, "sweeping");
    pool.transition(w.address, "idle");
    expect(pool.counts().idle).toBe(2);
    expect(pool.status().find((s) => s.address === w.address)).toEqual({ address: w.address, state: "idle" });
  });

  it("marks wallets stuck mid-session as attention on load, never hands them out", () => {
    const stuck: PoolEntry[] = [
      { seed: "s1", address: "r1", state: "paying", session_id: "dead" },
      { seed: "s2", address: "r2", state: "idle" },
    ];
    const persisted: PoolEntry[][] = [];
    const pool = new WalletPool(stuck, (all) => persisted.push(structuredClone(all)));
    expect(pool.counts()).toMatchObject({ attention: 1, idle: 1 });
    expect(pool.acquire("s_new").address).toBe("r2");
    expect(() => pool.acquire("s_more")).toThrow(/pool_exhausted/);
    expect(persisted.length).toBeGreaterThan(0);
  });

  it("refuses illegal transitions and only repair() leaves attention", () => {
    const pool = new WalletPool(entries());
    const w = pool.acquire("s_1");
    expect(() => pool.transition(w.address, "idle")).not.toThrow(); // funded -> idle allowed (authorise failed)
    const w2 = pool.acquire("s_2");
    pool.transition(w2.address, "paying");
    expect(() => pool.transition(w2.address, "idle")).toThrow(/illegal pool transition/);
    pool.transition(w2.address, "attention");
    expect(() => pool.transition(w2.address, "idle")).toThrow(/illegal pool transition/);
    expect(() => pool.acquire("s_3")).not.toThrow(); // w is idle again
    pool.repair(w2.address);
    expect(pool.counts()).toMatchObject({ attention: 0 });
  });

  it("stale() measures from funding time, not the last hop, and hides seeds", () => {
    const pool = new WalletPool(entries());
    const w = pool.acquire("s_1");
    pool.transition(w.address, "paying");
    const s = pool.stale(-1);
    expect(s).toHaveLength(1);
    expect(JSON.stringify(s)).not.toContain("s1");
    expect(pool.seedOf(w.address)).toBe("s1");
  });

  it("status never exposes seeds", () => {
    const pool = new WalletPool(entries());
    expect(JSON.stringify(pool.status())).not.toContain("s1");
  });

  it("finds stale funded wallets for the expiry sweep", () => {
    const pool = new WalletPool(entries());
    const w = pool.acquire("s_1");
    expect(pool.stale(60_000)).toHaveLength(0);
    expect(pool.stale(-1)).toHaveLength(1);
    expect(pool.stale(-1)[0]!.address).toBe(w.address);
  });

  it("persists atomically through fromFile", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buffet-pool-"));
    const file = path.join(dir, "pool.json");
    fs.writeFileSync(file, JSON.stringify(entries()));
    const pool = WalletPool.fromFile(file);
    pool.acquire("s_1");
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Array<{ state: string }>;
    expect(saved.filter((e) => e.state === "funded")).toHaveLength(1);
    expect(fs.readdirSync(dir)).toEqual(["pool.json"]); // no leftover temp file
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
