import { decodePaymentRequiredHeader } from "x402-xrpl";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createShopsApp, type ShopsApp } from "./app.js";
import { Catalog } from "./catalog.js";

// These tests never reach the facilitator: the first request to a gated route
// returns 402 before any network call. Settlement is covered by scripts/x402-buy.ts.

const RLUSD_HEX = "524C555344000000000000000000000000000000";
const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const PAY_TO = { shop_a: "rrrrrrrrrrrrrrrrrrrrBZbvji", shop_b: "rrrrrrrrrrrrrrrrrrrrrhoLvTp" };
const DELIVERY = { name: "Test Buyer", email: "buyer@example.com", address: "1 Test St" };

let server: Server;
let base: string;
let shops: ShopsApp;
let outbox: string;

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

beforeAll(async () => {
  outbox = fs.mkdtempSync(path.join(os.tmpdir(), "aishop4u-outbox-"));
  shops = createShopsApp({
    catalog: Catalog.fromFile(),
    payTo: PAY_TO,
    rlusd: { currencyHex: RLUSD_HEX, issuer: ISSUER },
    network: "xrpl:1",
    facilitatorUrl: "http://127.0.0.1:9", // never contacted in these tests
    outboxDir: outbox,
  });
  await new Promise<void>((resolve) => {
    server = shops.app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server.close();
  fs.rmSync(outbox, { recursive: true, force: true });
});

describe("shops gateway", () => {
  it("lists shops with their payTo addresses and asset", async () => {
    const r = await fetch(`${base}/shops`).then((x) => x.json());
    expect(r.shops).toHaveLength(2);
    expect(r.shops[0]).toMatchObject({ shop_id: "shop_a", payTo: PAY_TO.shop_a, asset: RLUSD_HEX, issuer: ISSUER });
  });

  it("browse without a price range is a 400 (enforced below the model)", async () => {
    const r = await fetch(`${base}/products?q=laptop`);
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe("price_range_required");
  });

  it("browse with an inverted range is a 400", async () => {
    const r = await fetch(`${base}/products?q=laptop&min_price=1200&max_price=600`);
    expect(r.status).toBe(400);
  });

  it("browse with a range returns products", async () => {
    const r = await fetch(`${base}/products?q=laptop&min_price=600&max_price=1200`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.products.length).toBeGreaterThan(0);
  });

  it("order without payment returns a 402 whose terms equal the catalog price", async () => {
    const r = await post(`${base}/shops/shop_a/orders/p_a06`, { invoice_ref: "q_test:l_1:abcdef0123456789", delivery: DELIVERY });
    expect(r.status).toBe(402);
    const header = r.headers.get("PAYMENT-REQUIRED");
    expect(header).toBeTruthy();
    const req = decodePaymentRequiredHeader(header!);
    expect(req.accepts).toHaveLength(1);
    const a = req.accepts[0]!;
    expect(a.scheme).toBe("exact");
    expect(a.network).toBe("xrpl:1");
    expect(a.asset).toBe(RLUSD_HEX);
    expect(a.amount).toBe("16.90");
    expect(a.payTo).toBe(PAY_TO.shop_a);
    expect(a.extra?.issuer).toBe(ISSUER);
    // our reference became the invoice id, which the payer binds into the memo
    expect(a.extra?.invoiceId).toBe("q_test:l_1:abcdef0123456789");
    expect(a.extra?.sourceTag).toBe(804681468);
  });

  it("a 402 holds one unit of stock for that invoice_ref; a re-issued 402 does not double-hold", async () => {
    const before = shops.orders.size;
    const stock0 = (await fetch(`${base}/products?q=laptop&min_price=1700&max_price=1800`).then((x) => x.json())).products.find(
      (p: { id: string }) => p.id === "p_a02",
    ).stock;
    await post(`${base}/shops/shop_a/orders/p_a02`, { invoice_ref: "q_hold:l_1:0000000000000000", delivery: DELIVERY });
    await post(`${base}/shops/shop_a/orders/p_a02`, { invoice_ref: "q_hold:l_1:0000000000000000", delivery: DELIVERY });
    const stock1 = (await fetch(`${base}/products?q=laptop&min_price=1700&max_price=1800`).then((x) => x.json())).products.find(
      (p: { id: string }) => p.id === "p_a02",
    ).stock;
    expect(stock1).toBe(stock0 - 1);
    expect(shops.orders.size).toBe(before);
  });

  it("invoice_ref is required; unknown product is a 404; bad delivery is a 400", async () => {
    const r0 = await post(`${base}/shops/shop_a/orders/p_a06`, { delivery: DELIVERY });
    expect(r0.status).toBe(400);
    const r1 = await post(`${base}/shops/shop_a/orders/nope`, {});
    expect(r1.status).toBe(404);
    const r2 = await post(`${base}/shops/shop_a/orders/p_a06`, {
      invoice_ref: "q_x:l_1:abcdef0123456789",
      delivery: { name: "x", email: "not-an-email", address: "y" },
    });
    expect(r2.status).toBe(400);
  });

  it("a recorded settlement whose order step was lost is completed on re-POST without a new 402", async () => {
    const ref = "q_lost:l_1:abcdef0123456789";
    shops.settlements.set(ref, {
      invoice_id: ref,
      shop_id: "shop_a",
      product_id: "p_a07",
      tx_hash: "F".repeat(64),
      payer: "rPayer",
      settled_at: new Date().toISOString(),
    });
    const r = await post(`${base}/shops/shop_a/orders/p_a07`, { invoice_ref: ref, delivery: DELIVERY });
    expect(r.status).toBe(200);
    const order = await r.json();
    expect(order.status).toBe("settled");
    expect(order.tx_hash).toBe("F".repeat(64));
    expect(order.invoice_sent_to).toBe("bu***@example.com");
    // full delivery details are in the mock email only, never in the response
    expect(JSON.stringify(order)).not.toContain("1 Test St");

    // idempotent: same ref again returns the same order, no 402
    const r2 = await post(`${base}/shops/shop_a/orders/p_a07`, { invoice_ref: ref, delivery: DELIVERY });
    expect(r2.status).toBe(200);
    expect((await r2.json()).order_id).toBe(order.order_id);

    // recoverable by ref
    const r3 = await fetch(`${base}/orders?invoice_ref=${encodeURIComponent(ref)}`);
    expect((await r3.json()).order_id).toBe(order.order_id);

    // persisted for restarts
    const persisted = JSON.parse(fs.readFileSync(path.join(outbox, "orders.json"), "utf8"));
    expect(persisted.orders.some((o: { order_id: string }) => o.order_id === order.order_id)).toBe(true);
  });

  it("malformed JSON gets a JSON error, not an HTML stack trace", async () => {
    const r = await fetch(`${base}/shops/shop_a/orders/p_a06`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(r.status).toBe(400);
    expect(r.headers.get("content-type")).toMatch(/json/);
    const body = await r.json();
    expect(body.error).toBeDefined();
  });

  it("a seller string with hype text comes back verbatim as JSON text, never interpreted", async () => {
    const r = await fetch(`${base}/products?q=laptop&min_price=300&max_price=400`).then((x) => x.json());
    const planted = r.products.find((p: { id: string }) => p.id === "p_b03");
    expect(planted.description).toContain("BRAND NEW SEALED!!!");
    expect(typeof planted.description).toBe("string");
  });
});
