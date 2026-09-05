import { BrowseQuerySchema } from "@buffet/shared";
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { requireX402, type InvoiceStore } from "x402-xrpl/express";
import type { PaymentRequirements } from "x402-xrpl";
import type { Catalog } from "./catalog.js";
import { InvoiceMailer, type Invoice, type MailerOptions } from "./email.js";

/**
 * The mock merchant (CLAUDE.md §15.2, §15.3). Two shops, one process, one gateway.
 *
 *   GET  /shops                                  registry: shop ids, names, payTo addresses
 *   GET  /products?q&min_price&max_price         free browse; 400 without both bounds
 *   POST /shops/:shop_id/orders/:product_id      x402-gated (RLUSD, exact price); settles via
 *                                                 the facilitator, then creates the order and
 *                                                 emails the invoice. Idempotent on invoice_ref.
 *   GET  /orders/:order_id                       order status
 *   GET  /orders?invoice_ref=                    recover an order after a lost response
 *
 * x402-xrpl's middleware fixes the price per instance, so we build one instance per
 * product at startup. Our quote-line reference is fed in as the invoice id through
 * AsyncLocalStorage so it ends up in the on-ledger memo (§7 manifest memo).
 *
 * Money-safety order of operations on the settled retry: record the settlement
 * first, then the order, then the email. A mail failure never loses a paid order.
 */

export interface ShopsConfig {
  catalog: Catalog;
  /** shop_id -> XRPL classic address that receives RLUSD */
  payTo: Record<string, string>;
  rlusd: { currencyHex: string; issuer: string };
  network: "xrpl:0" | "xrpl:1" | "xrpl:2";
  facilitatorUrl: string;
  outboxDir: string;
  /** Default 804681468 (x402-xrpl's tag) so XRPL's agent analytics count us. */
  sourceTag?: number;
  /** Seconds a 402 quote (and its stock hold) stays valid. Default 600. */
  invoiceTtlSeconds?: number;
  /** Invoice email delivery. Absent (or no apiKey) → invoices are written to the outbox only. */
  email?: MailerOptions;
}

const INVOICE_REF_RE = /^[A-Za-z0-9:_-]{8,200}$/;

const OrderBodySchema = z.object({
  /** Our reference: `<quote_id>:<line_id>:<manifest_hash>`; becomes the x402 invoice id. Required for idempotency. */
  invoice_ref: z.string().regex(INVOICE_REF_RE),
  delivery: z.object({
    name: z.string().min(1).max(120),
    email: z.string().email().max(200),
    address: z.string().min(1).max(500),
  }),
});
type OrderBody = z.infer<typeof OrderBodySchema>;

export interface Order {
  order_id: string;
  shop_id: string;
  product_id: string;
  product_name: string;
  price: string;
  invoice_id: string;
  tx_hash: string;
  payer: string;
  status: "settled";
  invoice_sent_to: string;
  created_at: string;
}

export interface Settlement {
  invoice_id: string;
  shop_id: string;
  product_id: string;
  tx_hash: string;
  payer: string;
  settled_at: string;
}

const EXPLORER = "https://testnet.xrpl.org/transactions/";

/** Bounded invoice store: the SDK's default never sweeps, so an unauthenticated POST flood would grow it forever. */
class BoundedInvoiceStore implements InvoiceStore {
  private readonly map = new Map<string, { reqs: PaymentRequirements[]; expires: number }>();
  constructor(private readonly max = 10_000) {}
  put(invoiceId: string, reqs: PaymentRequirements[], params: { ttlSeconds: number }): void {
    this.map.delete(invoiceId);
    this.map.set(invoiceId, { reqs, expires: Date.now() + params.ttlSeconds * 1000 });
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
  get(invoiceId: string): PaymentRequirements[] | undefined {
    const e = this.map.get(invoiceId);
    if (!e) return undefined;
    if (e.expires < Date.now()) {
      this.map.delete(invoiceId);
      return undefined;
    }
    return e.reqs;
  }
  consume(invoiceId: string): void {
    this.map.delete(invoiceId);
  }
}

export interface ShopsApp {
  app: Express;
  orders: Map<string, Order>;
  settlements: Map<string, Settlement>;
  /** emits "order.settled" (Order) and "settlement.recorded" (Settlement) */
  events: EventEmitter;
}

export function createShopsApp(cfg: ShopsConfig): ShopsApp {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  const mailer = new InvoiceMailer(cfg.outboxDir, cfg.email);
  const events = new EventEmitter();
  const ttl = cfg.invoiceTtlSeconds ?? 600;
  const persistFile = path.join(cfg.outboxDir, "orders.json");

  // ---- state, with a small on-disk mirror so a restart mid-demo keeps settled orders
  const orders = new Map<string, Order>();
  const orderByRef = new Map<string, string>();
  const settlements = new Map<string, Settlement>();
  loadState();
  function persist(): void {
    try {
      fs.writeFileSync(persistFile, JSON.stringify({ orders: [...orders.values()], settlements: [...settlements.values()] }, null, 2));
    } catch (e) {
      console.error("[shops] persist failed:", e instanceof Error ? e.message : e);
    }
  }
  function loadState(): void {
    if (!fs.existsSync(persistFile)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(persistFile, "utf8")) as { orders?: Order[]; settlements?: Settlement[] };
      for (const o of saved.orders ?? []) {
        orders.set(o.order_id, o);
        orderByRef.set(o.invoice_id, o.order_id);
        cfg.catalog.reserve(o.product_id);
      }
      for (const s of saved.settlements ?? []) settlements.set(s.invoice_id, s);
    } catch (e) {
      console.error("[shops] could not load persisted orders:", e instanceof Error ? e.message : e);
    }
  }

  const invoiceHint = new AsyncLocalStorage<string>();

  app.get("/health", (_req, res) => {
    res.json({ ok: true, shops: cfg.catalog.shops.map((s) => s.shop_id) });
  });

  app.get("/shops", (_req, res) => {
    res.json({
      shops: cfg.catalog.shops.map((s) => ({
        shop_id: s.shop_id,
        name: s.name,
        shop_rating: s.shop_rating,
        payTo: cfg.payTo[s.shop_id],
        asset: cfg.rlusd.currencyHex,
        issuer: cfg.rlusd.issuer,
        network: cfg.network,
      })),
    });
  });

  // Browse: the price range is mandatory and enforced here, below the model (§15.1).
  app.get("/products", (req, res) => {
    const parsed = BrowseQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "price_range_required",
        message: "q, min_price and max_price are all required; prices are decimal strings like 899.00, min <= max",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return;
    }
    res.json(cfg.catalog.browse(parsed.data));
  });

  // One x402 middleware per product: the SDK fixes amount per instance.
  const gates = new Map<string, RequestHandler>();
  for (const p of cfg.catalog.all()) {
    const payTo = cfg.payTo[p.shop_id];
    if (!payTo) throw new Error(`no payTo address configured for ${p.shop_id}`);
    gates.set(
      `${p.shop_id}/${p.id}`,
      requireX402({
        payTo,
        amount: p.price,
        asset: cfg.rlusd.currencyHex,
        issuer: cfg.rlusd.issuer,
        network: cfg.network,
        facilitatorUrl: cfg.facilitatorUrl,
        resource: `order:${p.shop_id}:${p.id}`,
        description: `Order ${p.id} from ${p.shop_id}`,
        mimeType: "application/json",
        sourceTag: cfg.sourceTag ?? 804681468,
        invoiceStore: new BoundedInvoiceStore(),
        invoiceIdFactory: () => invoiceHint.getStore() ?? `inv_${randomBytes(12).toString("hex")}`,
        invoiceTtlSeconds: ttl,
        settle: true,
      }),
    );
  }

  // Pre-gate: validate, idempotency on invoice_ref, stock hold. Then the x402 gate.
  app.post("/shops/:shop_id/orders/:product_id", (req, res, next) => {
    const { shop_id, product_id } = req.params;
    const gate = gates.get(`${shop_id}/${product_id}`);
    if (!gate) {
      res.status(404).json({ error: "unknown_product" });
      return;
    }
    const body = OrderBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "invalid_order", issues: body.error.issues.map((i) => i.path.join(".")) });
      return;
    }
    const ref = body.data.invoice_ref;
    // Idempotent: a settled invoice_ref returns the same order, never a second 402.
    const existingId = orderByRef.get(ref);
    if (existingId) {
      res.json(orderResponse(orders.get(existingId)!));
      return;
    }
    // A settlement we recorded but whose order step failed: finish it now, no new payment.
    const settled = settlements.get(ref);
    if (settled) {
      res.locals.order = body.data;
      res.locals.x402 = { invoiceId: ref, settlement: { transaction: settled.tx_hash, payer: settled.payer }, payer: settled.payer };
      next();
      return;
    }
    // Hold a unit for this quote for the invoice TTL, so two buyers can't both get a 402 for the last one.
    if (!cfg.catalog.hold(product_id, ref, ttl * 1000)) {
      res.status(409).json({ error: "out_of_stock" });
      return;
    }
    res.locals.order = body.data;
    // Run the gate inside the ALS context so the invoice id factory sees our reference.
    invoiceHint.run(ref, () => gate(req, res, next));
  });

  // Reached only after the facilitator verified and settled the payment (or a recorded settlement).
  app.post("/shops/:shop_id/orders/:product_id", async (req, res) => {
    const { shop_id, product_id } = req.params;
    const x402 = res.locals.x402 as
      | { invoiceId: string; settlement: { transaction?: string; payer?: string }; payer?: string }
      | undefined;
    const body = res.locals.order as OrderBody;
    const tx_hash = x402?.settlement.transaction;
    if (!x402 || !tx_hash) {
      res.status(500).json({ error: "settlement_missing" });
      return;
    }
    const payer = x402.payer ?? x402.settlement.payer ?? "";
    // 1. Record the settlement before anything that can fail. Money has moved.
    if (!settlements.has(x402.invoiceId)) {
      const s: Settlement = { invoice_id: x402.invoiceId, shop_id, product_id, tx_hash, payer, settled_at: new Date().toISOString() };
      settlements.set(x402.invoiceId, s);
      persist();
      events.emit("settlement.recorded", s);
    }
    const product = cfg.catalog.get(product_id);
    const shop = cfg.catalog.shops.find((s) => s.shop_id === shop_id);
    if (!product || !shop) {
      res.status(500).json({ error: "catalog_mismatch", tx_hash });
      return;
    }
    // 2. Commit the stock hold (or reserve directly if the hold expired) and create the order.
    cfg.catalog.commitHold(x402.invoiceId) || cfg.catalog.reserve(product_id);
    const order_id = `o_${randomBytes(6).toString("hex")}`;
    const created_at = new Date().toISOString();
    const invoice: Invoice = {
      order_id,
      shop_name: shop.name,
      product_name: product.product_name,
      price: product.price,
      currency: "RLUSD",
      tx_hash,
      explorer: `${EXPLORER}${tx_hash}`,
      to: body.delivery,
      issued_at: created_at,
    };
    const order: Order = {
      order_id,
      shop_id,
      product_id,
      product_name: product.product_name,
      price: product.price,
      invoice_id: x402.invoiceId,
      tx_hash,
      payer,
      status: "settled",
      invoice_sent_to: "(pending)",
      created_at,
    };
    orders.set(order_id, order);
    orderByRef.set(x402.invoiceId, order_id);
    persist();
    // 3. Email last; a mail failure never fails a paid order.
    try {
      const sent = await mailer.send(invoice);
      order.invoice_sent_to = sent.to_masked;
      persist();
    } catch (e) {
      console.error(`[shops] invoice email failed for ${order_id}:`, e instanceof Error ? e.message : e);
      order.invoice_sent_to = "(failed)";
    }
    events.emit("order.settled", order);
    res.json(orderResponse(order));
  });

  app.get("/orders", (req, res) => {
    const ref = typeof req.query.invoice_ref === "string" ? req.query.invoice_ref : "";
    if (!INVOICE_REF_RE.test(ref)) {
      res.status(400).json({ error: "invoice_ref_required" });
      return;
    }
    const id = orderByRef.get(ref);
    if (id) {
      res.json(orderResponse(orders.get(id)!));
      return;
    }
    const s = settlements.get(ref);
    if (s) {
      res.status(202).json({ status: "settled_no_order", invoice_id: ref, tx_hash: s.tx_hash, hint: "re-POST the order with the same invoice_ref" });
      return;
    }
    res.status(404).json({ error: "unknown_invoice_ref" });
  });

  app.get("/orders/:order_id", (req, res) => {
    const o = orders.get(req.params.order_id);
    if (!o) {
      res.status(404).json({ error: "unknown_order" });
      return;
    }
    res.json(orderResponse(o));
  });

  // JSON errors only: never Express's HTML page with a stack trace.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { status?: number; type?: string; message?: string };
    const status = typeof e.status === "number" ? e.status : 500;
    if (status >= 500) console.error("[shops] error:", e.message ?? err);
    res.status(status).json({ error: e.type ?? (status >= 500 ? "internal" : "bad_request") });
  });

  return { app, orders, settlements, events };
}

function orderResponse(o: Order) {
  return {
    order_id: o.order_id,
    status: o.status,
    shop_id: o.shop_id,
    product_id: o.product_id,
    price: o.price,
    currency: "RLUSD",
    tx_hash: o.tx_hash,
    explorer: `${EXPLORER}${o.tx_hash}`,
    invoice_id: o.invoice_id,
    invoice_sent_to: o.invoice_sent_to,
  };
}
