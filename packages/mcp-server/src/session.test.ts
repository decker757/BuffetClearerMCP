import type { Product } from "@aishop4u/shared";
import { describe, expect, it } from "vitest";
import { EventLog } from "./eventlog.js";
import { SessionError, SessionManager } from "./session.js";

const P = (id: string, price: string, extra: Partial<Product> = {}): Product => ({
  id,
  shop_id: "shop_a",
  product_name: `Product ${id}`,
  description: "seller text <script>alert(1)</script>",
  price,
  currency: "RLUSD",
  product_rating: 4.5,
  shop_rating: 4.7,
  quantity_sold: 100,
  stock: 5,
  ...extra,
});
const BILLING = { name: "Test Buyer", email: "buyer@example.com", address: "1 Test St" };

function fresh() {
  const log = new EventLog();
  const m = new SessionManager(log, "0.25");
  const s = m.start("a laptop", "user asked");
  return { log, m, id: s.session_id };
}

function toBrowsed(m: SessionManager, id: string) {
  m.recordBrowse(id, { query: "laptop", min: "600.00", max: "1200.00" }, [P("p_1", "899.00"), P("p_2", "349.00", { quantity_sold: 3, product_rating: 4.9 })], []);
}

describe("session manager", () => {
  it("walks the happy path and keeps the step in sync with the phase strip", () => {
    const { m, id, log } = fresh();
    expect(m.snapshot(id)).toMatchObject({ phase: "shopping", step: "preferences", billing_present: false });
    toBrowsed(m, id);
    expect(m.snapshot(id)).toMatchObject({ step: "browse", price_range: { min: "600.00", max: "1200.00" } });
    m.propose(id, ["p_1"], [{ product_id: "p_2", reason: "61% below median, 4.9 on 3 sales", evidence: { price: "349.00", median: "899.00" } }]);
    expect(m.snapshot(id).step).toBe("select");
    expect(m.snapshot(id).candidates.map((c) => c.outcome)).toEqual(["recommended", "rejected"]);
    m.select(id, "p_1");
    m.submitBilling(id, BILLING);
    expect(m.snapshot(id)).toMatchObject({ step: "billing", billing_present: true });
    const q = m.checkout(id);
    expect(q).toMatchObject({ items_total: "899.00", fee: "0.25", total: "899.25" });
    expect(m.snapshot(id)).toMatchObject({ phase: "checkout", step: "approve", ledger: { approved_total: "899.25" } });
    m.approve(id, q.quote_id);
    expect(m.snapshot(id)).toMatchObject({ phase: "approved", step: "settle" });
    const consumed = m.consumeApproval(id, q.quote_id);
    expect(consumed.quote_hash).toBe(q.quote_hash);
    expect(m.snapshot(id)).toMatchObject({ phase: "settling", ledger: { in_flight: "899.00" } });
    m.recordSettlement(id, { ok: true, funded: "899.00", spent: "899.00", released: "0.00", captured: "899.25", fee: "0.25", wallet: "rX", lines: [] }, "ab".repeat(32));
    expect(m.snapshot(id)).toMatchObject({ phase: "done", ledger: { settled: "899.00", in_flight: "0.00" } });
    expect(EventLog.verify(log.all(id)).ok).toBe(true);
    expect(log.all(id).map((e) => e.type)).toEqual([
      "session.started",
      "agent.intent",
      "browse.requested",
      "browse.returned",
      "candidate.found",
      "candidate.rejected",
      "candidate.ranked",
      "candidate.selected",
      "billing.submitted",
      "quote.ready",
      "approval.granted",
    ]);
  });

  it("invariant 7: purchase refuses without a live, unused, matching approval, and every refusal is an event", () => {
    const { m, id, log } = fresh();
    toBrowsed(m, id);
    m.propose(id, ["p_1"], []);
    m.select(id, "p_1");
    m.submitBilling(id, BILLING);
    const q = m.checkout(id);
    // not approved yet
    expect(() => m.consumeApproval(id, q.quote_id)).toThrow(SessionError);
    // approve, then a different quote id
    m.approve(id, q.quote_id);
    expect(() => m.consumeApproval(id, "q_other")).toThrow(/different quote/);
    // consume once, then again
    m.consumeApproval(id, q.quote_id);
    expect(() => m.consumeApproval(id, q.quote_id)).toThrow(/not approved|already used/);
    const refusals = log.all(id).filter((e) => e.type === "approval.refused");
    expect(refusals.map((e) => e.payload.rule)).toEqual(["not_approved", "quote_mismatch", "not_approved"]);
  });

  it("approval is bound to the quote hash and expires", () => {
    const { m, id } = fresh();
    toBrowsed(m, id);
    m.propose(id, ["p_1"], []);
    m.select(id, "p_1");
    m.submitBilling(id, BILLING);
    const q = m.checkout(id);
    const a = m.approve(id, q.quote_id);
    // tamper with the pending quote after approval
    m.get(id).pending_quote!.quote_hash = "f".repeat(64);
    expect(() => m.consumeApproval(id, q.quote_id)).toThrow(/changed after approval/);
    m.get(id).pending_quote!.quote_hash = a.quote_hash;
    a.expires_at = new Date(Date.now() - 1).toISOString();
    expect(() => m.consumeApproval(id, q.quote_id)).toThrow(/expired/);
  });

  it("a new checkout invalidates a previous approval", () => {
    const { m, id } = fresh();
    toBrowsed(m, id);
    m.propose(id, ["p_1", "p_2"], []);
    m.select(id, "p_1");
    m.submitBilling(id, BILLING);
    const q1 = m.checkout(id);
    m.approve(id, q1.quote_id);
    // Going back to add an item reopens the session; the old quote and approval die with it.
    m.select(id, "p_2");
    expect(m.snapshot(id).phase).toBe("shopping");
    const q2 = m.checkout(id);
    expect(q2.quote_id).not.toBe(q1.quote_id);
    expect(() => m.consumeApproval(id, q1.quote_id)).toThrow();
    expect(() => m.consumeApproval(id, q2.quote_id)).toThrow(/not approved/);
  });

  it("billing never appears in events or snapshots, and is dropped after settlement", () => {
    const { m, id, log } = fresh();
    toBrowsed(m, id);
    m.propose(id, ["p_1"], []);
    m.select(id, "p_1");
    m.submitBilling(id, BILLING);
    expect(m.billingFor(id)).toEqual(BILLING);
    const dump = JSON.stringify(log.all(id)) + JSON.stringify(m.snapshot(id));
    expect(dump).not.toContain("buyer@example.com");
    expect(dump).not.toContain("1 Test St");
    expect(dump).not.toContain("Test Buyer");
    const q = m.checkout(id);
    m.approve(id, q.quote_id);
    m.consumeApproval(id, q.quote_id);
    m.recordSettlement(id, { ok: true, funded: "899.00", spent: "899.00", released: "0.00", captured: "899.25", fee: "0.25", wallet: "rX", lines: [] }, "ab".repeat(32));
    expect(() => m.billingFor(id)).toThrow(/billing_missing|no billing/);
  });

  it("server-side guards: browse before propose, only browsed ids, at most 5, no selecting non-candidates, no checkout without billing", () => {
    const { m, id } = fresh();
    expect(() => m.propose(id, ["p_1"], [])).toThrow(/browse before propose/);
    toBrowsed(m, id);
    expect(() => m.propose(id, ["p_999"], [])).toThrow(/not in the last browse/);
    expect(() => m.propose(id, ["p_1", "p_1", "p_2", "p_2", "p_1", "p_2"], [])).toThrow(/at most 5/);
    expect(() => m.propose(id, ["p_1"], [{ product_id: "p_1", reason: "x" }])).toThrow(/both recommended and rejected/);
    expect(() => m.select(id, "p_1")).toThrow(/not in the current recommendations/);
    m.propose(id, ["p_1"], [{ product_id: "p_2", reason: "suspicious" }]);
    m.select(id, "p_1");
    expect(m.select(id, "p_1").product_id).toBe("p_1"); // re-selecting the same item is a no-op
    expect(m.snapshot(id).selections).toHaveLength(1);
    expect(() => m.checkout(id)).toThrow(/billing/);
  });

  it("one pick per recommendation list: selecting another item replaces the pick and keeps the slot", () => {
    const { m, id } = fresh();
    toBrowsed(m, id);
    m.propose(id, ["p_1", "p_2"], []);
    m.select(id, "p_1");
    expect(m.snapshot(id).selections.map((l) => l.product_id)).toEqual(["p_1"]);
    m.select(id, "p_2"); // same list -> replaces, does not add a second line
    const sel = m.snapshot(id).selections;
    expect(sel).toHaveLength(1);
    expect(sel[0]).toMatchObject({ product_id: "p_2", line_id: "l_1" });
  });

  it("the human may overrule a flag, and the record says so", () => {
    const { m, id, log } = fresh();
    toBrowsed(m, id);
    m.propose(id, ["p_1"], [{ product_id: "p_2", reason: "too good to be true" }]);
    m.select(id, "p_2");
    const sel = log.all(id).find((e) => e.type === "candidate.selected")!;
    expect(sel.payload).toMatchObject({ product_id: "p_2", overrode_flag: true });
    const flag = log.all(id).find((e) => e.type === "candidate.rejected")!;
    expect(flag.source).toBe("agent");
  });

  it("abort is allowed while shopping or at checkout, refused while settling, and clears billing", () => {
    const { m, id, log } = fresh();
    toBrowsed(m, id);
    m.propose(id, ["p_1"], []);
    m.select(id, "p_1");
    m.submitBilling(id, BILLING);
    const q = m.checkout(id);
    m.approve(id, q.quote_id);
    m.consumeApproval(id, q.quote_id);
    expect(() => m.abort(id, "user")).toThrow(/in flight/);
    m.settlementRefused(id); // e.g. pool exhausted before any money moved
    expect(m.snapshot(id).phase).toBe("checkout");
    m.abort(id, "user");
    expect(m.snapshot(id).phase).toBe("aborted");
    expect(m.snapshot(id).billing_present).toBe(false);
    expect(log.all(id).at(-1)!.type).toBe("session.aborted");
    expect(() => m.abort(id, "user")).toThrow(/already/);
  });

  it("the manifest hash is the chain head at the time it is read", () => {
    const { m, id, log } = fresh();
    expect(m.manifestHash(id)).toBe(log.head(id).hash);
    toBrowsed(m, id);
    expect(m.manifestHash(id)).toBe(log.head(id).hash);
    expect(m.manifestHash(id)).toHaveLength(64);
  });

  it("no stuck states: an expired approval can be re-approved, an expired quote re-quoted, and checkout is repeatable", () => {
    const { m, id } = fresh();
    toBrowsed(m, id);
    m.propose(id, ["p_1"], []);
    m.select(id, "p_1");
    m.submitBilling(id, BILLING);
    const q1 = m.checkout(id);
    const a = m.approve(id, q1.quote_id);
    a.expires_at = new Date(Date.now() - 1).toISOString();
    expect(() => m.consumeApproval(id, q1.quote_id)).toThrow(/expired/);
    // back at checkout: approve again works
    expect(m.snapshot(id).phase).toBe("checkout");
    m.approve(id, q1.quote_id);
    expect(m.snapshot(id).phase).toBe("approved");
    // expired quote: checkout again from checkout phase
    m.get(id).phase = "checkout";
    m.get(id).pending_quote!.expires_at = new Date(Date.now() - 1).toISOString();
    expect(() => m.approve(id, q1.quote_id)).toThrow(/expired/);
    const q2 = m.checkout(id);
    expect(q2.quote_id).not.toBe(q1.quote_id);
    m.approve(id, q2.quote_id);
    expect(m.consumeApproval(id, q2.quote_id).quote_id).toBe(q2.quote_id);
  });

  it("a second browse adds a cart line, reopening a checked-out session and re-quoting both", () => {
    const { m, id } = fresh();
    toBrowsed(m, id);
    m.propose(id, ["p_1", "p_2"], []);
    m.select(id, "p_1");
    m.submitBilling(id, BILLING);
    const q1 = m.checkout(id);
    // The cart grows across browse cycles (§15.1): a new list contributes its own line.
    m.recordBrowse(id, { query: "cable", min: "1.00", max: "500.00" }, [P("p_3", "349.00")], []);
    m.propose(id, ["p_3"], []);
    m.select(id, "p_3");
    expect(m.snapshot(id)).toMatchObject({ phase: "shopping", step: "select" });
    expect(m.snapshot(id).pending_quote).toBeUndefined();
    const q2 = m.checkout(id);
    expect(q2.lines).toHaveLength(2);
    expect(q2.items_total).toBe("1248.00");
    expect(() => m.consumeApproval(id, q1.quote_id)).toThrow();
  });

  it("expireStale aborts abandoned sessions but never a settling one", () => {
    const { m, id } = fresh();
    const other = m.start("cable", "r").session_id;
    toBrowsed(m, other);
    m.propose(other, ["p_1"], []);
    m.select(other, "p_1");
    m.submitBilling(other, BILLING);
    const q = m.checkout(other);
    m.approve(other, q.quote_id);
    m.consumeApproval(other, q.quote_id); // settling
    m.get(id).created_at = new Date(Date.now() - 60 * 60_000).toISOString();
    m.get(other).created_at = new Date(Date.now() - 60 * 60_000).toISOString();
    expect(m.expireStale(30 * 60_000)).toEqual([id]);
    expect(m.snapshot(id).phase).toBe("expired");
    expect(m.snapshot(other).phase).toBe("settling");
  });
});
