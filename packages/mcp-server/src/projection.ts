import type { Candidate, Money, Quote, SessionEvent, SessionPhase, SessionSnapshot, SessionStep } from "@aishop4u/shared";

/**
 * Rebuild a read-only snapshot from the event chain alone (CLAUDE.md §10: "the event
 * stream is the source of truth for the monitor").
 *
 * Why: Claude Desktop launches the stdio server more than once, and each process has
 * its own in-memory SessionManager. Whichever process serves HTTP must still be able
 * to show any session, so the dashboard reads the log, not the manager. Billing
 * content is not in the log by design; only its presence is.
 */
export function projectSnapshot(events: SessionEvent[]): SessionSnapshot | undefined {
  if (events.length === 0) return undefined;
  const first = events[0]!;
  const session_id = first.session_id;
  let objective = "";
  let fee: Money = "0.00";
  let phase: SessionPhase = "started";
  let step: SessionStep = "preferences";
  let price_range: { min: Money; max: Money } | undefined;
  let candidates: Candidate[] = [];
  const selections: SessionSnapshot["selections"] = [];
  let billing_present = false;
  let pending_quote: Quote | undefined;
  let approved_total: Money | undefined;
  let funded: Money = "0.00";
  let settled: Money = "0.00";
  let in_flight: Money = "0.00";
  let submitted = 0;
  let resolved = 0;

  const str = (p: Record<string, unknown>, k: string): string => (typeof p[k] === "string" ? (p[k] as string) : String(p[k] ?? ""));
  const num = (p: Record<string, unknown>, k: string): number => (typeof p[k] === "number" ? (p[k] as number) : Number(p[k] ?? 0));

  for (const e of events) {
    const p = e.payload;
    switch (e.type) {
      case "session.started":
        objective = str(p, "objective");
        fee = str(p, "fee") || "0.00";
        phase = "shopping";
        break;
      case "browse.refused":
        step = "preferences";
        reopen();
        break;
      case "browse.requested":
        price_range = { min: str(p, "min_price"), max: str(p, "max_price") };
        candidates = [];
        step = "browse";
        reopen();
        break;
      case "candidate.found":
      case "candidate.rejected": {
        const product = {
          id: str(p, "product_id"),
          shop_id: str(p, "shop_id"),
          product_name: str(p, "product_name"),
          description: "",
          price: str(p, "price"),
          currency: "RLUSD" as const,
          product_rating: num(p, "product_rating"),
          shop_rating: num(p, "shop_rating"),
          quantity_sold: num(p, "quantity_sold"),
          stock: num(p, "stock"),
        };
        if (e.type === "candidate.found") candidates.push({ product, outcome: "recommended" });
        else {
          const evidence = (p.evidence ?? {}) as Record<string, string | number>;
          candidates.push({ product, outcome: "rejected", reason: str(p, "reason"), ...(Object.keys(evidence).length > 0 ? { evidence } : {}) });
        }
        break;
      }
      case "candidate.ranked":
        step = "select";
        reopen();
        break;
      case "candidate.selected":
        selections.push({ line_id: str(p, "line_id"), product_id: str(p, "product_id"), shop_id: str(p, "shop_id"), product_name: str(p, "product_name"), price: str(p, "price") });
        step = billing_present ? "select" : "billing";
        reopen();
        break;
      case "billing.submitted":
        billing_present = true;
        step = "billing";
        reopen();
        break;
      case "quote.ready":
        pending_quote = {
          quote_id: str(p, "quote_id"),
          lines: (p.lines as Quote["lines"]) ?? [],
          items_total: str(p, "items_total"),
          fee: str(p, "fee"),
          total: str(p, "total"),
          quote_hash: str(p, "quote_hash"),
          expires_at: str(p, "expires_at"),
        };
        approved_total = pending_quote.total;
        phase = "checkout";
        step = "approve";
        break;
      case "approval.granted":
        phase = "approved";
        step = "settle";
        break;
      case "approval.refused":
        if (str(p, "rule") === "approval_expired") phase = "checkout";
        break;
      case "card.authorised":
        phase = "settling";
        step = "settle";
        break;
      case "session.funded":
        funded = str(p, "amount");
        in_flight = funded;
        break;
      case "payment.submitted":
        submitted += 1;
        break;
      case "purchase.settled":
        resolved += 1;
        settled = addMoney(settled, str(p, "amount"));
        break;
      case "purchase.failed":
        if (p.line_id !== undefined) resolved += 1;
        break;
      case "card.captured":
        settled = str(p, "items") || settled;
        in_flight = "0.00";
        phase = "done";
        billing_present = false;
        break;
      case "card.released":
        if (str(p, "reason") === "nothing_settled") {
          in_flight = "0.00";
          phase = "done";
          billing_present = false;
        }
        break;
      case "session.aborted":
        phase = "aborted";
        billing_present = false;
        pending_quote = undefined;
        break;
      case "session.expired":
        phase = "expired";
        billing_present = false;
        pending_quote = undefined;
        break;
      default:
        break;
    }
  }
  if (phase === "settling" && submitted > resolved) in_flight = funded;
  else if (phase === "settling") in_flight = subMoney(funded, settled);

  function reopen(): void {
    if (phase === "checkout" || phase === "approved") {
      phase = "shopping";
      pending_quote = undefined;
      approved_total = undefined;
    }
  }

  return {
    session_id,
    objective,
    phase,
    step,
    ...(price_range ? { price_range } : {}),
    ledger: { ...(approved_total ? { approved_total } : {}), funded, settled, in_flight, fee },
    candidates,
    selections,
    billing_present,
    ...(pending_quote ? { pending_quote } : {}),
    head_seq: events[events.length - 1]!.seq,
  };
}

function addMoney(a: Money, b: Money): Money {
  return (Math.round((Number(a) + Number(b)) * 100) / 100).toFixed(2);
}
function subMoney(a: Money, b: Money): Money {
  return Math.max(0, Math.round((Number(a) - Number(b)) * 100) / 100).toFixed(2);
}
