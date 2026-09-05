import { chainHash, type Quote } from "@aishop4u/shared";
import { afterEach, describe, expect, it } from "vitest";
import { MockCardAuthoriser } from "./card.js";
import { WalletPool } from "./pool.js";
import { settlePurchase } from "./purchase.js";
import { PolicyError } from "./types.js";
import { FakeLedger, POOL, RecordingSink, RLUSD, SHOP_A, SHOP_B, TREASURY, fakeHeaderFactory, startFakeShop } from "./testkit.js";

const POOL_SEED = POOL.seed;
const POOL_ADDR = POOL.address;
const DELIVERY = { name: "Test Buyer", email: "buyer@example.com", address: "1 Test St" };
const MANIFEST = "ab".repeat(32);

function quote(lines: Array<{ line_id: string; product_id: string; shop_id: string; price: string }>, itemsTotal?: string): Quote {
  const items_total = itemsTotal ?? lines.reduce((acc, l) => (Number(acc) + Number(l.price)).toFixed(2), "0.00");
  const fee = "0.25";
  const total = (Number(items_total) + Number(fee)).toFixed(2);
  const base = { session_id: "s_test", quote_id: "q_1", lines: lines.map((l) => ({ ...l, product_name: l.product_id })), items_total, fee, total, expires_at: new Date(Date.now() + 60_000).toISOString() };
  return { ...base, quote_hash: chainHash(base) };
}

let closers: Array<() => void> = [];
afterEach(() => {
  for (const c of closers) c();
  closers = [];
});

type ShopOpts = Parameters<typeof startFakeShop>[0];
async function harness(opts: { prices: Record<string, string>; override?: ShopOpts["override"]; lieOnRecovery?: boolean; treasury?: string }) {
  const ledger = new FakeLedger();
  ledger.account(TREASURY.seed, TREASURY.address, opts.treasury ?? "5000.00");
  ledger.account(POOL_SEED, POOL_ADDR, "0.00");
  const shop = await startFakeShop({
    ledger,
    payerAddress: POOL_ADDR,
    prices: opts.prices,
    ...(opts.override ? { override: opts.override } : {}),
    ...(opts.lieOnRecovery ? { lieOnRecovery: true } : {}),
  });
  closers.push(shop.close);
  const pool = new WalletPool([{ seed: POOL_SEED, address: POOL_ADDR, state: "idle" }]);
  const sink = new RecordingSink();
  const card = new MockCardAuthoriser();
  const run = (q: Quote) =>
    settlePurchase({
      session_id: "s_test",
      quote: q,
      manifest_hash: MANIFEST,
      delivery: DELIVERY,
      shops: { shop_a: SHOP_A, shop_b: SHOP_B },
      shopsUrl: shop.url,
      treasury: TREASURY,
      pool,
      ledger,
      card,
      rlusd: RLUSD,
      network: "xrpl:1",
      sink,
      paymentHeaderFactory: fakeHeaderFactory,
    });
  return { ledger, shop, pool, sink, card, run };
}

const L1 = { line_id: "l_1", product_id: "p_1", shop_id: "shop_a", price: "899.00" };
const L2 = { line_id: "l_2", product_id: "p_2", shop_id: "shop_b", price: "16.90" };

describe("settlePurchase", () => {
  it("happy path: acquire, authorise, fund exactly the item total, pay, nothing to sweep, capture items + fee", async () => {
    const h = await harness({ prices: { p_1: "899.00" } });
    const r = await h.run(quote([L1]));

    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ funded: "899.00", settled: "899.00", spent: "899.00", released: "0.00", captured: "899.25", reconciled: true });
    expect(h.shop.paidRequests).toBe(1);
    expect(await h.ledger.rlusdBalance(TREASURY.address)).toBe("4101.00");
    expect(await h.ledger.rlusdBalance(POOL_ADDR)).toBe("0.00");
    expect(await h.ledger.rlusdBalance(SHOP_A.payTo)).toBe("899.00");
    expect(h.pool.counts()).toMatchObject({ idle: 1 });
    expect(h.ledger.payments[0]!.memo).toContain("s_test");
    expect(h.ledger.payments[1]!.memo).toBe(`q_1:l_1:${MANIFEST}`);
    expect(h.sink.types()).toEqual([
      "card.authorised",
      "session.funded",
      "payment.quoted",
      "payment.submitted",
      "purchase.settled",
      "session.swept",
      "manifest.anchored",
      "card.captured",
    ]);
    expect(h.sink.of("manifest.anchored")[0]!.payload).toMatchObject({ manifest_hash: MANIFEST, via: "invoice_memo" });
    const dump = JSON.stringify(h.sink.events);
    expect(dump).not.toContain("buyer@example.com");
    expect(dump).not.toContain("1 Test St");
    expect(dump).not.toContain(POOL_SEED);
    expect(dump).not.toContain(TREASURY.seed);
  });

  it("budget refusal (§5 step 9): a line the wallet cannot cover is refused, nothing is signed for it", async () => {
    const h = await harness({ prices: { p_1: "899.00", p_2: "16.90" } });
    // Tampered quote: two lines, items_total covers only the first. The wallet is funded
    // to items_total, so the second line physically cannot be paid.
    const r = await h.run(quote([L1, L2], "899.00"));
    expect(r.ok).toBe(false);
    expect(r.lines[0]!.result.ok).toBe(true);
    expect(r.lines[1]!.result).toMatchObject({ ok: false, kind: "refused", rule: "insufficient_funded" });
    expect(h.shop.paidRequests).toBe(1);
    expect(h.sink.of("payment.refused")[0]!.payload).toMatchObject({ rule: "insufficient_funded", spendable: "0.00", needed: "16.90" });
    // authorisation was for the quote total, which never included the tampered line
    expect(r.captured).toBe("899.25");
    expect(h.sink.of("card.captured")[0]!.payload).toMatchObject({ amount: "899.25", items: "899.00", fee: "0.25" });
    expect(h.sink.of("card.released")).toHaveLength(0);
  });

  it("policy refusal: a 402 demanding a different payTo is refused before signing, funds sweep back, card released", async () => {
    const h = await harness({ prices: { p_1: "899.00" }, override: { payTo: "rATTACKERxxxxxxxxxxxxxxxxxxxxxxx" } });
    const r = await h.run(quote([L1]));
    expect(r.ok).toBe(false);
    expect(r.lines[0]!.result).toMatchObject({ ok: false, kind: "refused", rule: "payto_not_registered" });
    expect(h.shop.paidRequests).toBe(0);
    expect(r).toMatchObject({ released: "899.00", spent: "0.00", captured: "0.00", reconciled: true });
    expect(await h.ledger.rlusdBalance(TREASURY.address)).toBe("5000.00");
    expect(h.ledger.payments.at(-1)!.memo).toContain(MANIFEST);
    expect(h.sink.of("manifest.anchored")[0]!.payload).toMatchObject({ via: "sweep_memo", tx_hash: expect.any(String) });
    expect(h.sink.of("card.captured")).toHaveLength(0);
    expect(h.sink.of("card.released")[0]!.payload).toMatchObject({ amount: "899.25", reason: "nothing_settled" });
    expect(h.pool.counts()).toMatchObject({ idle: 1 });
  });

  it("policy refusal: quoted != demanded, and the quoted event shows the option the policy examined", async () => {
    const h = await harness({ prices: { p_1: "899.00" }, override: { amount: "4000.00" } });
    const r = await h.run(quote([L1]));
    expect(r.lines[0]!.result).toMatchObject({ ok: false, rule: "quoted_ne_demanded" });
    expect(h.shop.paidRequests).toBe(0);
    expect(h.sink.of("payment.quoted")[0]!.payload).toMatchObject({ quoted: "899.00", demanded: "4000.00", options_offered: 1 });
  });

  it("pool exhausted: refuses before touching the card or the ledger", async () => {
    const h = await harness({ prices: { p_1: "899.00" } });
    h.pool.acquire("someone_else");
    await expect(h.run(quote([L1]))).rejects.toThrow(PolicyError);
    expect(h.card.auths.size).toBe(0);
    expect(h.ledger.payments).toHaveLength(0);
    expect(h.sink.of("payment.refused")[0]!.payload).toMatchObject({ rule: "pool_exhausted" });
  });

  it("funding failure with nothing landed: wallet goes to attention, card released, error surfaces", async () => {
    const h = await harness({ prices: { p_1: "899.00" } });
    h.ledger.failNextPayment = "payment_failed:tecUNFUNDED";
    await expect(h.run(quote([L1]))).rejects.toThrow(/tecUNFUNDED/);
    expect(h.pool.counts()).toMatchObject({ attention: 1, idle: 0 });
    expect(h.sink.of("card.released")[0]!.payload).toMatchObject({ reason: "funding_failed" });
  });

  it("funding 'failure' that actually validated: balance confirms, run continues", async () => {
    const h = await harness({ prices: { p_1: "899.00" } });
    // Simulate a submit timeout whose tx validated: fail the call but move the money.
    const real = h.ledger.payRlusd.bind(h.ledger);
    let first = true;
    h.ledger.payRlusd = async (p) => {
      if (first) {
        first = false;
        await real(p);
        throw new Error("timeout: LastLedgerSequence passed");
      }
      return real(p);
    };
    const r = await h.run(quote([L1]));
    expect(r.ok).toBe(true);
    expect(h.sink.of("session.funded")[0]!.payload).toMatchObject({ note: expect.stringContaining("confirmed by balance") });
    expect(h.pool.counts()).toMatchObject({ idle: 1 });
  });

  it("idempotent retry: settled lines are recovered on-ledger, not funded, not paid again", async () => {
    const h = await harness({ prices: { p_1: "899.00" } });
    const q = quote([L1]);
    const first = await h.run(q);
    expect(first.ok).toBe(true);
    const paid = h.shop.paidRequests;
    const treasuryAfterFirst = await h.ledger.rlusdBalance(TREASURY.address);
    const second = await h.run(q);
    expect(second.ok).toBe(true);
    expect(h.shop.paidRequests).toBe(paid);
    expect(second).toMatchObject({ funded: "0.00", settled: "899.00", spent: "0.00", released: "0.00", captured: "899.25" });
    expect(await h.ledger.rlusdBalance(TREASURY.address)).toBe(treasuryAfterFirst);
    expect(h.sink.of("purchase.settled").at(-1)!.payload).toMatchObject({ recovered: true });
    expect(h.sink.of("session.funded")).toHaveLength(1);
  });

  it("a shop that lies about settlement is not believed: ledger check fails, nothing captured", async () => {
    const h = await harness({ prices: { p_1: "899.00" }, lieOnRecovery: true });
    const r = await h.run(quote([L1]));
    expect(r.ok).toBe(false);
    expect(r.lines[0]!.result).toMatchObject({ ok: false, rule: "unverified_settlement_claim" });
    expect(h.shop.paidRequests).toBe(0);
    expect(r).toMatchObject({ spent: "0.00", captured: "0.00", released: "899.00" });
    expect(h.sink.of("card.captured")).toHaveLength(0);
    expect(await h.ledger.rlusdBalance(TREASURY.address)).toBe("5000.00");
  });

  it("two lines from two shops settle sequentially from one wallet", async () => {
    const h = await harness({ prices: { p_1: "899.00", p_2: "16.90" } });
    const r = await h.run(quote([L1, L2]));
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ settled: "915.90", spent: "915.90", captured: "916.15", reconciled: true });
    expect(await h.ledger.rlusdBalance(SHOP_B.payTo)).toBe("16.90");
    expect(h.sink.of("purchase.settled")).toHaveLength(2);
  });

  it("card capture error after settlement never loses the result", async () => {
    const h = await harness({ prices: { p_1: "899.00" } });
    h.card.capture = async () => {
      throw new Error("stripe_down");
    };
    const r = await h.run(quote([L1]));
    expect(r.ok).toBe(false);
    expect(r.card_error).toBe("stripe_down");
    expect(r.lines[0]!.result.ok).toBe(true);
    expect(r.spent).toBe("899.00");
    expect(h.sink.of("purchase.failed")[0]!.payload).toMatchObject({ rule: "card_error" });
  });
});
