import { GENESIS_HASH, SessionEventSchema, chainHash, type NewEvent, type SessionEvent } from "@buffet/shared";
import fs from "node:fs";
import path from "node:path";

/**
 * Append-only, hash-chained, sequence-ordered event log (CLAUDE.md §10, §12).
 * One chain per session. `hash` is sha256 over the canonical JSON of the event
 * without `hash`, which includes `prev_hash`. The manifest hash of a session is
 * the hash of its last event.
 *
 * Persistence is one JSON-lines file per session under `dir`, appended per
 * event, so a restart replays the chain and nothing is rewritten.
 */
export class EventLog {
  private readonly chains = new Map<string, SessionEvent[]>();

  constructor(private readonly dir?: string) {
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const events = fs
          .readFileSync(path.join(dir, f), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => SessionEventSchema.parse(JSON.parse(line)));
        if (events.length > 0) this.chains.set(events[0]!.session_id, events);
      }
    }
  }

  append(e: NewEvent): SessionEvent {
    const chain = this.chains.get(e.session_id) ?? [];
    const prev = chain[chain.length - 1];
    const body = {
      session_id: e.session_id,
      seq: (prev?.seq ?? 0) + 1,
      ts: new Date().toISOString(),
      span_id: e.span_id,
      ...(e.parent_span_id ? { parent_span_id: e.parent_span_id } : {}),
      type: e.type,
      source: e.source,
      ...(e.duration_ms !== undefined ? { duration_ms: e.duration_ms } : {}),
      payload: JSON.parse(JSON.stringify(e.payload)) as Record<string, unknown>,
      prev_hash: prev?.hash ?? GENESIS_HASH,
    };
    const event: SessionEvent = SessionEventSchema.parse({ ...body, hash: chainHash(body) });
    chain.push(event);
    this.chains.set(e.session_id, chain);
    if (this.dir) fs.appendFileSync(path.join(this.dir, `${safeName(e.session_id)}.jsonl`), `${JSON.stringify(event)}\n`);
    return event;
  }

  after(session_id: string, after_seq: number): SessionEvent[] {
    return (this.chains.get(session_id) ?? []).filter((ev) => ev.seq > after_seq);
  }

  all(session_id: string): SessionEvent[] {
    return [...(this.chains.get(session_id) ?? [])];
  }

  head(session_id: string): { seq: number; hash: string } {
    const chain = this.chains.get(session_id) ?? [];
    const last = chain[chain.length - 1];
    return last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: GENESIS_HASH };
  }

  /** Recompute every hash from genesis; the thing a judge can do with the HTTP output. */
  static verify(events: SessionEvent[]): { ok: boolean; broken_at?: number } {
    let prev = GENESIS_HASH;
    for (const [i, ev] of events.entries()) {
      if (ev.seq !== i + 1 || ev.prev_hash !== prev) return { ok: false, broken_at: ev.seq };
      const { hash, ...rest } = ev;
      if (chainHash(rest) !== hash) return { ok: false, broken_at: ev.seq };
      prev = hash;
    }
    return { ok: true };
  }
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}
