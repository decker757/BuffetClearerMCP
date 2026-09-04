import { MockCardAuthoriser, WalletPool } from "@buffet/payments";
import { FakeLedger, POOL, RLUSD, SHOP_A, SHOP_B, TREASURY, fakeHeaderFactory, startFakeShop } from "@buffet/payments/testkit";
import { Catalog } from "@buffet/shops";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Deps } from "./deps.js";
import { EventLog } from "./eventlog.js";
import { createServer } from "./server.js";
import { SessionManager } from "./session.js";

/**
 * The scripted driver (CLAUDE.md §5 phase 4): a real MCP client plays Claude and
 * the widget, against a fake shop that speaks x402 and a fake ledger. No network.
 */

const catalog = Catalog.fromFile();
const BILLING = { name: "Test Buyer", email: "buyer@example.com", address: "1 Test St" };

let closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of closers) await c();
  closers = [];
});

async function harness(opts: { override?: Parameters<typeof startFakeShop>[0]["override"] } = {}) {
  const ledger = new FakeLedger();
  ledger.account(TREASURY.seed, TREASURY.address, "5000.00");
  ledger.account(POOL.seed, POOL.address, "0.00");
  const prices = Object.fromEntries(catalog.all().map((p) => [p.id, p.price]));
  const shop = await startFakeShop({ ledger, payerAddress: POOL.address, prices, browse: (q) => catalog.browse(q), ...(opts.override ? { override: opts.override } : {}) });
  closers.push(shop.close);
  const widgetHtml = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "buffet-w-")), "index.html");
  fs.writeFileSync(widgetHtml, "<html>widget</html>");
  const manager = new SessionManager(new EventLog(), "0.25");
  const deps: Deps = {
    manager,
    shopsUrl: shop.url,
    fetchImpl: fetch,
    ledger,
    pool: new WalletPool([{ seed: POOL.seed, address: POOL.address, state: "idle" }]),
    card: new MockCardAuthoriser(),
    treasury: TREASURY,
    rlusd: RLUSD,
    network: "xrpl:1",
    loadRegistry: async () => ({ shop_a: SHOP_A, shop_b: SHOP_B }),
    widgetHtml,
    paymentHeaderFactory: fakeHeaderFactory,
  };
  const server = createServer(deps);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "driver", version: "0" });
  await client.connect(ct);
  closers.push(() => client.close());
  // Populate the client's tool cache so every callTool validates structuredContent against the
  // declared outputSchema (the SDK only validates when it has seen the schema via tools/list).
  await client.listTools();
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: r.isError === true, text: (r.content as Array<{ text?: string }>)[0]?.text ?? "", data: (r.structuredContent ?? {}) as Record<string, unknown> };
  };
  return { client, call, manager, shop, ledger, deps };
}

describe("tool surface", () => {
  it("lists model tools with the widget resource, and marks widget tools app-only", async () => {
    const h = await harness();
    const { tools } = await h.client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const n of ["start_session", "browse", "propose", "checkout", "purchase"]) {
      const meta = byName[n]!._meta as { ui?: { resourceUri?: string; visibility?: string[] } };
      expect(meta.ui?.resourceUri).toBe("ui://buffet/monitor.html");
      expect(meta.ui?.visibility).toBeUndefined();
    }
    for (const n of ["session_snapshot", "session_events", "select_candidate", "submit_billing", "approve_quote", "abort_session"]) {
      const meta = byName[n]!._meta as { ui?: { visibility?: string[] } };
      expect(meta.ui?.visibility).toEqual(["app"]);
    }
  });

  it("runs the whole loop: start, browse, propose with a flag, select, billing, checkout, approve, purchase", async () => {
    const h = await harness();
    const start = await h.call("start_session", { objective: "a laptop for uni", reason: "user asked" });
    const sid = start.data.session_id as string;
    expect(sid).toMatch(/^s_/);

    // budget enforced below the model
    const noRange = await h.call("browse", { session_id: sid, query: "laptop", min_price: "1200", max_price: "600", reason: "try" });
    expect(noRange.isError).toBe(true);
    expect(noRange.text).toMatch(/refused|min_price/i);

    const browse = await h.call("browse", { session_id: sid, query: "laptop", min_price: "300", max_price: "1300", reason: "user gave range" });
    expect(browse.isError).toBe(false);
    const products = browse.data.products as Array<{ id: string; price: string; seller_description_untrusted: string }>;
    expect(products.length).toBeGreaterThan(5);
    expect(products.some((p) => p.id === "p_b03")).toBe(true);
    expect(Object.keys(products[0]!)).not.toContain("description");
    // Hosts may show the model only the text part: the product table must be there, and the session id too.
    expect(browse.text).toMatch(/^p_b03 \| .* \| shop_b \| 349\.00 \| /m);
    expect(browse.data.session_id).toBe(sid);

    const rec = products.filter((p) => p.id !== "p_b03").slice(0, 5).map((p) => p.id);
    const propose = await h.call("propose", {
      session_id: sid,
      recommended: rec,
      rejected: [{ product_id: "p_b03", reason: "61% below the others for the same model; 4.9 on 3 sales", evidence: { price: "349.00", median_price: "899.00", quantity_sold: 3 } }],
      reason: "rank by sales and rating, flag the clearance listing",
    });
    expect(propose.isError).toBe(false);
    expect(propose.data).toMatchObject({ session_id: sid, recommended: 5, rejected: 1 });
    expect(propose.text).toMatch(/FLAGGED p_b03 .*61% below/);

    // checkout too early
    const early = await h.call("checkout", { session_id: sid, reason: "try" });
    expect(early.isError).toBe(true);

    // widget actions
    const chosen = rec[0]!;
    expect((await h.call("select_candidate", { session_id: sid, product_id: chosen })).isError).toBe(false);
    expect((await h.call("submit_billing", { session_id: sid, ...BILLING })).isError).toBe(false);
    const snap = await h.call("session_snapshot", { session_id: sid });
    expect(snap.data).toMatchObject({ phase: "shopping", step: "billing", billing_present: true });
    expect(JSON.stringify(snap.data)).not.toContain("buyer@example.com");

    const checkout = await h.call("checkout", { session_id: sid, reason: "selection and billing are in" });
    expect(checkout.isError).toBe(false);
    const quote_id = checkout.data.quote_id as string;
    const price = catalog.get(chosen)!.price;
    expect(checkout.data).toMatchObject({ items_total: price, fee: "0.25" });

    // purchase before approval is refused, and the refusal is an event
    const tooSoon = await h.call("purchase", { session_id: sid, quote_id, reason: "try" });
    expect(tooSoon.isError).toBe(true);
    expect(tooSoon.text).toMatch(/not_approved/);
    expect(h.manager.log.all(sid).some((e) => e.type === "approval.refused")).toBe(true);

    expect((await h.call("approve_quote", { session_id: sid, quote_id })).isError).toBe(false);
    const purchase = await h.call("purchase", { session_id: sid, quote_id, reason: "user approved in the widget" });
    expect(purchase.isError).toBe(false);
    expect(purchase.data).toMatchObject({ session_id: sid, ok: true, spent: price, fee: "0.25" });
    expect(purchase.text).toMatch(/settled, order o_\d+, tx https:\/\/testnet\.xrpl\.org\/transactions\//);
    const lines = purchase.data.lines as Array<{ status: string; tx_hash: string }>;
    expect(lines[0]).toMatchObject({ status: "settled" });
    expect(h.shop.paidRequests).toBe(1);

    // second purchase with the same approval is refused: single use
    const again = await h.call("purchase", { session_id: sid, quote_id, reason: "again" });
    expect(again.isError).toBe(true);
    expect(h.shop.paidRequests).toBe(1);

    // the chain verifies from what the widget/dashboard would fetch
    const events = await h.call("session_events", { session_id: sid, after_seq: 0 });
    const list = events.data.events as Array<{ type: string; source: string }>;
    expect(EventLog.verify(JSON.parse(JSON.stringify(list))).ok).toBe(true);
    const types = list.map((e) => e.type);
    for (const t of ["session.started", "agent.intent", "browse.refused", "browse.returned", "candidate.rejected", "candidate.selected", "billing.submitted", "quote.ready", "approval.refused", "approval.granted", "card.authorised", "session.funded", "payment.quoted", "purchase.settled", "manifest.anchored", "card.captured"]) {
      expect(types).toContain(t);
    }
    expect(list.find((e) => e.type === "candidate.rejected")!.source).toBe("agent");
    const dump = JSON.stringify(list);
    expect(dump).not.toContain("buyer@example.com");
    expect(dump).not.toContain("1 Test St");
    expect(dump).not.toContain(POOL.seed);

    const final = await h.call("session_snapshot", { session_id: sid });
    expect(final.data).toMatchObject({ phase: "done", ledger: { settled: price, in_flight: "0.00" } });
  });

  it("refuses a 402 that does not match the approved quote, with nothing signed and the card released", async () => {
    const h = await harness({ override: { amount: "4000.00" } });
    const sid = (await h.call("start_session", { objective: "cable", reason: "r" })).data.session_id as string;
    await h.call("browse", { session_id: sid, query: "usb-c cable", min_price: "5", max_price: "30", reason: "r" });
    await h.call("propose", { session_id: sid, recommended: ["p_a06"], reason: "r" });
    await h.call("select_candidate", { session_id: sid, product_id: "p_a06" });
    await h.call("submit_billing", { session_id: sid, ...BILLING });
    const quote_id = (await h.call("checkout", { session_id: sid, reason: "r" })).data.quote_id as string;
    await h.call("approve_quote", { session_id: sid, quote_id });
    const purchase = await h.call("purchase", { session_id: sid, quote_id, reason: "r" });
    expect(purchase.isError).toBe(false);
    expect(purchase.data).toMatchObject({ ok: false, spent: "0.00", captured: "0.00", released: "16.90" });
    expect(h.shop.paidRequests).toBe(0);
    const types = h.manager.log.all(sid).map((e) => e.type);
    expect(types).toContain("payment.refused");
    expect(types).toContain("card.released");
    expect(h.manager.log.all(sid).find((e) => e.type === "payment.refused")!.payload).toMatchObject({ rule: "quoted_ne_demanded" });
  });

  it("propose only accepts ids from the last browse; select only accepts current candidates", async () => {
    const h = await harness();
    const sid = (await h.call("start_session", { objective: "cable", reason: "r" })).data.session_id as string;
    const before = await h.call("propose", { session_id: sid, recommended: ["p_a06"], reason: "r" });
    expect(before.isError).toBe(true);
    await h.call("browse", { session_id: sid, query: "usb-c cable", min_price: "5", max_price: "30", reason: "r" });
    const bad = await h.call("propose", { session_id: sid, recommended: ["p_b05"], reason: "r" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/not in the last browse/);
    await h.call("propose", { session_id: sid, recommended: ["p_a06"], reason: "r" });
    const sel = await h.call("select_candidate", { session_id: sid, product_id: "p_b07" });
    expect(sel.isError).toBe(true);
  });

  it("abort from the widget ends the session and clears billing", async () => {
    const h = await harness();
    const sid = (await h.call("start_session", { objective: "cable", reason: "r" })).data.session_id as string;
    await h.call("submit_billing", { session_id: sid, ...BILLING });
    expect((await h.call("abort_session", { session_id: sid })).isError).toBe(false);
    const snap = await h.call("session_snapshot", { session_id: sid });
    expect(snap.data).toMatchObject({ phase: "aborted", billing_present: false });
    const b = await h.call("browse", { session_id: sid, query: "x", min_price: "1", max_price: "2", reason: "r" });
    expect(b.isError).toBe(true);
  });

  it("an unexpected failure after funding holds the session in settling: no second authorisation, no re-fund", async () => {
    const h = await harness();
    const sid = (await h.call("start_session", { objective: "cable", reason: "r" })).data.session_id as string;
    await h.call("browse", { session_id: sid, query: "usb-c cable", min_price: "5", max_price: "30", reason: "r" });
    await h.call("propose", { session_id: sid, recommended: ["p_a06"], reason: "r" });
    await h.call("select_candidate", { session_id: sid, product_id: "p_a06" });
    await h.call("submit_billing", { session_id: sid, ...BILLING });
    const quote_id = (await h.call("checkout", { session_id: sid, reason: "r" })).data.quote_id as string;
    await h.call("approve_quote", { session_id: sid, quote_id });
    // Funding succeeds, then the ledger blows up on the next read.
    const realBalance = h.ledger.rlusdBalance.bind(h.ledger);
    let calls = 0;
    h.ledger.rlusdBalance = async (a) => {
      calls += 1;
      if (calls === 1) throw new Error("ledger websocket dropped");
      return realBalance(a);
    };
    const r = await h.call("purchase", { session_id: sid, quote_id, reason: "r" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/operator/);
    const snap = await h.call("session_snapshot", { session_id: sid });
    expect(snap.data.phase).toBe("settling");
    expect((await h.call("approve_quote", { session_id: sid, quote_id })).isError).toBe(true);
    expect((await h.call("purchase", { session_id: sid, quote_id, reason: "again" })).isError).toBe(true);
    expect(h.deps.card instanceof Object && (h.deps.card as { auths: Map<string, unknown> }).auths.size).toBe(1);
    expect(h.ledger.payments).toHaveLength(1); // funded once, never again
    expect(h.deps.pool.counts()).toMatchObject({ attention: 1 });
  });

  it("a refusal before money moves (pool exhausted) returns the session to checkout for a fresh approval", async () => {
    const h = await harness();
    const sid = (await h.call("start_session", { objective: "cable", reason: "r" })).data.session_id as string;
    await h.call("browse", { session_id: sid, query: "usb-c cable", min_price: "5", max_price: "30", reason: "r" });
    await h.call("propose", { session_id: sid, recommended: ["p_a06"], reason: "r" });
    await h.call("select_candidate", { session_id: sid, product_id: "p_a06" });
    await h.call("submit_billing", { session_id: sid, ...BILLING });
    const quote_id = (await h.call("checkout", { session_id: sid, reason: "r" })).data.quote_id as string;
    await h.call("approve_quote", { session_id: sid, quote_id });
    h.deps.pool.acquire("someone_else");
    const r = await h.call("purchase", { session_id: sid, quote_id, reason: "r" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/pool_exhausted|no idle/);
    expect((await h.call("session_snapshot", { session_id: sid })).data.phase).toBe("checkout");
    h.deps.pool.transition(POOL.address, "idle");
    expect((await h.call("approve_quote", { session_id: sid, quote_id })).isError).toBe(false);
    const ok = await h.call("purchase", { session_id: sid, quote_id, reason: "r" });
    expect(ok.data.ok).toBe(true);
  });
});
