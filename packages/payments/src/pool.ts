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
}

export interface PoolWallet {
  address: string;
  seed: string;
}

export class WalletPool {
  private readonly entries: PoolEntry[];

  constructor(
    entries: PoolEntry[],
    private readonly persist: (entries: PoolEntry[]) => void = () => undefined,
  ) {
    this.entries = entries.map((e) => ({ ...e, state: e.state ?? "idle" }));
    // A process that died mid-session leaves wallets stuck; they need a human, not a new session.
    for (const e of this.entries) {
      if (e.state === "funded" || e.state === "paying" || e.state === "sweeping") e.state = "attention";
    }
    this.persist(this.entries);
  }

  static fromFile(file: string): WalletPool {
    const entries = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as PoolEntry[]) : [];
    return new WalletPool(entries, (all) => atomicWrite(file, JSON.stringify(all, null, 2)));
  }

  get size(): number {
    return this.entries.length;
  }

  counts(): Record<PoolState, number> {
    const c: Record<PoolState, number> = { idle: 0, funded: 0, paying: 0, sweeping: 0, attention: 0 };
    for (const e of this.entries) c[e.state] += 1;
    return c;
  }

  /** Public view for the snapshot: addresses and states, never seeds. */
  status(): Array<{ address: string; state: PoolState; session_id?: string }> {
    return this.entries.map(({ address, state, session_id }) => (session_id ? { address, state, session_id } : { address, state }));
  }

  /** Throws PolicyError("pool_exhausted") when nothing is idle: never creates a wallet on the spot. */
  acquire(session_id: string): PoolWallet {
    const e = this.entries.find((x) => x.state === "idle");
    if (!e) throw new PolicyError("pool_exhausted", "no idle session wallet", { counts: this.counts() });
    const now = new Date().toISOString();
    e.state = "funded";
    e.session_id = session_id;
    e.funded_at = now;
    e.since = now;
    this.persist(this.entries);
    return { address: e.address, seed: e.seed };
  }

  transition(address: string, to: PoolState): void {
    const e = this.byAddress(address);
    if (!ALLOWED[e.state].includes(to)) throw new Error(`illegal pool transition ${e.state} -> ${to} for ${address}`);
    e.state = to;
    e.since = new Date().toISOString();
    if (to === "idle") {
      delete e.session_id;
      delete e.funded_at;
    }
    this.persist(this.entries);
  }

  /** Operator action after a human checked the wallet: attention -> idle. */
  repair(address: string): void {
    const e = this.byAddress(address);
    if (e.state !== "attention") throw new Error(`repair: ${address} is ${e.state}, not attention`);
    e.state = "idle";
    delete e.session_id;
    delete e.funded_at;
    e.since = new Date().toISOString();
    this.persist(this.entries);
  }

  /** Seed for a wallet we hold, for the sweeper. Never exposed through status(). */
  seedOf(address: string): string {
    return this.byAddress(address).seed;
  }

  /** Wallets handed out more than `olderThanMs` ago and still not swept: candidates for the expiry sweep. */
  stale(olderThanMs: number): Array<{ address: string; state: PoolState; session_id?: string; funded_at: string }> {
    const cutoff = Date.now() - olderThanMs;
    return this.entries
      .filter((e) => (e.state === "funded" || e.state === "paying") && e.funded_at !== undefined && Date.parse(e.funded_at) < cutoff)
      .map((e) => (e.session_id ? { address: e.address, state: e.state, session_id: e.session_id, funded_at: e.funded_at! } : { address: e.address, state: e.state, funded_at: e.funded_at! }));
  }

  private byAddress(address: string): PoolEntry {
    const e = this.entries.find((x) => x.address === address);
    if (!e) throw new Error(`wallet ${address} is not in the pool`);
    return e;
  }
}

/** Write via a temp file and rename, so a crash mid-write never corrupts the seed file. */
function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}
