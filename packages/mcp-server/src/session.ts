import {
  add,
  chainHash,
  sha256Hex,
  type Candidate,
  type Ledger,
  type Money,
  type NewEvent,
  type OrderLine,
  type Product,
  type Quote,
  type SessionEvent,
  type SessionPhase,
  type SessionSnapshot,
  type SessionStep,
} from "@buffet/shared";
import type { EventSink } from "@buffet/payments";
import { randomBytes } from "node:crypto";
import { EventLog } from "./eventlog.js";

/**
 * Server-side session state (CLAUDE.md §15.6). Widgets are destroyed and recreated;
 * everything lives here. Billing details live here and nowhere else: never in an
 * event, never in a snapshot, never in a tool result the model sees.
 *
 * Every transition emits through the event log so the widget and the manifest see
 * the same thing the server did.
 */
export interface Billing {
  name: string;
  email: string;
  address: string;
}

export interface ApprovalRecord {
  quote_id: string;
  quote_hash: string;
  granted_at: string;
  expires_at: string;
  used: boolean;
}

export interface SessionRecord {
  session_id: string;
  objective: string;
  created_at: string;
  phase: SessionPhase;
  step: SessionStep;
  price_range?: { min: Money; max: Money };
  /** products from the last browse, by id: the only things propose/select may name */
  browsed: Map<string, Product>;
  candidates: Candidate[];
  selections: OrderLine[];
  billing?: Billing;
  pending_quote?: Quote;
  approval?: ApprovalRecord;
  ledger: { approved_total?: Money; funded: Money; settled: Money; in_flight: Money; fee: Money };
  receipt?: Record<string, unknown>;
}

export class SessionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

const QUOTE_TTL_MS = 10 * 60_000;
const APPROVAL_TTL_MS = 5 * 60_000;
const MAX_RECOMMENDED = 5;

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(
    readonly log: EventLog,
    private readonly fee: Money,
  ) {}

  // ---------- lookups

  get(session_id: string): SessionRecord {
    const s = this.sessions.get(session_id);
    if (!s) throw new SessionError("unknown_session", `no session ${session_id}`);
    return s;
  }

  has(session_id: string): boolean {
    return this.sessions.has(session_id);
  }

  /** An EventSink for the payments layer, bound to one session. */
  sinkFor(session_id: string): EventSink {
    return {
      emit: (e) => {
        this.emit({ session_id, ...e });
      },
    };
  }

  private emit(e: NewEvent): SessionEvent {
    return this.log.append(e);
  }

  // ---------- model-facing transitions

  start(objective: string, reason: string): SessionRecord {
    const session_id = `s_${randomBytes(8).toString("hex")}`;
    const s: SessionRecord = {
      session_id,
      objective,
      created_at: new Date().toISOString(),
      phase: "started",
      step: "preferences",
      browsed: new Map(),
      candidates: [],
      selections: [],
      ledger: { funded: "0.00", settled: "0.00", in_flight: "0.00", fee: this.fee },
    };
    this.sessions.set(session_id, s);
    this.emit({ session_id, span_id: "session", type: "session.started", source: "server", payload: { objective, fee: this.fee } });
    this.intent(session_id, "start_session", reason);
    s.phase = "shopping";
    return s;
  }

  /** One agent.intent per model-facing tool call: the model's stated reason, labelled as a claim. */
  intent(session_id: string, tool: string, reason: string): void {
    this.emit({ session_id, span_id: `call_${tool}`, parent_span_id: "session", type: "agent.intent", source: "agent", payload: { tool, reason } });
  }

  /**
   * Any shopping action from `checkout` or `approved` reopens the session: the pending
   * quote and approval die with it. (Not from `settling`: consumeApproval is synchronous,
   * so once purchase holds the quote nothing here can race it.)
   */
  private reopen(session_id: string): SessionRecord {
    const s = this.requirePhase(session_id, ["shopping", "checkout", "approved"]);
    if (s.phase === "checkout" || s.phase === "approved") {
      s.phase = "shopping";
      delete s.pending_quote;
      delete s.approval;
      delete s.ledger.approved_total;
    }
    return s;
  }

  recordBrowseRefused(session_id: string, query: string, why: string): void {
    const s = this.reopen(session_id);
    s.step = "preferences";
    this.emit({ session_id, span_id: "call_browse", type: "browse.refused", source: "server", payload: { query, reason: why } });
  }

  recordBrowse(session_id: string, q: { query: string; min: Money; max: Money }, products: Product[], nearest: Product[]): void {
    const s = this.reopen(session_id);
    s.price_range = { min: q.min, max: q.max };
    s.browsed = new Map([...products, ...nearest].map((p) => [p.id, p]));
    s.candidates = [];
    s.step = "browse";
    this.emit({ session_id, span_id: "call_browse", type: "browse.requested", source: "server", payload: { query: q.query, min_price: q.min, max_price: q.max } });
    this.emit({ session_id, span_id: "call_browse", type: "browse.returned", source: "server", payload: { count: products.length, nearest: nearest.length } });
  }

  propose(
    session_id: string,
    recommended: string[],
    rejected: Array<{ product_id: string; reason: string; evidence?: Record<string, string | number> }>,
  ): Candidate[] {
    const s = this.reopen(session_id);
    if (s.browsed.size === 0) throw new SessionError("browse_first", "call browse before propose");
    if (recommended.length === 0) throw new SessionError("nothing_recommended", "recommend at least one product");
    if (recommended.length > MAX_RECOMMENDED) throw new SessionError("too_many", `recommend at most ${MAX_RECOMMENDED}`);
    const seen = new Set<string>();
    const out: Candidate[] = [];
    for (const id of recommended) {
      const p = s.browsed.get(id);
      if (!p) throw new SessionError("unknown_product", `${id} was not in the last browse`);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ product: p, outcome: "recommended" });
      this.emit({ session_id, span_id: "call_propose", type: "candidate.found", source: "server", payload: publicProduct(p) });
    }
    for (const r of rejected) {
      const p = s.browsed.get(r.product_id);
      if (!p) throw new SessionError("unknown_product", `${r.product_id} was not in the last browse`);
      if (seen.has(r.product_id)) throw new SessionError("conflict", `${r.product_id} is both recommended and rejected`);
      seen.add(r.product_id);
      const reason = r.reason.slice(0, 500);
      const c: Candidate = { product: p, outcome: "rejected", reason, ...(r.evidence ? { evidence: r.evidence } : {}) };
      out.push(c);
      // The flag is the model's claim (§8): source agent, and the widget labels it so.
      this.emit({
        session_id,
        span_id: "call_propose",
        type: "candidate.rejected",
        source: "agent",
        payload: { ...publicProduct(p), reason, evidence: r.evidence ?? {} },
      });
    }
    s.candidates = out;
    s.step = "select"; // the user acts next, in the widget
    this.emit({ session_id, span_id: "call_propose", type: "candidate.ranked", source: "server", payload: { recommended: recommended.length, rejected: rejected.length } });
    return out;
  }

  // ---------- widget-only transitions (the model never calls these)

  select(session_id: string, product_id: string): OrderLine {
    const s = this.reopen(session_id);
    const c = s.candidates.find((x) => x.product.id === product_id);
    if (!c) throw new SessionError("not_a_candidate", `${product_id} is not in the current recommendations`);
    if (s.selections.some((l) => l.product_id === product_id)) throw new SessionError("already_selected", `${product_id} is already in the order`);
    const line: OrderLine = {
      line_id: `l_${s.selections.length + 1}`,
      product_id,
      shop_id: c.product.shop_id,
      product_name: c.product.product_name,
      price: c.product.price,
    };
    s.selections.push(line);
    // The human may overrule the agent's flag; if they do, the record says so (invariant 5).
    this.emit({
      session_id,
      span_id: "widget",
      type: "candidate.selected",
      source: "server",
      payload: { ...line, overrode_flag: c.outcome === "rejected" },
    });
    // Next: billing if we do not have it yet; otherwise the agent asks about more items or checks out.
    s.step = s.billing ? "select" : "billing";
    return line;
  }

  submitBilling(session_id: string, b: Billing): void {
    const s = this.reopen(session_id);
    s.billing = { name: b.name.trim(), email: b.email.trim(), address: b.address.trim() };
    s.step = "billing";
    // Presence and a hash only. The content is never in an event.
    this.emit({
      session_id,
      span_id: "widget",
      type: "billing.submitted",
      source: "server",
      payload: { present: true, hash: sha256Hex(`${s.billing.name}|${s.billing.email}|${s.billing.address}`).slice(0, 16) },
    });
  }

  checkout(session_id: string): Quote {
    // Allowed from checkout too: an expired quote is re-quoted, and a re-quote invalidates any approval.
    const s = this.requirePhase(session_id, ["shopping", "checkout"]);
    if (s.selections.length === 0) throw new SessionError("nothing_selected", "the user has not selected anything in the widget yet");
    if (!s.billing) throw new SessionError("billing_missing", "billing details have not been submitted in the widget yet");
    const items_total = s.selections.reduce<Money>((acc, l) => add(acc, l.price), "0.00");
    const total = add(items_total, this.fee);
    const quote_id = `q_${randomBytes(6).toString("hex")}`;
    const expires_at = new Date(Date.now() + QUOTE_TTL_MS).toISOString();
    const body = { session_id, quote_id, lines: s.selections, items_total, fee: this.fee, total, expires_at };
    const quote: Quote = { quote_id, lines: s.selections, items_total, fee: this.fee, total, expires_at, quote_hash: chainHash(body) };
    s.pending_quote = quote;
    delete s.approval;
    s.phase = "checkout";
    s.step = "approve";
    s.ledger.approved_total = total;
    this.emit({
      session_id,
      span_id: `quote_${quote_id}`,
      type: "quote.ready",
      source: "server",
      payload: { quote_id, lines: s.selections, items_total, fee: this.fee, total, quote_hash: quote.quote_hash, expires_at },
    });
    return quote;
  }

  /** Widget-only. Records a single-use, short-lived approval bound to the quote hash (invariant 7). */
  approve(session_id: string, quote_id: string): ApprovalRecord {
    const s = this.requirePhase(session_id, ["checkout"]);
    const q = s.pending_quote;
    if (!q || q.quote_id !== quote_id) throw new SessionError("quote_mismatch", "that is not the pending quote");
    if (Date.parse(q.expires_at) < Date.now()) throw new SessionError("quote_expired", "the quote has expired; call checkout again");
    const now = Date.now();
    s.approval = {
      quote_id,
      quote_hash: q.quote_hash,
      granted_at: new Date(now).toISOString(),
      expires_at: new Date(now + APPROVAL_TTL_MS).toISOString(),
      used: false,
    };
    s.phase = "approved";
    s.step = "settle";
    this.emit({ session_id, span_id: `quote_${quote_id}`, type: "approval.granted", source: "server", payload: { quote_id, quote_hash: q.quote_hash, expires_at: s.approval.expires_at } });
    return s.approval;
  }

  /**
   * Called by `purchase`. Refuses unless a live, unused approval exists for this
   * exact quote. The refusal is an event, not just an error.
   */
  consumeApproval(session_id: string, quote_id: string): Quote {
    const s = this.get(session_id);
    const refuse = (rule: string, message: string): never => {
      this.emit({ session_id, span_id: `quote_${quote_id}`, type: "approval.refused", source: "server", payload: { quote_id, rule, message } });
      throw new SessionError(rule, message);
    };
    if (s.phase !== "approved") return refuse("not_approved", `session is ${s.phase}; the user has not approved this quote in the widget`);
    const a = s.approval;
    const q = s.pending_quote;
    if (!a || !q) return refuse("no_approval_record", "no approval record");
    if (a.quote_id !== quote_id || q.quote_id !== quote_id) return refuse("quote_mismatch", "approval is for a different quote");
    if (a.quote_hash !== q.quote_hash) return refuse("quote_tampered", "quote changed after approval");
    if (a.used) return refuse("approval_used", "this approval was already used");
    if (Date.parse(a.expires_at) < Date.now()) {
      // Back to checkout so approve_quote is legal again.
      s.phase = "checkout";
      s.step = "approve";
      delete s.approval;
      return refuse("approval_expired", "approval expired; ask the user to approve again in the widget");
    }
    a.used = true;
    s.phase = "settling";
    s.ledger.in_flight = q.items_total;
    return q;
  }

  recordSettlement(session_id: string, r: { ok: boolean; funded: Money; spent: Money; released: Money; captured: Money; fee: Money; wallet: string; lines: unknown[]; fund_tx?: string; sweep_tx?: string; card_error?: string }, manifest_hash: string): void {
    const s = this.get(session_id);
    s.ledger.funded = r.funded;
    s.ledger.settled = r.spent;
    s.ledger.in_flight = "0.00";
    s.phase = "done";
    s.step = "settle";
    s.receipt = { ...r, manifest_hash, session_id };
    // Billing is not needed after the invoices went out (§15.6 retention).
    delete s.billing;
  }

  abort(session_id: string, by: "user" | "expiry"): void {
    const s = this.get(session_id);
    if (s.phase === "settling") throw new SessionError("settling", "lines are in flight; abort is refused, the receipt will say what settled");
    if (s.phase === "done" || s.phase === "aborted" || s.phase === "expired") throw new SessionError("terminal", `session is already ${s.phase}`);
    s.phase = by === "user" ? "aborted" : "expired";
    delete s.billing;
    delete s.pending_quote;
    delete s.approval;
    this.emit({ session_id, span_id: "session", type: by === "user" ? "session.aborted" : "session.expired", source: "server", payload: { by } });
  }

  /**
   * Called by `purchase` when settlement threw before any money moved (a PolicyError).
   * Back to checkout so the user can approve again. Anything else stays `settling`
   * for an operator: retrying could fund a second wallet while the first holds RLUSD.
   */
  settlementRefused(session_id: string): void {
    const s = this.get(session_id);
    s.phase = "checkout";
    s.step = "approve";
    s.ledger.in_flight = "0.00";
    delete s.approval;
  }

  /** §15.5 expiry: non-terminal sessions older than `maxAgeMs` are expired. Settling sessions are left alone. */
  expireStale(maxAgeMs: number): string[] {
    const cutoff = Date.now() - maxAgeMs;
    const expired: string[] = [];
    for (const s of this.sessions.values()) {
      if (["done", "aborted", "expired", "settling"].includes(s.phase)) continue;
      if (Date.parse(s.created_at) < cutoff) {
        this.abort(s.session_id, "expiry");
        expired.push(s.session_id);
      }
    }
    return expired;
  }

  /** The manifest hash is the head of the chain at the moment of approval consumption. */
  manifestHash(session_id: string): string {
    return this.log.head(session_id).hash;
  }

  // ---------- reads

  snapshot(session_id: string): SessionSnapshot {
    const s = this.get(session_id);
    const ledger: Ledger = { ...s.ledger };
    return {
      session_id,
      objective: s.objective,
      phase: s.phase,
      step: s.step,
      ...(s.price_range ? { price_range: s.price_range } : {}),
      ledger,
      candidates: s.candidates,
      selections: s.selections,
      billing_present: s.billing !== undefined,
      ...(s.pending_quote ? { pending_quote: s.pending_quote } : {}),
      head_seq: this.log.head(session_id).seq,
    };
  }

  /** Delivery details for the shop, server-side only. */
  billingFor(session_id: string): Billing {
    const b = this.get(session_id).billing;
    if (!b) throw new SessionError("billing_missing", "no billing details on this session");
    return b;
  }

  private requirePhase(session_id: string, phases: SessionPhase[]): SessionRecord {
    const s = this.get(session_id);
    if (!phases.includes(s.phase)) throw new SessionError("wrong_phase", `session is ${s.phase}; expected ${phases.join(" or ")}`);
    return s;
  }
}

/** Product fields safe for an event payload: seller text is included as data, rendered as text downstream. */
function publicProduct(p: Product): Record<string, unknown> {
  return {
    product_id: p.id,
    shop_id: p.shop_id,
    product_name: p.product_name,
    price: p.price,
    product_rating: p.product_rating,
    shop_rating: p.shop_rating,
    quantity_sold: p.quantity_sold,
    stock: p.stock,
  };
}
