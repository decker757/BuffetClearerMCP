import type { Candidate, SessionEvent, SessionStep } from "@aishop4u/shared";
import type { Snapshot, Transport } from "./transport.js";

/**
 * Rendering (CLAUDE.md §12 widget layout). Everything seller-derived goes through
 * `textContent`; there is no innerHTML anywhere in this file (invariant 4).
 */

export interface UiState {
  session_id?: string;
  snapshot?: Snapshot;
  events: SessionEvent[];
  expanded: Set<number>;
  busy: boolean;
  error?: string;
  transport: Transport;
  /** approval already clicked for this quote id, to disable the button while purchase runs */
  approvedQuote?: string;
  /** shown when an action succeeded but the host did not deliver the nudge to the agent */
  hint?: string;
  /** the model tool whose call rendered this instance (hosts render one instance per call) */
  spawnedBy?: string;
  /** feed expanded to all events (default: last few) */
  feedOpen?: boolean;
}

export interface Actions {
  select(product_id: string): void;
  submitBilling(b: { name: string; email: string; address: string }): void;
  approve(quote_id: string): void;
  abort(): void;
  toggle(seq: number): void;
  toggleFeed(): void;
}

const STEPS: Array<{ key: SessionStep; label: string }> = [
  { key: "preferences", label: "Preferences" },
  { key: "browse", label: "Browse" },
  { key: "recommend", label: "Recommend" },
  { key: "select", label: "Select" },
  { key: "billing", label: "Billing" },
  { key: "approve", label: "Approve" },
  { key: "settle", label: "Settle" },
];

// ---------- tiny DOM helpers (text only)

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function card(title: string, right?: string): { root: HTMLElement; body: HTMLElement } {
  const root = el("div", "card");
  const hd = el("div", "hd");
  hd.append(el("h3", undefined, title));
  if (right) hd.append(el("span", "muted mono", right));
  root.append(hd);
  const body = el("div");
  root.append(body);
  return { root, body };
}
/** Links only ever point at https URLs; anything else (a hostile payload) renders as plain text. */
function link(href: string, text: string): HTMLElement {
  if (!/^https:\/\/[a-z0-9.-]+\//i.test(href)) return el("span", "mono", text);
  const a = el("a", "mono", text);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}
function money(m: string | undefined): string {
  return m === undefined ? "–" : `${m} RLUSD`;
}
function short(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

// ---------- sections

function phaseStrip(s: Snapshot): HTMLElement {
  const { root, body } = card("Phase", `${s.phase}`);
  const strip = el("div", "strip");
  const idx = STEPS.findIndex((x) => x.key === s.step);
  const terminal = s.phase === "aborted" || s.phase === "expired";
  STEPS.forEach((st, i) => {
    const span = el("span", undefined, st.label);
    if (terminal) span.className = i <= idx ? "end" : "";
    else if (s.phase === "done") span.className = "done";
    else if (i < idx) span.className = "done";
    else if (i === idx) span.className = "now";
    strip.append(span);
  });
  body.append(strip);
  const obj = el("div", "note");
  obj.append("Objective: ");
  obj.append(el("span", undefined, s.objective));
  if (s.price_range) obj.append(el("span", "muted", `  ·  range ${s.price_range.min}–${s.price_range.max}`));
  body.append(obj);
  return root;
}

function budgetBar(s: Snapshot, live: { inflight: boolean }): HTMLElement {
  const { root, body } = card("Budget", "RLUSD");
  const l = s.ledger;
  if (!l.approved_total) {
    body.append(el("div", "note", s.price_range ? `Nothing is funded before approval. Price range ${s.price_range.min}–${s.price_range.max}.` : "Nothing is funded before approval. Waiting for a price range."));
    return root;
  }
  const total = Number(l.approved_total);
  const settled = Number(l.settled);
  const inflight = Number(l.in_flight);
  const fee = Number(l.fee);
  const bar = el("div", "bar");
  const seg = (cls: string, v: number) => {
    const d = el("div", cls);
    d.style.width = `${total > 0 ? Math.max(0, Math.min(100, (v / total) * 100)) : 0}%`;
    return d;
  };
  bar.append(seg("settled", settled), seg("inflight", inflight), seg("fee", s.phase === "done" ? fee : 0));
  body.append(bar);
  const legend = el("div", "legend");
  const item = (label: string, v: string) => {
    const sp = el("span");
    sp.append(el("b", undefined, `${label} `));
    sp.append(v);
    return sp;
  };
  legend.append(item("approved", l.approved_total), item("funded", l.funded), item("settled", l.settled), item(live.inflight ? "in flight ⏳" : "in flight", l.in_flight), item("fee", l.fee));
  body.append(legend);
  return root;
}

function decisionTable(s: Snapshot, st: UiState, a: Actions): HTMLElement | undefined {
  if (s.candidates.length === 0) return undefined;
  const { root, body } = card("Recommendations", `${s.candidates.filter((c) => c.outcome === "recommended").length} recommended · ${s.candidates.filter((c) => c.outcome === "rejected").length} flagged`);
  const table = el("table");
  const thead = el("thead");
  const hr = el("tr");
  for (const h of ["Product", "Shop", "Price", "Rating", "Sold", ""]) hr.append(el("th", undefined, h));
  thead.append(hr);
  table.append(thead);
  const tbody = el("tbody");
  const selected = new Set(s.selections.map((l) => l.product_id));
  for (const c of s.candidates) tbody.append(candidateRow(c, selected.has(c.product.id), st, a));
  table.append(tbody);
  body.append(table);
  if (!st.transport.canAct) body.append(el("div", "note", "Selection happens in the Claude widget; this dashboard is read-only."));
  return root;
}

function candidateRow(c: Candidate, isSelected: boolean, st: UiState, a: Actions): HTMLElement {
  const tr = el("tr", c.outcome === "rejected" ? "rejected" : isSelected ? "selected" : "");
  const name = el("td", "name");
  name.append(el("span", undefined, c.product.product_name));
  if (c.outcome === "rejected") {
    name.append(el("span", "chip agent", `flagged · agent`));
    const why = el("div", "evidence");
    why.append(el("span", undefined, c.reason ?? ""));
    if (c.evidence && Object.keys(c.evidence).length > 0) {
      why.append(el("span", "mono", `  ${Object.entries(c.evidence)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(" ")}`));
    }
    name.append(why);
  }
  tr.append(name);
  tr.append(el("td", undefined, c.product.shop_id));
  tr.append(el("td", "num mono", c.product.price));
  tr.append(el("td", "num", `${c.product.product_rating.toFixed(1)} / ${c.product.shop_rating.toFixed(1)}`));
  tr.append(el("td", "num", String(c.product.quantity_sold)));
  const act = el("td");
  if (isSelected) act.append(el("span", "chip server", "selected ✓"));
  else if (st.transport.canAct && (st.snapshot?.phase === "shopping" || st.snapshot?.phase === "checkout")) {
    const b = el("button", c.outcome === "rejected" ? "danger" : "primary", c.outcome === "rejected" ? "Select anyway" : "Select");
    b.disabled = st.busy;
    b.addEventListener("click", () => a.select(c.product.id));
    act.append(b);
  }
  tr.append(act);
  return tr;
}

function billingForm(s: Snapshot, st: UiState, a: Actions): HTMLElement | undefined {
  if (!st.transport.canAct) return undefined;
  if (s.selections.length === 0 || s.billing_present || !["shopping", "checkout"].includes(s.phase)) return undefined;
  const { root, body } = card("Billing", "never sent to the model");
  // Not a <form>: the host sandbox does not allow form submission, and a sandboxed submit never
  // even fires the submit event. A plain button reads the inputs directly; Enter does the same.
  const form = el("div", "form");
  const field = (id: string, label: string, type = "text", wide = false) => {
    const l = el("label", wide ? "wide" : "");
    l.append(label);
    const i = el("input");
    i.name = id;
    i.type = type;
    i.required = true;
    i.autocomplete = id === "email" ? "email" : id === "name" ? "name" : "street-address";
    l.append(i);
    return l;
  };
  form.append(field("name", "Name"), field("email", "Email", "email"), field("address", "Delivery address", "text", true));
  const actions = el("div", "actions wide");
  const submit = el("button", "primary", "Save billing details");
  submit.type = "button";
  submit.disabled = st.busy;
  actions.append(submit);
  actions.append(el("span", "note", "Stored on the server for this session only and deleted after the invoice is sent."));
  const problem = el("div", "err");
  actions.append(problem);
  form.append(actions);
  const save = () => {
    const get = (id: string) => (form.querySelector<HTMLInputElement>(`input[name="${id}"]`)?.value ?? "").trim();
    const b = { name: get("name"), email: get("email"), address: get("address") };
    if (!b.name || !b.address || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) {
      problem.textContent = "Please fill in a name, a valid email, and a delivery address.";
      return;
    }
    problem.textContent = "";
    a.submitBilling(b);
  };
  submit.addEventListener("click", save);
  form.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      save();
    }
  });
  body.append(form);
  return root;
}

function approvalCard(s: Snapshot, st: UiState, a: Actions): HTMLElement | undefined {
  const q = s.pending_quote;
  if (!q || !["checkout", "approved", "settling"].includes(s.phase)) return undefined;
  const { root, body } = card("Approval", q.quote_id);
  const table = el("table");
  const tb = el("tbody");
  for (const l of q.lines) {
    const tr = el("tr");
    tr.append(el("td", undefined, l.product_name));
    tr.append(el("td", "muted", l.shop_id));
    tr.append(el("td", "num mono", l.price));
    tb.append(tr);
  }
  const sum = (label: string, v: string, bold = false) => {
    const tr = el("tr");
    const td = el("td", bold ? "" : "muted", label);
    td.colSpan = 2;
    tr.append(td);
    const n = el("td", "num mono", v);
    if (bold) n.style.fontWeight = "600";
    tr.append(n);
    return tr;
  };
  tb.append(sum("Items", q.items_total), sum("Service fee (flat)", q.fee), sum("Total charged to your card", q.total, true));
  table.append(tb);
  body.append(table);
  body.append(el("div", "note", `The session wallet will hold exactly ${q.items_total} RLUSD; the agent cannot spend more. Quote expires ${new Date(q.expires_at).toLocaleTimeString()}.`));
  const actions = el("div", "actions");
  if (s.phase === "checkout" && st.transport.canAct) {
    const ok = el("button", "primary", "Approve purchase");
    ok.disabled = st.busy || st.approvedQuote === q.quote_id;
    ok.addEventListener("click", () => a.approve(q.quote_id));
    const no = el("button", "danger", "Abort session");
    no.disabled = st.busy;
    no.addEventListener("click", () => a.abort());
    actions.append(ok, no);
  } else if (s.phase === "approved") {
    actions.append(el("span", "chip server", "approved ✓"), el("span", "note", "Waiting for the agent to settle…"));
  } else if (s.phase === "settling") {
    actions.append(el("span", "chip server", "settling ⏳"), el("span", "note", "Paying the shop on XRPL; about 10 seconds."));
  }
  body.append(actions);
  return root;
}

function receipt(s: Snapshot, events: SessionEvent[]): HTMLElement | undefined {
  if (s.phase !== "done") return undefined;
  const captured = events.find((e) => e.type === "card.captured")?.payload as { amount?: string; items?: string; fee?: string } | undefined;
  const released = events.filter((e) => e.type === "card.released").at(-1)?.payload as { amount?: string } | undefined;
  const anchored = events.find((e) => e.type === "manifest.anchored")?.payload as { manifest_hash?: string; explorer?: string | null; via?: string } | undefined;
  const settled = events.filter((e) => e.type === "purchase.settled");
  const failed = events.filter((e) => e.type === "purchase.failed" || e.type === "payment.refused");
  const { root, body } = card("Receipt", "card captured");
  const kv = el("div", "kv");
  const row = (k: string, v: string | HTMLElement) => {
    kv.append(el("b", undefined, k));
    const d = el("div");
    d.append(v);
    kv.append(d);
  };
  row("Items settled", money(captured?.items ?? s.ledger.settled));
  row("Service fee", money(captured?.fee ?? s.ledger.fee));
  row("Charged to card", money(captured?.amount));
  if (released?.amount && Number(released.amount) > 0) row("Released on card", money(released.amount));
  for (const e of settled) {
    const p = e.payload as { order_id?: string; product_id?: string; explorer?: string; tx_hash?: string; invoice_sent_to?: string | null; amount?: string };
    const d = el("div");
    d.append(el("span", "mono", `${p.amount ?? ""} → ${p.product_id ?? ""}  `));
    if (p.explorer && p.tx_hash) d.append(link(p.explorer, short(p.tx_hash)));
    if (p.invoice_sent_to) d.append(el("span", "muted", `  invoice → ${p.invoice_sent_to}`));
    row("Settled", d);
  }
  for (const e of failed) {
    const p = e.payload as { rule?: string; line_id?: string };
    row("Not settled", el("span", "err", `${p.line_id ?? ""} ${p.rule ?? ""}`));
  }
  if (anchored?.manifest_hash) {
    const d = el("div");
    d.append(el("span", "mono", short(anchored.manifest_hash)));
    d.append(el("span", "muted", anchored.via === "sweep_memo" ? "  in the sweep memo " : "  in the purchase memo "));
    if (anchored.explorer) d.append(link(anchored.explorer, "view on XRPL"));
    row("Manifest", d);
  }
  body.append(kv);
  body.append(el("div", "note", "Nothing is kept: the session wallet is swept and returned to the pool; the card hold is released for anything not settled."));
  return root;
}

// ---------- feed

const ICONS: Record<string, string> = {
  "session.started": "▶", "session.aborted": "■", "session.expired": "■",
  "agent.intent": "💬",
  "browse.requested": "🔍", "browse.returned": "📦", "browse.refused": "⛔",
  "candidate.found": "•", "candidate.rejected": "🚩", "candidate.ranked": "≡", "candidate.selected": "☑",
  "billing.submitted": "🔒", "quote.ready": "🧾", "approval.granted": "✅", "approval.refused": "⛔",
  "card.authorised": "💳", "session.funded": "⬇", "payment.quoted": "402", "payment.refused": "⛔",
  "payment.submitted": "⏳", "purchase.settled": "✔", "purchase.failed": "✖", "session.swept": "⬆",
  "card.captured": "💳", "card.released": "↩", "manifest.anchored": "⚓", "invoice.sent": "✉",
};

function summary(e: SessionEvent): string {
  const p = e.payload as Record<string, unknown>;
  const s = (k: string) => (p[k] === undefined || p[k] === null ? "" : String(p[k]));
  switch (e.type) {
    case "session.started": return `session started: ${s("objective")}`;
    case "agent.intent": return `${s("tool")}: ${s("reason")}`;
    case "browse.requested": return `browse "${s("query")}" in ${s("min_price")}–${s("max_price")}`;
    case "browse.returned": return `${s("count")} in range${Number(s("nearest")) > 0 ? `, ${s("nearest")} nearest outside` : ""}`;
    case "browse.refused": return `browse refused: ${s("reason")}`;
    case "candidate.found": return `recommended ${s("product_name")} @ ${s("price")}`;
    case "candidate.rejected": return `flagged ${s("product_name")}: ${s("reason")}`;
    case "candidate.ranked": return `${s("recommended")} recommended, ${s("rejected")} flagged`;
    case "candidate.selected": return `you selected ${s("product_name")}${p.overrode_flag ? " (overriding the agent's flag)" : ""}`;
    case "billing.submitted": return "billing details recorded (content never logged)";
    case "quote.ready": return `quote ${s("quote_id")}: items ${s("items_total")} + fee ${s("fee")} = ${s("total")}`;
    case "approval.granted": return `you approved ${s("quote_id")}`;
    case "approval.refused": return `purchase refused: ${s("rule")}`;
    case "card.authorised": return `card authorised for ${s("amount")} (mock)`;
    case "session.funded": return `session wallet funded with exactly ${s("amount")} RLUSD`;
    case "payment.quoted": return `shop ${s("shop_id")} demands ${s("demanded")} (quote ${s("quoted")})`;
    case "payment.refused": return `refused: ${s("rule")}`;
    case "payment.submitted": return `paying ${s("amount")} RLUSD to ${s("shop_id")}…`;
    case "purchase.settled": return `settled ${s("amount")} RLUSD to ${s("shop_id")}${p.recovered ? " (recovered)" : ""}`;
    case "purchase.failed": return `failed: ${s("rule")}`;
    case "session.swept": return Number(s("amount")) > 0 ? `swept ${s("amount")} RLUSD back to treasury` : "nothing to sweep";
    case "manifest.anchored": return `manifest ${short(s("manifest_hash"))} anchored on XRPL`;
    case "card.captured": return `card captured ${s("amount")} (items ${s("items")} + fee ${s("fee")})`;
    case "card.released": return `card released ${s("amount")}`;
    default: return e.type;
  }
}

const FEED_TAIL = 5;

function feed(st: UiState, a: Actions, live: { inflight: boolean; inflightSince?: number }): HTMLElement {
  const { root, body } = card("Live feed", `${st.events.length} events · hash chain`);
  const list = el("div", "feed");
  const settledLines = new Set(st.events.filter((e) => e.type === "purchase.settled" || e.type === "purchase.failed").map((e) => String((e.payload as { line_id?: string }).line_id)));
  const shown = st.feedOpen ? st.events : st.events.slice(-FEED_TAIL);
  if (!st.feedOpen && st.events.length > FEED_TAIL) {
    const more = el("button", "", `show all ${st.events.length} events`);
    more.addEventListener("click", () => a.toggleFeed());
    const wrap = el("div", "note");
    wrap.append(more);
    list.append(wrap);
  }
  for (const e of shown) {
    const p = e.payload as Record<string, unknown>;
    const bad = e.type.endsWith(".refused") || e.type.endsWith(".failed") || e.type === "session.aborted" || e.type === "session.expired";
    const row = el("div", `row ${e.source === "agent" ? "agent" : ""} ${bad ? "bad" : ""}`);
    row.append(el("span", undefined, ICONS[e.type] ?? "·"));
    const sum = el("span", "sum");
    sum.append(summary(e));
    sum.append(el("span", `chip ${e.source}`, e.source === "agent" ? "agent" : "✓ server"));
    if (typeof p.explorer === "string" && typeof p.tx_hash === "string") {
      sum.append(" ");
      sum.append(link(p.explorer, short(p.tx_hash)));
    }
    row.append(sum);
    const inflightRow = e.type === "payment.submitted" && !settledLines.has(String(p.line_id));
    const dur = el("span", `dur ${inflightRow ? "live" : ""}`);
    if (inflightRow && live.inflightSince) dur.textContent = `${((Date.now() - live.inflightSince) / 1000).toFixed(1)}s…`;
    else if (e.duration_ms !== undefined) dur.textContent = `${e.duration_ms} ms`;
    else dur.textContent = new Date(e.ts).toLocaleTimeString();
    row.append(dur);
    row.addEventListener("click", () => a.toggle(e.seq));
    list.append(row);
    if (st.expanded.has(e.seq)) {
      const pre = el("pre", "payload", JSON.stringify({ seq: e.seq, span: e.span_id, parent: e.parent_span_id, payload: e.payload, hash: e.hash }, null, 1));
      list.append(pre);
    }
  }
  if (st.feedOpen) {
    const less = el("button", "", "show recent only");
    less.addEventListener("click", () => a.toggleFeed());
    const wrap = el("div", "note");
    wrap.append(less);
    list.append(wrap);
  }
  body.append(list);
  // Keep the newest events in view unless the user scrolled up to read.
  queueMicrotask(() => {
    if (feedPinnedToBottom) list.scrollTop = list.scrollHeight;
    else list.scrollTop = feedScrollTop;
    list.addEventListener("scroll", () => {
      feedScrollTop = list.scrollTop;
      feedPinnedToBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 8;
    });
  });
  return root;
}

let feedPinnedToBottom = true;
let feedScrollTop = 0;

/** The poll re-renders every second; typed input and focus must survive it. */
function captureForm(rootEl: HTMLElement): () => void {
  const values = new Map<string, string>();
  for (const i of rootEl.querySelectorAll<HTMLInputElement>("input[name]")) values.set(i.name, i.value);
  const active = document.activeElement as HTMLInputElement | null;
  const focus = active && active.tagName === "INPUT" && active.name ? { name: active.name, start: active.selectionStart, end: active.selectionEnd } : undefined;
  return () => {
    for (const i of rootEl.querySelectorAll<HTMLInputElement>("input[name]")) {
      const v = values.get(i.name);
      if (v !== undefined) i.value = v;
      if (focus && i.name === focus.name) {
        i.focus({ preventScroll: true });
        try {
          i.setSelectionRange(focus.start, focus.end);
        } catch {
          /* type=email does not support selection ranges */
        }
      }
    }
  };
}

// ---------- root render

export function render(rootEl: HTMLElement, st: UiState, a: Actions): void {
  const restore = captureForm(rootEl);
  const s = st.snapshot;
  const frag = document.createDocumentFragment();
  if (!s) {
    frag.append(el("div", "card muted", st.session_id ? `Loading session ${st.session_id}…` : "Waiting for a session. Ask Claude to start a shopping session."));
    if (st.error) frag.append(el("div", "card err", st.error));
    rootEl.replaceChildren(frag);
    restore();
    return;
  }
  const submitted = st.events.filter((e) => e.type === "payment.submitted");
  const settled = st.events.filter((e) => e.type === "purchase.settled" || e.type === "purchase.failed");
  const inflight = s.phase === "settling" || submitted.length > settled.length;
  const inflightSince = submitted.length > settled.length ? Date.parse(submitted.at(-1)!.ts) : undefined;

  // Hosts render one instance per tool call. Instances spawned by start_session or browse have
  // nothing for the user to do, so they stay compact; the propose/checkout/purchase instances
  // (and the dashboard) render the full monitor.
  const compact = st.transport.canAct && (st.spawnedBy === "start_session" || st.spawnedBy === "browse") && s.phase !== "done";
  frag.append(phaseStrip(s));
  if (compact) {
    frag.append(feed(st, a, { inflight, ...(inflightSince ? { inflightSince } : {}) }));
  } else {
    const rec = receipt(s, st.events);
    if (rec) frag.append(rec);
    frag.append(budgetBar(s, { inflight }));
    const appr = approvalCard(s, st, a);
    if (appr) frag.append(appr);
    const form = billingForm(s, st, a);
    if (form) frag.append(form);
    const table = decisionTable(s, st, a);
    if (table) frag.append(table);
    frag.append(feed(st, a, { inflight, ...(inflightSince ? { inflightSince } : {}) }));
  }
  if (st.error) frag.append(el("div", "card err", st.error));
  if (st.hint) frag.append(el("div", "card note", st.hint));
  const foot = el("div", "note mono", `${st.transport.label} · ${st.session_id ?? ""} · seq ${s.head_seq}${s.pool ? ` · pool idle ${s.pool.idle ?? 0}` : ""}`);
  frag.append(foot);
  rootEl.replaceChildren(frag);
  restore();
}
