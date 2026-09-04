import type { SessionEvent } from "@buffet/shared";
import { render, type Actions, type UiState } from "./render.js";
import { HostTransport, HttpTransport, type Transport } from "./transport.js";

/**
 * Bootstrap. Inside Claude the host bridge connects and the widget acts through the
 * app-only tools. Opened as a page with ?session=<id> it becomes the read-only
 * dashboard over the HTTP reads (CLAUDE.md §12 "exposed twice").
 *
 * Server-side state only: on every init we reload from the snapshot, and the
 * feed is rebuilt from session_events. Nothing lives in this iframe.
 */

const rootMaybe = document.getElementById("app");
if (!rootMaybe) throw new Error("no #app");
const root: HTMLElement = rootMaybe;

const POLL_MS = 1000;

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const urlSession = params.get("session") ?? undefined;
  const isDashboard = urlSession !== undefined && !inIframeOfHost();
  // The dashboard only ever talks to its own origin: a ?base= override would let a hostile page feed us links.
  const transport: Transport = isDashboard ? new HttpTransport(location.origin) : new HostTransport();

  const st: UiState = { events: [], expanded: new Set(), busy: false, transport, ...(urlSession ? { session_id: urlSession } : {}) };
  let headSeq = 0;
  let timer: number | undefined;

  let lastKey = "";
  const draw = (force = false) => {
    // Skip identical frames: fewer re-renders means less flicker while the user is typing.
    const s = st.snapshot;
    const key = s ? [s.head_seq, s.phase, s.step, s.selections.length, s.billing_present, st.busy, st.error, st.hint, st.expanded.size, st.session_id].join("|") : `none|${st.session_id}|${st.error}`;
    if (!force && key === lastKey) return;
    lastKey = key;
    try {
      render(root, st, actions);
    } catch (e) {
      console.error("[buffet widget] render failed:", e);
      root.replaceChildren(Object.assign(document.createElement("div"), { className: "card err", textContent: `render failed: ${e instanceof Error ? e.message : String(e)}` }));
    }
  };

  const refresh = async (): Promise<void> => {
    const sid = st.session_id;
    if (!sid) return draw();
    // Fetched separately: a snapshot 404 after a server restart must not hide the events the log still serves.
    try {
      const snap = await transport.snapshot(sid);
      if (sid !== st.session_id) return; // the session switched while we were waiting
      if (!st.snapshot || snap.head_seq >= st.snapshot.head_seq) st.snapshot = snap;
      st.error = undefined;
    } catch (e) {
      if (sid !== st.session_id) return;
      st.error = e instanceof Error ? e.message : String(e);
    }
    try {
      const ev = await transport.events(sid, headSeq);
      if (sid !== st.session_id) return;
      if (ev.events.length > 0) {
        st.events = mergeEvents(st.events, ev.events);
        headSeq = Math.max(headSeq, ev.head_seq);
      }
    } catch (e) {
      if (sid !== st.session_id) return;
      st.error = st.error ?? (e instanceof Error ? e.message : String(e));
    }
    draw();
  };

  const act = async (fn: () => Promise<void>, nudge?: { text: string; fallback: string }): Promise<void> => {
    st.busy = true;
    st.error = undefined;
    st.hint = undefined;
    draw();
    let done = false;
    try {
      await fn();
      done = true;
    } catch (e) {
      st.error = e instanceof Error ? e.message : String(e);
    }
    // The server action is what matters; a failed refresh must not stop the nudge.
    try {
      await refresh();
    } catch {
      /* refresh reports its own error */
    }
    if (done && nudge) {
      const delivered = await transport.nudge(nudge.text);
      if (!delivered && transport.canAct) st.hint = nudge.fallback;
    }
    st.busy = false;
    draw(true);
  };

  // Nudges name server-generated ids only. Never a product title: that is seller text, and a
  // nudge is delivered to the model as the user speaking (invariant 4).
  const actions: Actions = {
    select: (product_id) =>
      act(() => transport.select(st.session_id!, product_id), {
        text: `I selected product ${product_id} in the widget. Is there anything else I should add, or shall we proceed?`,
        fallback: "Selected. Tell Claude in the chat that you have chosen, or that you want to add another item.",
      }),
    submitBilling: (b) =>
      act(() => transport.submitBilling(st.session_id!, b), {
        text: "I entered my billing details in the widget. Please proceed to checkout.",
        fallback: "Billing saved. Tell Claude in the chat to proceed to checkout.",
      }),
    approve: (quote_id) =>
      act(
        async () => {
          await transport.approve(st.session_id!, quote_id);
          st.approvedQuote = quote_id;
        },
        { text: `I approved quote ${quote_id} in the widget. Please complete the purchase.`, fallback: "Approved. Tell Claude in the chat to complete the purchase." },
      ),
    abort: () => act(() => transport.abort(st.session_id!), { text: "I aborted the session in the widget.", fallback: "Aborted. Tell Claude in the chat that you stopped the session." }),
    toggle: (seq) => {
      if (st.expanded.has(seq)) st.expanded.delete(seq);
      else st.expanded.add(seq);
      draw(true);
    },
  };

  // A tool result from the host carries the session id (start_session) and means state changed.
  transport.onToolResult = (structured) => {
    const sid = typeof structured.session_id === "string" ? structured.session_id : undefined;
    if (sid && sid !== st.session_id) {
      st.session_id = sid;
      st.snapshot = undefined;
      st.events = [];
      st.expanded.clear();
      st.hint = undefined;
      headSeq = 0;
    }
    void refresh();
  };

  draw();
  if (transport instanceof HostTransport) {
    try {
      await transport.connect();
    } catch (e) {
      st.error = `host connect failed: ${e instanceof Error ? e.message : String(e)}`;
      draw();
      return;
    }
  }
  await refresh();
  timer = window.setInterval(() => void refresh(), POLL_MS);
  window.addEventListener("beforeunload", () => window.clearInterval(timer));
}

function mergeEvents(have: SessionEvent[], more: SessionEvent[]): SessionEvent[] {
  const bySeq = new Map(have.map((e) => [e.seq, e]));
  for (const e of more) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function inIframeOfHost(): boolean {
  // Inside Claude the widget is an iframe with no query string; the dashboard is a top-level page with ?session=.
  try {
    return window.parent !== window && !new URLSearchParams(location.search).has("session");
  } catch {
    return true;
  }
}

void boot();
