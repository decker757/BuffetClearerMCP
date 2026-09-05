import { Wallet } from "xrpl";
import { decodePaymentRequiredHeader, x402Purchase, type PaymentHeaderFactory } from "x402-xrpl";
import { pickRlusdOption, policySelector } from "./policy.js";
import { EXPLORER_TX, type Delivery, type EventSink, type Ledger, type Line, type RegisteredShop, type RlusdAsset } from "./types.js";

/**
 * Pays one approved order line to one shop over x402 (CLAUDE.md §7).
 *
 * One span per line. Events, in order: payment.quoted (the 402), then either
 * payment.refused (policy, nothing signed), payment.submitted + purchase.settled,
 * or purchase.failed (bounded loss: at most this line).
 *
 * Idempotent on invoice_ref: before paying we ask the shop whether this ref is
 * already an order, and we verify that claim against the ledger before believing
 * it. After a failed paid request we ask again, because the facilitator may have
 * settled even though the HTTP response was lost.
 */
export interface PayLineInput {
  session_id: string;
  line: Line;
  invoice_ref: string;
  shop: RegisteredShop;
  shopsUrl: string;
  wallet: { seed: string; address: string };
  /** every address that could legitimately have paid this ref (this wallet plus earlier attempts) */
  payers: string[];
  delivery: Delivery;
  rlusd: RlusdAsset;
  network: "xrpl:0" | "xrpl:1" | "xrpl:2";
  ledger: Ledger;
  sink: EventSink;
  parent_span_id?: string;
  /** Test seams: skip real signing / real network. */
  fetchImpl?: typeof fetch;
  paymentHeaderFactory?: PaymentHeaderFactory;
  wsUrl?: string;
}

export interface PayLineResult {
  ok: true;
  order_id: string;
  tx_hash: string;
  explorer: string;
  invoice_sent_to: string;
  /** the confirmation came from asking the shop, not from the paid request's own response */
  already_settled: boolean;
  /**
   * A payment was sent from THIS session wallet during THIS run, so the line is
   * part of the wallet's balance delta. Not the same as `!already_settled`: a
   * shop can take the money and return a body we cannot read, and the line is
   * then both recovered and paid this run. Reconciliation keys on this
   * (REVIEW-LOG phase 8).
   */
  paid_this_run: boolean;
}
export interface PayLineRefused {
  ok: false;
  kind: "refused" | "failed";
  rule: string;
  message: string;
  /** set when money may have moved (bounded loss for this line) */
  tx_hash?: string;
}

interface OrderResponse {
  order_id: string;
  tx_hash: string;
  product_id?: string;
  invoice_sent_to?: string;
  status: string;
}

/** SDK reasons that mean nothing was signed: classify as refusals, not failures. */
const UNSIGNED_REASONS = new Set(["no_accepts", "invalid_payment_required", "invalid_payment_requirements", "wsUrl_required"]);

/**
 * Recovery only: is this line already settled at the shop AND on the ledger?
 * Emits purchase.settled(recovered) when it is. Emits nothing otherwise.
 */
export async function probeLine(input: PayLineInput): Promise<PayLineResult | undefined> {
  const t0 = Date.now();
  const base = { span_id: `pay_${input.line.line_id}`, ...(input.parent_span_id ? { parent_span_id: input.parent_span_id } : {}) };
  const recovered = await recover(input, input.fetchImpl ?? fetch);
  if (!recovered) return undefined;
  input.sink.emit({ ...base, type: "purchase.settled", source: "server", duration_ms: Date.now() - t0, payload: settledPayload(input.line, recovered, true) });
  return ok(recovered, true);
}

export async function payLine(input: PayLineInput): Promise<PayLineResult | PayLineRefused> {
  const { sink, line, invoice_ref } = input;
  const span_id = `pay_${line.line_id}`;
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = { span_id, ...(input.parent_span_id ? { parent_span_id: input.parent_span_id } : {}) };
  const t0 = Date.now();
  const url = `${input.shopsUrl}/shops/${encodeURIComponent(line.shop_id)}/orders/${encodeURIComponent(line.product_id)}`;

  // 0. Recovery: did this line already settle (lost response, restart)? Verified against the ledger.
  const recovered = await recover(input, fetchImpl);
  if (recovered) {
    sink.emit({ ...base, type: "purchase.settled", source: "server", duration_ms: Date.now() - t0, payload: settledPayload(line, recovered, true) });
    return ok(recovered, true);
  }

  const body = JSON.stringify({ invoice_ref, delivery: input.delivery });
  const headers = { "content-type": "application/json" };
  const ctx = { line, shop: input.shop, rlusd: input.rlusd, network: input.network };

  // 1. Quote: fetch the 402 ourselves first so the terms are an event before any decision.
  let examined: Record<string, unknown> | undefined;
  try {
    const first = await fetchImpl(url, { method: "POST", headers, body });
    if (first.status === 402) {
      const pr = first.headers.get("PAYMENT-REQUIRED");
      const accepts = (pr ? decodePaymentRequiredHeader(pr).accepts : []) as unknown as Array<Record<string, unknown>>;
      examined = pickRlusdOption(accepts, ctx) ?? accepts[0];
      sink.emit({
        ...base,
        type: "payment.quoted",
        source: "server",
        payload: {
          line_id: line.line_id,
          shop_id: line.shop_id,
          product_id: line.product_id,
          quoted: line.price,
          demanded: examined?.amount ?? null,
          asset: examined?.asset ?? null,
          payTo: examined?.payTo ?? null,
          invoice_id: (examined?.extra as Record<string, unknown> | undefined)?.invoiceId ?? null,
          options_offered: accepts.length,
        },
      });
    } else if (first.status === 200) {
      // The shop says this ref is settled but our recovery check did not confirm it on-ledger.
      return fail(sink, base, line, t0, "unverified_settlement_claim", "shop returned an order for our ref that the ledger does not confirm");
    } else {
      return fail(sink, base, line, t0, "shop_error", `shop returned HTTP ${first.status}`);
    }
  } catch (e) {
    return fail(sink, base, line, t0, "shop_unreachable", e instanceof Error ? e.message : String(e));
  }

  // 2. Pay through the SDK with our policy as the selector. A policy throw becomes
  //    status "payment_required" with the reason, and nothing is signed.
  const result = await x402Purchase({
    url,
    method: "POST",
    headers,
    body,
    wallet: Wallet.fromSeed(input.wallet.seed),
    network: input.network,
    ...(input.wsUrl ? { wsUrl: input.wsUrl } : {}),
    paymentRequirementsSelector: policySelector(ctx),
    ...(input.paymentHeaderFactory ? { paymentHeaderFactory: input.paymentHeaderFactory } : {}),
    fetchImpl,
  });

  if (result.status === "payment_required") {
    const reason = result.reason ?? "";
    const policy = parsePolicyReason(reason);
    const rule = policy?.rule ?? (UNSIGNED_REASONS.has(reason) ? reason : undefined);
    if (rule) {
      sink.emit({
        ...base,
        type: "payment.refused",
        source: "server",
        duration_ms: Date.now() - t0,
        payload: { line_id: line.line_id, shop_id: line.shop_id, rule, message: policy?.message ?? reason, quoted: line.price, demanded: examined?.amount ?? null },
      });
      return { ok: false, kind: "refused", rule, message: policy?.message ?? reason };
    }
    // The shop 402'd again after we sent a payment header: maybe settled, maybe not. Ask the ledger.
    return await afterUncertainPayment(input, fetchImpl, sink, base, t0, "shop_re_402", reason || "shop re-issued 402 after payment", undefined, true);
  }
  if (result.status === "declined" || result.status === "requires_confirmation") {
    // Verifiable-intent provider outcomes; we run none, so this cannot happen, but it is unsigned.
    sink.emit({ ...base, type: "payment.refused", source: "server", duration_ms: Date.now() - t0, payload: { line_id: line.line_id, rule: result.status, message: result.reason ?? "" } });
    return { ok: false, kind: "refused", rule: result.status, message: result.reason ?? "" };
  }
  if (result.status === "failed") {
    // Could be before or after the paid request; the ledger decides.
    /**
     * `sdk_failed` covers both "died before signing" and "signed, and we lost the
     * response". We cannot tell them apart from here, so we assume the payment went
     * out: the alternative marks every lost-response settlement unreconciled, which
     * is the false alarm this flag exists to prevent. Getting it wrong the other way
     * can only over-count `settledThisRun` against the ledger delta, which raises
     * `unreconciled` — it can never inflate a capture, because the capture is
     * computed from the delta. REVIEW-LOG phase 8.
     */
    return await afterUncertainPayment(input, fetchImpl, sink, base, t0, "sdk_failed", result.reason ?? "unknown", result.transaction, true);
  }
  if (!result.response) return fail(sink, base, line, t0, "no_response", "SDK returned success without a response");

  sink.emit({
    ...base,
    type: "payment.submitted",
    source: "server",
    payload: { line_id: line.line_id, shop_id: line.shop_id, amount: line.price, asset: "RLUSD", payTo: input.shop.payTo, from: input.wallet.address, tx_hash: result.transaction ?? null },
  });

  let order: OrderResponse | undefined;
  try {
    order = (await result.response.json()) as OrderResponse;
  } catch {
    order = undefined;
  }
  if (!order?.order_id) {
    return await afterUncertainPayment(input, fetchImpl, sink, base, t0, "order_unparseable", `order body unreadable; tx ${result.transaction ?? "?"}`, result.transaction, true);
  }
  const settled = { ...order, tx_hash: order.tx_hash ?? result.transaction ?? "" };
  sink.emit({ ...base, type: "purchase.settled", source: "server", duration_ms: Date.now() - t0, payload: settledPayload(line, settled, false) });
  return ok(settled, false, true);
}

/** Ask the shop for an order by ref and confirm it on the ledger. Undefined unless both agree. */
async function recover(input: PayLineInput, fetchImpl: typeof fetch): Promise<OrderResponse | undefined> {
  try {
    const r = await fetchImpl(`${input.shopsUrl}/orders?invoice_ref=${encodeURIComponent(input.invoice_ref)}`);
    if (r.status !== 200) return undefined;
    const o = (await r.json()) as OrderResponse;
    if (o.product_id !== undefined && o.product_id !== input.line.product_id) return undefined;
    if (typeof o.tx_hash !== "string") return undefined;
    const verified = await input.ledger.verifyPayment({
      hash: o.tx_hash,
      from: input.payers,
      to: input.shop.payTo,
      value: input.line.price,
      invoiceRef: input.invoice_ref,
    });
    return verified ? o : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Something went wrong after a payment header may have been sent. If the ledger
 * confirms the shop has an order for our ref, it settled. Otherwise it is a failure
 * with the loss bounded to this line, and the tx hash (if any) recorded for a human.
 */
async function afterUncertainPayment(
  input: PayLineInput,
  fetchImpl: typeof fetch,
  sink: EventSink,
  base: { span_id: string; parent_span_id?: string },
  t0: number,
  rule: string,
  message: string,
  tx_hash?: string,
  /**
   * Whether a payment definitely went out from this wallet in this run. Passed in
   * rather than assumed: `sdk_failed` fires for SDK errors that happen before
   * anything is signed, and counting one of those towards this run's spend would
   * let a line a PREVIOUS run paid inflate the reconciliation total.
   */
  sentPayment = false,
): Promise<PayLineResult | PayLineRefused> {
  const recovered = await recover(input, fetchImpl);
  if (recovered) {
    // The ledger confirms the shop has the money. If we sent the payment, the
    // wallet's balance moved here, so the line counts towards this run's spend.
    sink.emit({ ...base, type: "purchase.settled", source: "server", duration_ms: Date.now() - t0, payload: { ...settledPayload(input.line, recovered, true), after: rule } });
    return ok(recovered, true, sentPayment);
  }
  return fail(sink, base, input.line, t0, rule, message, tx_hash);
}

function ok(o: OrderResponse, already: boolean, paid_this_run = false): PayLineResult {
  return { ok: true, order_id: o.order_id, tx_hash: o.tx_hash, explorer: EXPLORER_TX + o.tx_hash, invoice_sent_to: o.invoice_sent_to ?? "", already_settled: already, paid_this_run };
}

function settledPayload(line: Line, o: OrderResponse, recovered: boolean): Record<string, unknown> {
  return {
    line_id: line.line_id,
    shop_id: line.shop_id,
    product_id: line.product_id,
    order_id: o.order_id,
    amount: line.price,
    asset: "RLUSD",
    tx_hash: o.tx_hash,
    explorer: EXPLORER_TX + o.tx_hash,
    invoice_sent_to: o.invoice_sent_to ?? null,
    recovered,
  };
}

function fail(
  sink: EventSink,
  base: { span_id: string; parent_span_id?: string },
  line: Line,
  t0: number,
  rule: string,
  message: string,
  tx_hash?: string,
): PayLineRefused {
  sink.emit({
    ...base,
    type: "purchase.failed",
    source: "server",
    duration_ms: Date.now() - t0,
    payload: { line_id: line.line_id, shop_id: line.shop_id, rule, message, bounded_loss: line.price, tx_hash: tx_hash ?? null },
  });
  return { ok: false, kind: "failed", rule, message, ...(tx_hash ? { tx_hash } : {}) };
}

/** PolicyError messages travel through the SDK as a string; recover rule + message. */
function parsePolicyReason(reason: string): { rule: string; message: string } | undefined {
  const m = /^policy:([a-z_0-9]+):(.*)$/s.exec(reason);
  return m ? { rule: m[1]!, message: m[2]! } : undefined;
}
