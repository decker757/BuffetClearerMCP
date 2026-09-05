import type { Product } from "@aishop4u/shared";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog } from "./eventlog.js";
import { projectSnapshot } from "./projection.js";
import { SessionError, SessionManager } from "./session.js";

const P = (id: string, price: string, extra: Partial<Product> = {}): Product => ({
  id,
  shop_id: "shop_a",
  product_name: `Product ${id}`,
  description: "seller text",
  price,
  currency: "RLUSD",
  product_rating: 4.5,
  shop_rating: 4.7,
  quantity_sold: 100,
  stock: 5,
  ...extra,
});
const BILLING = { name: "Test Buyer", email: "buyer@example.com", address: "1 Test St" };

/** The `code` of the SessionError a call throws, which is what the tool guard shows the model. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof SessionError ? e.code : `unexpected: ${String(e)}`;
  }
  return "no error";
}

/** Fields the dashboard renders; description is not in the log by design. */
function comparable(s: ReturnType<SessionManager["snapshot"]>) {
  return {
    ...s,
    candidates: s.candidates.map((c) => ({ ...c, product: { ...c.product, description: "" } })),
  };
}

describe("snapshot projection from the event log", () => {
  it("matches the live snapshot at every stage of the flow", () => {
    const log = new EventLog();
    const m = new SessionManager(log, "0.25");
    const id = m.start("a laptop", "user asked").session_id;
    const check = () => expect(projectSnapshot(log.all(id))).toEqual(comparable(m.snapshot(id)));

    check();
    m.recordBrowse(id, { query: "laptop", min: "600.00", max: "1200.00" }, [P("p_1", "899.00"), P("p_2", "349.00", { quantity_sold: 3, product_rating: 4.9 })], []);
    check();
    m.propose(id, ["p_1"], [{ product_id: "p_2", reason: "too good", evidence: { price: "349.00", quantity_sold: 3 } }]);
    check();
    m.select(id, "p_1");
    check();
    m.submitBilling(id, BILLING);
    check();
    const q = m.checkout(id);
    check();
    m.approve(id, q.quote_id);
    check();
    m.consumeApproval(id, q.quote_id);
    // settling: the live manager sets in_flight before any payment event exists; the projection
    // learns it from session.funded, so compare after the payments layer has spoken.
    const sink = m.sinkFor(id);
    sink.emit({ type: "card.authorised", source: "server", span_id: "p", payload: { auth_id: "a", amount: q.total } });
    sink.emit({ type: "session.funded", source: "server", span_id: "p", payload: { wallet: "rW", amount: q.items_total, tx_hash: "A".repeat(64) } });
    sink.emit({ type: "payment.submitted", source: "server", span_id: "l", parent_span_id: "p", payload: { line_id: "l_1", amount: "899.00" } });
    expect(projectSnapshot(log.all(id))).toMatchObject({ phase: "settling", ledger: { funded: "899.00", in_flight: "899.00" } });
    sink.emit({ type: "purchase.settled", source: "server", span_id: "l", parent_span_id: "p", payload: { line_id: "l_1", amount: "899.00", tx_hash: "B".repeat(64) } });
    sink.emit({ type: "session.swept", source: "server", span_id: "p", payload: { amount: "0.00" } });
    sink.emit({ type: "card.captured", source: "server", span_id: "p", payload: { auth_id: "a", amount: "899.25", items: "899.00", fee: "0.25" } });
    m.recordSettlement(id, { ok: true, funded: "899.00", spent: "899.00", released: "0.00", captured: "899.25", fee: "0.25", wallet: "rW", lines: [] }, "ab".repeat(32));
    check();
    expect(JSON.stringify(projectSnapshot(log.all(id)))).not.toContain("buyer@example.com");
  });

  /**
   * docs/FAILURE-MODES.md section 1: a refusal before money moves sends the live
   * session back to checkout. The dashboard reads the projection, not the live
   * session, so it has to agree — otherwise a declined card looks like a purchase
   * that is still settling, with no way to approve again.
   */
  it("a settlement refusal before money moves puts the projection back at checkout", () => {
    const log = new EventLog();
    const m = new SessionManager(log, "0.25");
    const id = m.start("a laptop", "r").session_id;
    m.recordBrowse(id, { query: "laptop", min: "600.00", max: "1200.00" }, [P("p_1", "899.00")], []);
    m.propose(id, ["p_1"], []);
    m.select(id, "p_1");
    m.submitBilling(id, BILLING);
    const q = m.checkout(id);
    m.approve(id, q.quote_id);
    m.consumeApproval(id, q.quote_id);
    // consumeApproval emits nothing, so the projection is still `approved` here: the
    // refusal below arrives before any card or funding event ever exists.
    expect(projectSnapshot(log.all(id))!.phase).toBe("approved");

    // The card is declined: nothing moved, and the session reopens for another approval.
    m.sinkFor(id).emit({ type: "payment.refused", source: "server", span_id: "purchase", payload: { rule: "card_declined", message: "insufficient funds" } });
    m.settlementRefused(id);
    expect(projectSnapshot(log.all(id))).toEqual(comparable(m.snapshot(id)));
    expect(projectSnapshot(log.all(id))!.phase).toBe("checkout");

    // A per-line refusal during settling must NOT reopen the session.
    const m2 = new SessionManager(new EventLog(), "0.25");
    const id2 = m2.start("a laptop", "r").session_id;
    m2.recordBrowse(id2, { query: "laptop", min: "600.00", max: "1200.00" }, [P("p_1", "899.00")], []);
    m2.propose(id2, ["p_1"], []);
    m2.select(id2, "p_1");
    m2.submitBilling(id2, BILLING);
    const q2 = m2.checkout(id2);
    m2.approve(id2, q2.quote_id);
    m2.consumeApproval(id2, q2.quote_id);
    const sink2 = m2.sinkFor(id2);
    sink2.emit({ type: "card.authorised", source: "server", span_id: "p", payload: { auth_id: "a", amount: q2.total } });
    sink2.emit({ type: "payment.refused", source: "server", span_id: "l", parent_span_id: "p", payload: { line_id: "l_1", rule: "quoted_ne_demanded" } });
    expect(projectSnapshot(m2.log.all(id2))!.phase).toBe("settling");
  });

  it("projects abort and reopen-from-checkout correctly", () => {
    const log = new EventLog();
    const m = new SessionManager(log, "0.25");
    const id = m.start("cable", "r").session_id;
    m.recordBrowse(id, { query: "cable", min: "1.00", max: "30.00" }, [P("p_1", "16.90"), P("p_2", "12.90")], []);
    m.propose(id, ["p_1", "p_2"], []);
    m.select(id, "p_1");
    m.submitBilling(id, BILLING);
    m.checkout(id);
    m.select(id, "p_2"); // reopens
    expect(projectSnapshot(log.all(id))).toEqual(comparable(m.snapshot(id)));
    m.abort(id, "user");
    expect(projectSnapshot(log.all(id))).toEqual(comparable(m.snapshot(id)));
  });
});

describe("event log across processes", () => {
  it("a second EventLog on the same directory sees another process's appends after reload()", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aishop4u-log2-"));
    const writer = new EventLog(dir);
    const reader = new EventLog(dir);
    writer.append({ session_id: "s_x", span_id: "a", type: "session.started", source: "server", payload: { objective: "x" } });
    writer.append({ session_id: "s_x", span_id: "a", type: "agent.intent", source: "agent", payload: {} });
    expect(reader.all("s_x")).toHaveLength(0);
    reader.reload("s_x");
    expect(reader.all("s_x")).toHaveLength(2);
    expect(reader.head("s_x")).toEqual(writer.head("s_x"));
    writer.append({ session_id: "s_x", span_id: "a", type: "session.aborted", source: "server", payload: {} });
    reader.reload("s_x");
    expect(reader.all("s_x")).toHaveLength(3);
    expect(EventLog.verify(reader.all("s_x")).ok).toBe(true);
    expect(reader.sessionsOnDisk()).toEqual(["s_x"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * docs/FAILURE-MODES.md: the server restarts between the approval and the
   * purchase. Sessions live in memory, so the approval is gone — but nothing was
   * charged, the reads still work off the log, and the model is told plainly
   * rather than being allowed to spend against a session nobody remembers.
   */
  it("a restart after approval loses the approval, keeps the record, and cannot spend", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aishop4u-restart-"));
    const before = new SessionManager(new EventLog(dir), "0.25");
    const id = before.start("a laptop", "user asked").session_id;
    before.recordBrowse(id, { query: "laptop", min: "600.00", max: "1200.00" }, [P("p_1", "899.00")], []);
    before.propose(id, ["p_1"], []);
    before.select(id, "p_1");
    before.submitBilling(id, BILLING);
    const q = before.checkout(id);
    before.approve(id, q.quote_id);
    expect(before.snapshot(id).phase).toBe("approved");

    // The process dies. A new one starts on the same log directory.
    const after = new SessionManager(new EventLog(dir), "0.25");
    expect(after.has(id)).toBe(false);
    // The model is told `unknown_session: ...` by the tool guard, not given a way through.
    expect(codeOf(() => after.consumeApproval(id, q.quote_id))).toBe("unknown_session");
    expect(codeOf(() => after.get(id))).toBe("unknown_session");

    // The reads a judge or the dashboard uses still work, and the chain still verifies.
    const events = after.log.all(id);
    const projected = projectSnapshot(events)!;
    expect(projected.phase).toBe("approved");
    expect(projected.ledger.approved_total).toBe("899.25");
    expect(projected.billing_present).toBe(true);
    expect(EventLog.verify(events).ok).toBe(true);
    // Nothing was charged or funded: purchase never ran.
    expect(events.map((e) => e.type)).not.toContain("card.authorised");
    expect(events.map((e) => e.type)).not.toContain("session.funded");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("never splices a foreign chain onto its own", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aishop4u-log3-"));
    const a = new EventLog(dir);
    a.append({ session_id: "s_y", span_id: "a", type: "session.started", source: "server", payload: {} });
    const b = new EventLog(); // in-memory, different genesis history for the same id
    b.append({ session_id: "s_y", span_id: "a", type: "session.started", source: "server", payload: { other: true } });
    // write b's line to the file after a's: seq collides, hash chain breaks
    fs.appendFileSync(path.join(dir, "s_y.jsonl"), `${JSON.stringify(b.all("s_y")[0])}\n`);
    a.reload("s_y");
    expect(a.all("s_y")).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
