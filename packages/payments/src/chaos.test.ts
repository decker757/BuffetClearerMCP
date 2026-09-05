import { chainHash, type Money, type Quote } from "@aishop4u/shared";
import { afterEach, describe, expect, it } from "vitest";
import { MockCardAuthoriser, type CardAuthoriser } from "./card.js";
import { WalletPool } from "./pool.js";
import { settlePurchase } from "./purchase.js";
import { PolicyError } from "./types.js";
import { FakeLedger, POOL, RLUSD, RecordingSink, SHOP_A, SHOP_B, TREASURY, fakeHeaderFactory, startFakeShop, type Misbehaviour } from "./testkit.js";

/**
 * The failure-mode matrix (docs/FAILURE-MODES.md), one test per row that had no
 * guard. `purchase.test.ts` already covers the clean paths and the three we knew
 * about (lying shop, funding timeout that validated, pool exhausted); this file
 * covers what happens when a shop, the card or the ledger misbehaves *after*
 * money is in the session wallet.
 *
 * The question every test asks is the same one: where did the RLUSD end up, what
 * happened to the card hold, and does the event log say so.
 */

const DELIVERY = { name: "Test Buyer", email: "buyer@example.com", address: "1 Test St" };
const MANIFEST = "ab".repeat(32);
const L1 = { line_id: "l_1", product_id: "p_1", shop_id: "shop_a", price: "899.00" };

function quote(lines: Array<{ line_id: string; product_id: string; shop_id: string; price: string }>): Quote {
  const items_total = lines.reduce((acc, l) => (Number(acc) + Number(l.price)).toFixed(2), "0.00");
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

async function harness(opts: { misbehave?: Misbehaviour; treasury?: Money; card?: CardAuthoriser; shopsUrl?: string } = {}) {
  const ledger = new FakeLedger();
  ledger.account(TREASURY.seed, TREASURY.address, opts.treasury ?? "5000.00");
  ledger.account(POOL.seed, POOL.address, "0.00");
  const shop = await startFakeShop({
    ledger,
    payerAddress: POOL.address,
    prices: { p_1: "899.00" },
    ...(opts.misbehave ? { misbehave: opts.misbehave } : {}),
  });
  closers.push(shop.close);
  const pool = new WalletPool([{ seed: POOL.seed, address: POOL.address, state: "idle" }]);
  const sink = new RecordingSink();
  const card = opts.card ?? new MockCardAuthoriser();
  const run = (q: Quote, fetchImpl?: typeof fetch) =>
    settlePurchase({
      session_id: "s_test",
      quote: q,
      manifest_hash: MANIFEST,
      delivery: DELIVERY,
      shops: { shop_a: SHOP_A, shop_b: SHOP_B },
      shopsUrl: opts.shopsUrl ?? shop.url,
      treasury: TREASURY,
      pool,
      ledger,
      card,
      rlusd: RLUSD,
      network: "xrpl:1",
      sink,
      paymentHeaderFactory: fakeHeaderFactory,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  return { ledger, shop, pool, sink, card, run };
}

/** Rule of the payload: what the failure event says the loss was. */
const failure = (sink: RecordingSink) => sink.of("purchase.failed").map((e) => (e.payload as { rule: string }).rule);

describe("failure modes: the treasury and the card, before anything moves", () => {
  it("treasury underfunded: refused before the wallet is taken or the card is touched", async () => {
    const h = await harness({ treasury: "10.00" });
    await expect(h.run(quote([L1]))).rejects.toThrow(PolicyError);
    expect(h.sink.of("payment.refused")[0]!.payload).toMatchObject({ rule: "treasury_underfunded", treasury: "10.00", needed: "899.00" });
    expect(h.sink.types()).not.toContain("card.authorised");
    expect(h.pool.counts()).toMatchObject({ idle: 1 });
    expect(h.ledger.payments).toHaveLength(0);
  });

  it("card declined: refused as a policy failure, so the user can approve again instead of waiting for an operator", async () => {
    const declining: CardAuthoriser = {
      mocked: true,
      authorise: async () => {
        // What StripeCardAuthoriser throws on a 4000000000000002 test card.
        throw new Error("card_declined: insufficient funds");
      },
      capture: async () => {
        throw new Error("never reached");
      },
      release: async () => {},
    };
    const h = await harness({ card: declining });
    // A PolicyError is what tells the MCP layer "nothing moved, send them back to
    // checkout" (server.ts). A plain Error would park the session in `settling`.
    await expect(h.run(quote([L1]))).rejects.toThrow(PolicyError);
    expect(h.sink.of("payment.refused")[0]!.payload).toMatchObject({ rule: "card_declined" });
    expect(h.ledger.payments).toHaveLength(0);
    expect(h.pool.counts()).toMatchObject({ idle: 1 });
    expect(h.sink.types()).not.toContain("session.funded");
  });
});

describe("failure modes: the shop never takes the money", () => {
  it("shop 500: nothing signed, the funded RLUSD sweeps back, the whole hold is released", async () => {
    const h = await harness({ misbehave: { status: 500 } });
    const r = await h.run(quote([L1]));

    expect(r.ok).toBe(false);
    expect(failure(h.sink)).toContain("shop_error");
    expect(h.shop.paidRequests).toBe(0);
    expect(r.spent).toBe("0.00");
    expect(r.released).toBe("899.00"); // swept back to treasury
    expect(r.captured).toBe("0.00");
    expect(r.reconciled).toBe(true);
    expect(await h.ledger.rlusdBalance(TREASURY.address)).toBe("5000.00");
    expect(h.sink.of("card.released")[0]!.payload).toMatchObject({ reason: "nothing_settled" });
    expect(h.pool.counts()).toMatchObject({ idle: 1 });
  });

  it("shop unreachable: same outcome, and the rule says which it was", async () => {
    const h = await harness({ shopsUrl: "http://127.0.0.1:1" });
    const r = await h.run(quote([L1]));

    expect(failure(h.sink)).toContain("shop_unreachable");
    expect(r.spent).toBe("0.00");
    expect(r.captured).toBe("0.00");
    expect(await h.ledger.rlusdBalance(TREASURY.address)).toBe("5000.00");
    expect(h.pool.counts()).toMatchObject({ idle: 1 });
  });

  it("shop takes the header, moves nothing and 402s again: bounded loss is zero, the card is released", async () => {
    const h = await harness({ misbehave: { reIssue402AfterPayment: true } });
    const r = await h.run(quote([L1]));

    expect(failure(h.sink)).toContain("shop_re_402");
    expect(h.shop.paidRequests).toBeGreaterThan(0); // it did receive a paid request
    expect(r.spent).toBe("0.00"); // the ledger is the truth, and nothing left the wallet
    expect(r.released).toBe("899.00");
    expect(r.captured).toBe("0.00");
    expect(r.reconciled).toBe(true);
    expect(await h.ledger.rlusdBalance(SHOP_A.payTo)).toBe("0.00");
  });
});

/**
 * A clean line is three POSTs: our own 402 probe, the SDK's unpaid request, then
 * the SDK's paid request. Which one dies decides whether money moved, so both
 * sides of that line are tested — this is REVIEW-LOG rule 3 ("failed after a
 * payment header was sent is *unknown*, not unpaid") and its mirror image.
 */
describe("failure modes: the network dies mid-payment", () => {
  it("dies BEFORE the payment goes out: nothing signed, the hold is released in full", async () => {
    let posts = 0;
    const flaky: typeof fetch = async (url, init) => {
      if (init?.method === "POST" && ++posts === 2) throw new TypeError("fetch failed: ECONNRESET");
      return fetch(url, init);
    };
    const h = await harness();
    const r = await h.run(quote([L1]), flaky);

    expect(h.shop.paidRequests).toBe(0); // no payment header ever reached the shop
    expect(r.ok).toBe(false);
    expect(r.spent).toBe("0.00");
    expect(r.released).toBe("899.00");
    expect(r.captured).toBe("0.00");
    expect(r.reconciled).toBe(true);
    expect(await h.ledger.rlusdBalance(SHOP_A.payTo)).toBe("0.00");
    expect(failure(h.sink)).toContain("sdk_failed");
    expect(h.pool.counts()).toMatchObject({ idle: 1 });
  });

  it("dies AFTER the payment lands: the shop is asked, the ledger agrees, the line counts as settled", async () => {
    // The paid request reaches the shop and settles; the response is lost on the way
    // back. Treating that as unpaid would release a hold for money that had gone.
    let posts = 0;
    const flaky: typeof fetch = async (url, init) => {
      if (init?.method === "POST" && ++posts === 3) {
        await fetch(url, init); // the shop settles
        throw new TypeError("socket hang up"); // ...and we never hear it
      }
      return fetch(url, init);
    };
    const h = await harness();
    const r = await h.run(quote([L1]), flaky);

    expect(h.shop.paidRequests).toBe(1);
    expect(await h.ledger.rlusdBalance(SHOP_A.payTo)).toBe("899.00");
    expect(r.ok).toBe(true);
    expect(r.spent).toBe("899.00");
    expect(r.captured).toBe("899.25");
    // The regression this guards: the line is recovered AND paid by this run, so it
    // must count towards this run's spend or reconciliation raises a false alarm.
    expect(r.reconciled).toBe(true);
    expect(h.sink.of("purchase.settled")[0]!.payload).toMatchObject({ recovered: true, after: "sdk_failed" });
  });
});

describe("failure modes: the shop takes the money", () => {
  it("takes the RLUSD then denies the order: the card is captured on what LEFT the wallet, and the mismatch is logged", async () => {
    const h = await harness({ misbehave: { takeMoneyThenRe402: true } });
    const r = await h.run(quote([L1]));

    // The money is gone to the shop's registered address: pretending otherwise
    // would mean keeping the customer's money (§13), so we capture and flag.
    expect(await h.ledger.rlusdBalance(SHOP_A.payTo)).toBe("899.00"); // the *registered* address
    expect(r.spent).toBe("899.00");
    expect(r.settled).toBe("0.00"); // no shop confirmation
    expect(r.reconciled).toBe(false);
    expect(r.captured).toBe("899.25"); // items that left the wallet + fee
    expect(failure(h.sink)).toEqual(expect.arrayContaining(["shop_re_402", "unreconciled"]));
    expect(r.captured).toBe("899.25");
    expect(r.ok).toBe(false);
    expect(h.pool.counts()).toMatchObject({ idle: 1 });
  });

  it("settles but returns a body with no order: recovery reads the order back and the line counts as settled", async () => {
    const h = await harness({ misbehave: { unparseableOrderBody: true } });
    const r = await h.run(quote([L1]));

    expect(r.ok).toBe(true);
    expect(r.settled).toBe("899.00");
    expect(r.captured).toBe("899.25");
    expect(r.reconciled).toBe(true);
    expect(h.sink.of("purchase.settled")[0]!.payload).toMatchObject({ recovered: true, after: "order_unparseable" });
  });

  it("settles, returns no order AND forgets the ref: bounded loss is one line, recorded with its tx hash", async () => {
    const h = await harness({ misbehave: { unparseableOrderBody: true, forgetOrders: true } });
    const r = await h.run(quote([L1]));

    expect(r.ok).toBe(false);
    expect(failure(h.sink)).toContain("order_unparseable");
    const failed = h.sink.of("purchase.failed").find((e) => (e.payload as { rule: string }).rule === "order_unparseable")!;
    expect(failed.payload).toMatchObject({ bounded_loss: "899.00" });
    expect((failed.payload as { tx_hash: string | null }).tx_hash).toBeTruthy(); // a human can find the money
    expect(r.reconciled).toBe(false);
    expect(failure(h.sink)).toContain("unreconciled");
  });
});

describe("failure modes: the ledger fails after the shops are paid", () => {
  it("the balance read fails: we are capturing on shop claims, so the run is never marked reconciled", async () => {
    const h = await harness();
    const real = h.ledger.rlusdBalance.bind(h.ledger);
    // Reads for one line: treasury precheck, start balance, per-line spendable, then
    // the read that decides what actually left the wallet. Kill the last one.
    let reads = 0;
    h.ledger.rlusdBalance = async (a) => {
      if (++reads === 4) throw new Error("ws closed before the final balance read");
      return real(a);
    };
    const r = await h.run(quote([L1]));

    expect(failure(h.sink)).toContain("ledger_unreadable");
    expect(h.sink.of("purchase.failed").at(-1)!.payload).toMatchObject({ capturing_on: "shop_confirmations" });
    // The shop confirmed and the money did move, so the capture is right — but we
    // could not verify it, and REVIEW-LOG rule 1 says never let that pass silently.
    expect(r.reconciled).toBe(false);
    expect(r.ok).toBe(false);
    expect(h.pool.counts()).toMatchObject({ attention: 1 });
  });


  it("sweep fails: the wallet is parked for an operator, and the settled line still captures", async () => {
    const h = await harness();
    const realPay = h.ledger.payRlusd.bind(h.ledger);
    // Funding from the treasury works; the sweep out of the session wallet does not.
    h.ledger.payRlusd = async (p) => {
      if (p.fromSeed === POOL.seed) throw new Error("ws closed mid-sweep");
      return realPay(p);
    };
    // Two lines, and the shop does not stock the second: its money is left in the
    // wallet, so there is something to sweep when the sweep breaks.
    const q = quote([L1, { line_id: "l_2", product_id: "p_missing", shop_id: "shop_b", price: "16.90" }]);
    const r = await h.run(q);

    expect(r.settled).toBe("899.00");
    expect(r.released).toBe("0.00"); // the 16.90 is stuck in the wallet, not swept
    expect(r.captured).toBe("899.25"); // the shop was paid for line 1; the customer owes for it
    expect(failure(h.sink)).toEqual(expect.arrayContaining(["shop_error", "sweep_failed"]));
    expect(h.pool.counts()).toMatchObject({ attention: 1 }); // never handed out again
    expect(h.sink.of("card.released")[0]!.payload).toMatchObject({ via: "partial_capture" });
  });
});
