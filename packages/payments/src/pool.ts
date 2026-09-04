import fs from "node:fs";
import path from "node:path";
import { PolicyError } from "./types.js";

/**
 * Session wallet pool (CLAUDE.md §15.5). Pre-provisioned by scripts/provision.ts;
 * this class only hands wallets out and tracks state. Seeds stay in the file and in
 * memory; they never leave this module except into the signer.
 *
 *   idle -> funded -> paying -> sweeping -> idle
 *                                  \-> attention (sweep failed; needs a human)
 *   attention -> idle only via `repair()`, an explicit operator action.
 *
 * Several processes share the file (Claude Desktop launches more than one server).
 * Every mutation therefore takes a lock, re-reads the file, changes only the entry
 * it is about, and writes atomically. Reads re-read the file too. A process never
 * writes back its own stale picture of wallets it does not hold.
 */
export type PoolState = "idle" | "funded" | "paying" | "sweeping" | "attention";

const ALLOWED: Record<PoolState, PoolState[]> = {
  idle: ["funded"],
  funded: ["paying", "sweeping", "attention", "idle"],
  paying: ["sweeping", "attention"],
  sweeping: ["idle", "attention"],
  attention: [],
};

export interface PoolEntry {
  seed: string;
  address: string;
  state: PoolState;
  session_id?: string;
  /** when the wallet was handed out; the expiry sweep measures from here */
  funded_at?: string;
  since?: string;
  /** which process holds it, for diagnostics only */
  owner?: string;
}

export interface PoolWallet {
  address: string;
  seed: string;
}

export interface PoolOptions {
  /** Mark funded/paying/sweeping wallets as attention on construction. Right for a single
   *  in-memory pool after a crash; wrong for a file shared with live processes. */
  parkStuckOnLoad?: boolean;
  /** Backing file shared between processes; every mutation locks, re-reads and rewrites it. */
  file?: string;
}

const LOCK_RETRIES = 60;
const LOCK_WAIT_MS = 25;
const LOCK_STALE_MS = 10_000;

export class WalletPool {
  private entries: PoolEntry[];
  private readonly file: string | undefined;
  private readonly owner = `${process.pid}`;

  constructor(entries: PoolEntry[], persist?: (entries: PoolEntry[]) => void, opts: PoolOptions = {}) {
    this.file = opts.file;
    this.entries = entries.map((e) => ({ ...e, state: e.state ?? "idle" }));
    if (opts.parkStuckOnLoad ?? true) {
      for (const e of this.entries) {
        if (e.state === "funded" || e.state === "paying" || e.state === "sweeping") e.state = "attention";
      }
    }
    this.persistFn = persist;
    this.persistFn?.(this.entries);
  }

  private persistFn: ((entries: PoolEntry[]) => void) | undefined;

  /** File-backed pool shared between processes. Wallets other processes hold are left alone. */
  static fromFile(file: string): WalletPool {
    const entries = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as PoolEntry[]) : [];
    return new WalletPool(entries, undefined, { parkStuckOnLoad: false, file });
  }

  get size(): number {
    return this.read().length;
  }

  counts(): Record<PoolState, number> {
    const c: Record<PoolState, number> = { idle: 0, funded: 0, paying: 0, sweeping: 0, attention: 0 };
    for (const e of this.read()) c[e.state] += 1;
    return c;
  }

  /** Public view for the snapshot: addresses and states, never seeds. */
  status(): Array<{ address: string; state: PoolState; session_id?: string }> {
    return this.read().map(({ address, state, session_id }) => (session_id ? { address, state, session_id } : { address, state }));
  }

  /** Throws PolicyError("pool_exhausted") when nothing is idle: never creates a wallet on the spot. */
  acquire(session_id: string): PoolWallet {
    return this.mutate((entries) => {
      const e = entries.find((x) => x.state === "idle");
      if (!e) throw new PolicyError("pool_exhausted", "no idle session wallet", { counts: countOf(entries) });
      const now = new Date().toISOString();
      e.state = "funded";
      e.session_id = session_id;
      e.funded_at = now;
      e.since = now;
      e.owner = this.owner;
      return { address: e.address, seed: e.seed };
    });
  }

  transition(address: string, to: PoolState): void {
    this.mutate((entries) => {
      const e = byAddress(entries, address);
      if (!ALLOWED[e.state].includes(to)) throw new Error(`illegal pool transition ${e.state} -> ${to} for ${address}`);
      e.state = to;
      e.since = new Date().toISOString();
      if (to === "idle") {
        delete e.session_id;
        delete e.funded_at;
        delete e.owner;
      }
    });
  }

  /** Operator action after a human checked the wallet: attention -> idle. */
  repair(address: string): void {
    this.mutate((entries) => {
      const e = byAddress(entries, address);
      if (e.state !== "attention") throw new Error(`repair: ${address} is ${e.state}, not attention`);
      e.state = "idle";
      delete e.session_id;
      delete e.funded_at;
      delete e.owner;
      e.since = new Date().toISOString();
    });
  }

  /** Seed for a wallet we hold, for the sweeper. Never exposed through status(). */
  seedOf(address: string): string {
    return byAddress(this.read(), address).seed;
  }

  /** Wallets handed out more than `olderThanMs` ago and still not swept: candidates for the expiry sweep. */
  stale(olderThanMs: number): Array<{ address: string; state: PoolState; session_id?: string; funded_at: string }> {
    const cutoff = Date.now() - olderThanMs;
    return this.read()
      .filter((e) => (e.state === "funded" || e.state === "paying") && e.funded_at !== undefined && Date.parse(e.funded_at) < cutoff)
      .map((e) => (e.session_id ? { address: e.address, state: e.state, session_id: e.session_id, funded_at: e.funded_at! } : { address: e.address, state: e.state, funded_at: e.funded_at! }));
  }

  // ---------- storage

  /** Current entries: from disk when file-backed (other processes may have written), else memory. */
  private read(): PoolEntry[] {
    if (this.file && fs.existsSync(this.file)) {
      try {
        this.entries = JSON.parse(fs.readFileSync(this.file, "utf8")) as PoolEntry[];
      } catch {
        /* mid-write by another process: keep the last good copy */
      }
    }
    return this.entries;
  }

  /** Lock, re-read, mutate, write atomically, unlock. In-memory pools just mutate. */
  private mutate<T>(fn: (entries: PoolEntry[]) => T): T {
    if (!this.file) {
      const out = fn(this.entries);
      this.persistFn?.(this.entries);
      return out;
    }
    const lock = `${this.file}.lock`;
    acquireLock(lock);
    try {
      const entries = this.read();
      const out = fn(entries);
      atomicWrite(this.file, JSON.stringify(entries, null, 2));
      this.entries = entries;
      return out;
    } finally {
      try {
        fs.rmSync(lock, { force: true });
      } catch {
        /* nothing */
      }
    }
  }
}

function countOf(entries: PoolEntry[]): Record<PoolState, number> {
  const c: Record<PoolState, number> = { idle: 0, funded: 0, paying: 0, sweeping: 0, attention: 0 };
  for (const e of entries) c[e.state] += 1;
  return c;
}

function byAddress(entries: PoolEntry[], address: string): PoolEntry {
  const e = entries.find((x) => x.address === address);
  if (!e) throw new Error(`wallet ${address} is not in the pool`);
  return e;
}

/** Exclusive-create lock file with bounded retries; a lock older than LOCK_STALE_MS is a dead process. */
function acquireLock(lock: string): void {
  for (let i = 0; i < LOCK_RETRIES; i += 1) {
    try {
      fs.writeFileSync(lock, `${process.pid} ${Date.now()}`, { flag: "wx" });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      sleepSync(LOCK_WAIT_MS);
    }
  }
  throw new Error(`pool lock busy: ${lock}`);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write via a temp file and rename, so a crash mid-write never corrupts the seed file. */
function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}
