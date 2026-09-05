import { GENESIS_HASH } from "@aishop4u/shared";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog } from "./eventlog.js";

describe("event log", () => {
  it("chains from genesis, sequences per session, and verifies from served JSON", () => {
    const log = new EventLog();
    const a1 = log.append({ session_id: "s_a", span_id: "x", type: "session.started", source: "server", payload: { objective: "laptop" } });
    const b1 = log.append({ session_id: "s_b", span_id: "x", type: "session.started", source: "server", payload: {} });
    const a2 = log.append({ session_id: "s_a", span_id: "y", type: "agent.intent", source: "agent", payload: { reason: "browse" }, parent_span_id: "x" });
    expect(a1.seq).toBe(1);
    expect(b1.seq).toBe(1);
    expect(a2.seq).toBe(2);
    expect(a1.prev_hash).toBe(GENESIS_HASH);
    expect(a2.prev_hash).toBe(a1.hash);
    expect(log.head("s_a")).toEqual({ seq: 2, hash: a2.hash });
    // what a judge would do: curl the events, re-hash them
    const served = JSON.parse(JSON.stringify(log.all("s_a")));
    expect(EventLog.verify(served)).toEqual({ ok: true });
  });

  it("detects a rewritten payload or a reordered event", () => {
    const log = new EventLog();
    log.append({ session_id: "s", span_id: "x", type: "session.started", source: "server", payload: { a: 1 } });
    log.append({ session_id: "s", span_id: "x", type: "agent.intent", source: "agent", payload: { reason: "r" } });
    const tampered = JSON.parse(JSON.stringify(log.all("s")));
    tampered[0].payload.a = 2;
    expect(EventLog.verify(tampered)).toEqual({ ok: false, broken_at: 1 });
    const reordered = JSON.parse(JSON.stringify(log.all("s"))).reverse();
    expect(EventLog.verify(reordered).ok).toBe(false);
  });

  it("returns events after a sequence number, empty when caught up", () => {
    const log = new EventLog();
    log.append({ session_id: "s", span_id: "x", type: "session.started", source: "server", payload: {} });
    log.append({ session_id: "s", span_id: "x", type: "agent.intent", source: "agent", payload: {} });
    expect(log.after("s", 1).map((e) => e.seq)).toEqual([2]);
    expect(log.after("s", 2)).toEqual([]);
    expect(log.after("nope", 0)).toEqual([]);
  });

  it("persists as JSON lines and replays the chain on restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aishop4u-log-"));
    const log = new EventLog(dir);
    log.append({ session_id: "s_1", span_id: "x", type: "session.started", source: "server", payload: { when: new Date("2026-09-05T00:00:00Z") } });
    log.append({ session_id: "s_1", span_id: "x", type: "agent.intent", source: "agent", payload: {} });
    const head = log.head("s_1");
    const reloaded = new EventLog(dir);
    expect(reloaded.head("s_1")).toEqual(head);
    expect(EventLog.verify(reloaded.all("s_1"))).toEqual({ ok: true });
    const next = reloaded.append({ session_id: "s_1", span_id: "x", type: "session.aborted", source: "server", payload: {} });
    expect(next.seq).toBe(3);
    expect(next.prev_hash).toBe(head.hash);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
