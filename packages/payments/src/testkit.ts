import { add, sub, toCents, type Money, type SessionEvent } from "@buffet/shared";
import express from "express";
import type { Server } from "node:http";
import { base64EncodeUtf8, encodePaymentRequiredHeader, jsonCanonicalStringify } from "x402-xrpl";
import { Wallet } from "xrpl";
import type { EventSink, Ledger, PaymentCheck, RegisteredShop } from "./types.js";

/**
 * Test doubles used by this package's tests and later by the MCP server's tests.
 * Not exported from the package index; imported by path from test files.
 */

export const RLUSD = { currencyHex: "524C555344000000000000000000000000000000", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" };
/** Real keypairs (never funded, never used on a network): the client derives a Wallet from the seed. */
const treasuryWallet = Wallet.generate();
const poolWallet = Wallet.generate();
export const TREASURY = { seed: treasuryWallet.seed!, address: treasuryWallet.address };
export const POOL = { seed: poolWallet.seed!, address: poolWallet.address };
export const SHOP_A: RegisteredShop = { shop_id: "shop_a", name: "A", payTo: "rSHOPAxxxxxxxxxxxxxxxxxxxxxxxxxxx", asset: RLUSD.currencyHex, issuer: RLUSD.issuer, network: "xrpl:1" };
export const SHOP_B: RegisteredShop = { shop_id: "shop_b", name: "B", payTo: "rSHOPBxxxxxxxxxxxxxxxxxxxxxxxxxxx", asset: RLUSD.currencyHex, issuer: RLUSD.issuer, network: "xrpl:1" };

/** In-memory RLUSD ledger: balances by address, seeds mapped to addresses. */
export class FakeLedger implements Ledger {
  readonly balances = new Map<string, Money>();
  readonly seeds = new Map<string, string>();
  readonly payments: Array<{ hash: string; from: string; to: string; value: Money; memo?: string }> = [];
  failNextPayment: string | undefined;

  async verifyPayment(p: PaymentCheck): Promise<boolean> {
    const tx = this.payments.find((x) => x.hash === p.hash);
    if (!tx) return false;
    return p.from.includes(tx.from) && tx.to === p.to && toCents(tx.value) === toCents(p.value) && tx.memo === p.invoiceRef;
  }

  account(seed: string, address: string, balance: Money): void {
    this.seeds.set(seed, address);
    this.balances.set(address, balance);
  }
  async rlusdBalance(address: string): Promise<Money> {
    return this.balances.get(address) ?? "0.00";
  }
  async payRlusd(p: { fromSeed: string; to: string; value: Money; memo?: { type: string; data: string } }): Promise<string> {
    if (this.failNextPayment) {
      const why = this.failNextPayment;
      this.failNextPayment = undefined;
      throw new Error(why);
    }
    const from = this.seeds.get(p.fromSeed);
    if (!from) throw new Error("unknown seed");
    return this.move(from, p.to, p.value, p.memo?.data);
  }
  /** Used by the fake shop to simulate the facilitator settling the x402 payment. */
  move(from: string, to: string, value: Money, memo?: string): string {
    const bal = this.balances.get(from) ?? "0.00";
    if (toCents(bal) < toCents(value)) throw new Error(`payment_failed:tecPATH_PARTIAL (${from} has ${bal}, needs ${value})`);
    this.balances.set(from, sub(bal, value));
    this.balances.set(to, add(this.balances.get(to) ?? "0.00", value));
    const hash = `${(this.payments.length + 1).toString(16).padStart(4, "0")}${"F".repeat(60)}`;
    const entry = memo === undefined ? { hash, from, to, value } : { hash, from, to, value, memo };
    this.payments.push(entry);
    return hash;
  }
}

export class RecordingSink implements EventSink {
  readonly events: Array<Parameters<EventSink["emit"]>[0]> = [];
  emit(e: Parameters<EventSink["emit"]>[0]): void {
    this.events.push(e);
  }
  types(): string[] {
    return this.events.map((e) => e.type);
  }
  of(type: SessionEvent["type"]) {
    return this.events.filter((e) => e.type === type);
  }
}

export interface FakeShopOptions {
  ledger: FakeLedger;
  /** the address the payer's PAYMENT-SIGNATURE is treated as coming from */
  payerAddress: string;
  prices: Record<string, Money>;
  shops?: RegisteredShop[];
  /** tamper with the 402 for policy tests */
  override?: { amount?: Money; payTo?: string; issuer?: string; asset?: string };
  /** a dishonest shop: claims every ref is already settled with a made-up tx hash */
  lieOnRecovery?: boolean;
}

/**
 * A shop that speaks the x402 v2 wire format: 402 with PAYMENT-REQUIRED, then on a
 * request carrying any PAYMENT-SIGNATURE it "settles" by moving fake ledger money and
 * answers 200 with PAYMENT-RESPONSE. Never talks to a facilitator.
 */
export async function startFakeShop(opts: FakeShopOptions): Promise<{ url: string; close: () => void; orders: Map<string, { order_id: string; tx_hash: string; product_id: string }>; paidRequests: number }> {
  const app = express();
  app.use(express.json());
  const shops = opts.shops ?? [SHOP_A, SHOP_B];
  const orders = new Map<string, { order_id: string; tx_hash: string; product_id: string }>();
  const state = { paidRequests: 0 };

  app.get("/shops", (_req, res) => res.json({ shops }));
  app.get("/orders", (req, res) => {
    if (opts.lieOnRecovery) {
      return res.json({ order_id: "o_lie", tx_hash: "D".repeat(64), product_id: undefined, status: "settled", invoice_sent_to: "te**@example.com" });
    }
    const o = orders.get(String(req.query.invoice_ref));
    if (!o) return res.status(404).json({ error: "unknown_invoice_ref" });
    return res.json({ ...o, status: "settled", invoice_sent_to: "te**@example.com" });
  });
  app.post("/shops/:shop_id/orders/:product_id", (req, res) => {
    const { shop_id, product_id } = req.params;
    const shop = shops.find((s) => s.shop_id === shop_id);
    const price = opts.prices[product_id];
    if (!shop || !price) return res.status(404).json({ error: "unknown_product" });
    const ref = String(req.body?.invoice_ref ?? "");
    const existing = orders.get(ref);
    if (existing) return res.json({ ...existing, status: "settled", invoice_sent_to: "te**@example.com" });
    if (opts.lieOnRecovery) return res.json({ order_id: "o_lie", tx_hash: "D".repeat(64), status: "settled" });
    const sig = req.get("PAYMENT-SIGNATURE");
    if (!sig) {
      const accepts = [
        {
          scheme: "exact",
          network: "xrpl:1",
          asset: opts.override?.asset ?? RLUSD.currencyHex,
          payTo: opts.override?.payTo ?? shop.payTo,
          amount: opts.override?.amount ?? price,
          maxTimeoutSeconds: 600,
          extra: { issuer: opts.override?.issuer ?? RLUSD.issuer, invoiceId: ref, sourceTag: 804681468 },
        },
      ];
      const body = { x402Version: 2, error: "PAYMENT-SIGNATURE header is required", resource: { url: `http://fake/${shop_id}/${product_id}`, description: "", mimeType: "application/json" }, accepts, extensions: {} };
      res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(body));
      return res.status(402).json(body);
    }
    state.paidRequests += 1;
    const tx_hash = opts.ledger.move(opts.payerAddress, shop.payTo, price, ref);
    const order = { order_id: `o_${orders.size + 1}`, tx_hash, product_id };
    orders.set(ref, order);
    res.setHeader("PAYMENT-RESPONSE", base64EncodeUtf8(jsonCanonicalStringify({ success: true, transaction: tx_hash, network: "xrpl:1", payer: opts.payerAddress })));
    return res.json({ ...order, status: "settled", invoice_sent_to: "te**@example.com" });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => server.close(),
    orders,
    get paidRequests() {
      return state.paidRequests;
    },
  };
}

/** A payment header the fake shop accepts; no XRPL signing involved. */
export const fakeHeaderFactory = async (): Promise<string> => "ZmFrZS1zaWduYXR1cmU=";
