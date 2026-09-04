import { add, eq, lt, sub, toCents, type Money, type Quote } from "@buffet/shared";
import type { PaymentHeaderFactory } from "x402-xrpl";
import type { CardAuthoriser } from "./card.js";
import type { WalletPool } from "./pool.js";
import { payLine, probeLine, type PayLineRefused, type PayLineResult } from "./x402client.js";
import { EXPLORER_TX, PolicyError, type Delivery, type EventSink, type Ledger, type RegisteredShop, type RlusdAsset } from "./types.js";

/**
 * Settle an approved quote (CLAUDE.md §15.4). The order of operations is the product:
 *
 *   0. recovery           lines already settled (a retry) are recognised, verified on-ledger, and not funded
 *   1. wallet + card      acquire a pool wallet, then authorise the card for the full total
 *   2. session.funded     treasury -> session wallet, exactly what the unsettled lines need
 *   3. per line           payLine: quoted / refused / submitted / settled / failed
 *   4. session.swept      anything unspent -> treasury, memo = manifest hash
 *   5. card.captured      what the LEDGER says left the wallet, plus the fee; the rest released
 *
 * The wallet holds exactly the item total, so the sum of lines cannot exceed it
 * (invariant 1). The card is never captured for more than the wallet actually spent
 * (invariant 6): `spent = funded - remaining` is read from the ledger, not from what
 * shops claimed. Lines are paid sequentially: one XRPL account, one sequence stream.
 */
export interface SettleInput {
  session_id: string;
  quote: Quote;
  manifest_hash: string;
  delivery: Delivery;
  shops: Record<string, RegisteredShop>;
  shopsUrl: string;
  treasury: { seed: string; address: string };
  pool: WalletPool;
  ledger: Ledger;
  card: CardAuthoriser;
  rlusd: RlusdAsset;
  network: "xrpl:0" | "xrpl:1" | "xrpl:2";
  sink: EventSink;
  /** Test seams passed through to payLine. */
  fetchImpl?: typeof fetch;
  paymentHeaderFactory?: PaymentHeaderFactory;
  wsUrl?: string;
}

export interface LineOutcome {
  line_id: string;
  product_id: string;
  shop_id: string;
  price: Money;
  result: PayLineResult | PayLineRefused;
}

export interface SettleResult {
  ok: boolean;
  auth_id: string;
  wallet: string;
  /** what this run moved into the wallet (0 on a fully recovered retry) */
  funded: Money;
  /** sum of lines the shops confirmed, verified on-ledger where recovered */
  settled: Money;
  /** what the ledger says left the wallet this run; the card is captured on this */
  spent: Money;
  released: Money;
  fee: Money;
  captured: Money;
  reconciled: boolean;
  fund_tx?: string;
  sweep_tx?: string;
  card_error?: string;
  lines: LineOutcome[];
}

export async function settlePurchase(input: SettleInput): Promise<SettleResult> {
  const { sink, quote, session_id, ledger } = input;
  const span = `purchase_${quote.quote_id}`;

  // Guard: every line's shop must be registered before any money moves.
  for (const line of quote.lines) {
    if (!input.shops[line.shop_id]) throw new PolicyError("shop_not_registered", `line ${line.line_id} names unknown shop ${line.shop_id}`);
  }

  // 1a. Wallet first, so a refusal here costs nothing on the card.
  let wallet: { address: string; seed: string };
  try {
    wallet = input.pool.acquire(session_id);
  } catch (e) {
    sink.emit({ type: "payment.refused", source: "server", span_id: span, payload: { rule: "pool_exhausted", counts: input.pool.counts() } });
    throw e;
  }
  const payers = [wallet.address, ...input.pool.status().map((s) => s.address)];

  // 0. Recovery: lines a previous attempt already settled (verified on-ledger inside payLine).
  const lines: LineOutcome[] = [];
  let recoveredTotal: Money = "0.00";
  const pending = [] as Quote["lines"];
  for (const line of quote.lines) {
    const probe = await probeLine(lineInput(input, line, wallet, payers, span));
    if (probe) {
      lines.push({ ...pick(line), result: probe });
      recoveredTotal = add(recoveredTotal, line.price);
    } else {
      pending.push(line);
    }
  }
  const toFund: Money = sub(quote.items_total, recoveredTotal);

  // 1b. Card authorisation for the full total.
  let auth_id: string;
  try {
    ({ auth_id } = await input.card.authorise({ session_id, amount: quote.total, currency: "USD" }));
  } catch (e) {
    input.pool.transition(wallet.address, "idle");
    throw e;
  }
  sink.emit({ type: "card.authorised", source: "server", span_id: span, payload: { auth_id, amount: quote.total, currency: "USD", mocked: true } });

  // 2. Fund the session wallet with exactly what the pending lines need.
  let fund_tx: string | undefined;
  let funded: Money = "0.00";
  if (toCents(toFund) > 0n) {
    const tf = Date.now();
    try {
      fund_tx = await ledger.payRlusd({
        fromSeed: input.treasury.seed,
        to: wallet.address,
        value: toFund,
        memo: { type: "buffet/fund", data: JSON.stringify({ session_id, quote_id: quote.quote_id }) },
      });
      funded = toFund;
    } catch (e) {
      // A timeout can validate anyway. If the wallet holds the money, carry on; otherwise stop cleanly.
      const bal = await ledger.rlusdBalance(wallet.address).catch(() => "0.00" as Money);
      if (eq(bal, toFund)) {
        funded = toFund;
        sink.emit({ type: "session.funded", source: "server", span_id: span, duration_ms: Date.now() - tf, payload: { wallet: wallet.address, amount: toFund, asset: "RLUSD", tx_hash: null, note: "confirmed by balance after submit error" } });
      } else {
        input.pool.transition(wallet.address, "attention");
        await safeRelease(input, auth_id, quote.total, "funding_failed", span);
        throw e;
      }
    }
    if (fund_tx) {
      sink.emit({
        type: "session.funded",
        source: "server",
        span_id: span,
        duration_ms: Date.now() - tf,
        payload: { wallet: wallet.address, amount: toFund, asset: "RLUSD", tx_hash: fund_tx, explorer: EXPLORER_TX + fund_tx },
      });
    }
  }
  const startBalance = await ledger.rlusdBalance(wallet.address);

  // 3. Pay each pending line, sequentially, checking the wallet can cover it first (budget is the balance).
  input.pool.transition(wallet.address, "paying");
  for (const line of pending) {
    const spendable = await ledger.rlusdBalance(wallet.address);
    if (lt(spendable, line.price)) {
      sink.emit({
        type: "payment.refused",
        source: "server",
        span_id: `pay_${line.line_id}`,
        parent_span_id: span,
        payload: { line_id: line.line_id, rule: "insufficient_funded", spendable, needed: line.price },
      });
      lines.push({ ...pick(line), result: { ok: false, kind: "refused", rule: "insufficient_funded", message: `wallet holds ${spendable}, line needs ${line.price}` } });
      continue;
    }
    const result = await payLine(lineInput(input, line, wallet, payers, span));
    lines.push({ ...pick(line), result });
  }
  // Keep quote order for the caller.
  lines.sort((a, b) => quote.lines.findIndex((l) => l.line_id === a.line_id) - quote.lines.findIndex((l) => l.line_id === b.line_id));
  const settledThisRun = lines.filter((l) => l.result.ok && !l.result.already_settled).reduce<Money>((acc, l) => add(acc, l.price), "0.00");
  const settled = lines.filter((l) => l.result.ok).reduce<Money>((acc, l) => add(acc, l.price), "0.00");

  // 4. Sweep whatever is left back to treasury, manifest hash in the memo. Reconcile against the ledger.
  input.pool.transition(wallet.address, "sweeping");
  let sweep_tx: string | undefined;
  let released: Money = "0.00";
  let spent: Money = settledThisRun;
  let reconciled = true;
  try {
    const remaining = await ledger.rlusdBalance(wallet.address);
    spent = toCents(startBalance) >= toCents(remaining) ? sub(startBalance, remaining) : "0.00";
    if (!eq(spent, settledThisRun)) {
      reconciled = false;
      sink.emit({
        type: "purchase.failed",
        source: "server",
        span_id: span,
        payload: { rule: "unreconciled", message: "ledger delta differs from confirmed lines", ledger_spent: spent, lines_settled: settledThisRun, wallet: wallet.address },
      });
    }
    if (toCents(remaining) > 0n) {
      const ts = Date.now();
      sweep_tx = await ledger.payRlusd({
        fromSeed: wallet.seed,
        to: input.treasury.address,
        value: remaining,
        memo: { type: "buffet/manifest", data: JSON.stringify({ session_id, quote_id: quote.quote_id, manifest: input.manifest_hash }) },
      });
      released = remaining;
      sink.emit({
        type: "session.swept",
        source: "server",
        span_id: span,
        duration_ms: Date.now() - ts,
        payload: { wallet: wallet.address, amount: remaining, asset: "RLUSD", tx_hash: sweep_tx, explorer: EXPLORER_TX + sweep_tx, manifest_hash: input.manifest_hash },
      });
      sink.emit({ type: "manifest.anchored", source: "server", span_id: span, payload: { manifest_hash: input.manifest_hash, tx_hash: sweep_tx, explorer: EXPLORER_TX + sweep_tx, via: "sweep_memo" } });
    } else {
      // Nothing left: the manifest rode in the last purchase's invoice memo instead.
      const last = [...lines].reverse().find((l) => l.result.ok);
      const tx = last && last.result.ok ? last.result.tx_hash : null;
      sink.emit({ type: "session.swept", source: "server", span_id: span, payload: { wallet: wallet.address, amount: "0.00", asset: "RLUSD", tx_hash: null, manifest_hash: input.manifest_hash } });
      sink.emit({ type: "manifest.anchored", source: "server", span_id: span, payload: { manifest_hash: input.manifest_hash, tx_hash: tx, explorer: tx ? EXPLORER_TX + tx : null, via: "invoice_memo" } });
    }
    input.pool.transition(wallet.address, "idle");
  } catch (e) {
    input.pool.transition(wallet.address, "attention");
    sink.emit({ type: "purchase.failed", source: "server", span_id: span, payload: { rule: "sweep_failed", message: e instanceof Error ? e.message : String(e), wallet: wallet.address } });
  }

  // 5. Card: capture what the ledger says was spent (plus recovered lines, verified on-ledger) and the fee.
  //    Never more than authorised. Release only if nothing is captured; a partial capture releases the rest.
  const chargeable: Money = add(spent, recoveredTotal);
  let captured: Money = "0.00";
  let card_error: string | undefined;
  try {
    if (toCents(chargeable) > 0n) {
      captured = add(chargeable, quote.fee);
      if (toCents(captured) > toCents(quote.total)) captured = quote.total;
      await input.card.capture({ auth_id, amount: captured });
      sink.emit({ type: "card.captured", source: "server", span_id: span, payload: { auth_id, amount: captured, items: chargeable, fee: quote.fee, currency: "USD", mocked: true } });
      const leftover = sub(quote.total, captured);
      if (toCents(leftover) > 0n) {
        sink.emit({ type: "card.released", source: "server", span_id: span, payload: { auth_id, amount: leftover, reason: "lines_failed", via: "partial_capture" } });
      }
    } else {
      await input.card.release({ auth_id });
      sink.emit({ type: "card.released", source: "server", span_id: span, payload: { auth_id, amount: quote.total, reason: "nothing_settled" } });
    }
  } catch (e) {
    card_error = e instanceof Error ? e.message : String(e);
    sink.emit({ type: "purchase.failed", source: "server", span_id: span, payload: { rule: "card_error", message: card_error, auth_id } });
  }

  const allOk = lines.every((l) => l.result.ok);
  return {
    ok: allOk && reconciled && !card_error,
    auth_id,
    wallet: wallet.address,
    funded,
    settled,
    spent,
    released,
    fee: quote.fee,
    captured,
    reconciled,
    ...(fund_tx ? { fund_tx } : {}),
    ...(sweep_tx ? { sweep_tx } : {}),
    ...(card_error ? { card_error } : {}),
    lines,
  };
}

async function safeRelease(input: SettleInput, auth_id: string, amount: Money, reason: string, span: string): Promise<void> {
  try {
    await input.card.release({ auth_id });
    input.sink.emit({ type: "card.released", source: "server", span_id: span, payload: { auth_id, amount, reason } });
  } catch (e) {
    input.sink.emit({ type: "purchase.failed", source: "server", span_id: span, payload: { rule: "card_error", message: e instanceof Error ? e.message : String(e), auth_id } });
  }
}

function lineInput(input: SettleInput, line: Quote["lines"][number], wallet: { address: string; seed: string }, payers: string[], span: string) {
  return {
    session_id: input.session_id,
    line,
    invoice_ref: `${input.quote.quote_id}:${line.line_id}:${input.manifest_hash}`,
    shop: input.shops[line.shop_id]!,
    shopsUrl: input.shopsUrl,
    wallet,
    payers,
    delivery: input.delivery,
    rlusd: input.rlusd,
    network: input.network,
    ledger: input.ledger,
    sink: input.sink,
    parent_span_id: span,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.paymentHeaderFactory ? { paymentHeaderFactory: input.paymentHeaderFactory } : {}),
    ...(input.wsUrl ? { wsUrl: input.wsUrl } : {}),
  };
}

function pick(line: Quote["lines"][number]) {
  return { line_id: line.line_id, product_id: line.product_id, shop_id: line.shop_id, price: line.price };
}
