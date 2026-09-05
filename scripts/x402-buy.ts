/**
 * End-to-end check of CLAUDE.md §5 step 3: buy one product from the running shops
 * server over x402, paying RLUSD from the treasury through the t54 testnet facilitator.
 *
 *   npx tsx scripts/x402-buy.ts [shop_id=shop_a] [product_id=p_a08]
 *
 * Prints the 402 terms, the settlement tx hash, the order, and the invoice outbox file.
 * Requires: shops server running (npm run dev -w @buffet/shops), treasury with RLUSD.
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet } from "xrpl";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, x402Fetch } from "x402-xrpl";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const SHOPS = process.env.SHOPS_URL ?? `http://localhost:${process.env.SHOPS_PORT ?? "4002"}`;
const shopId = process.argv[2] ?? "shop_a";
const productId = process.argv[3] ?? "p_a08";

function treasury(): Wallet {
  if (process.env.TREASURY_SEED) return Wallet.fromSeed(process.env.TREASURY_SEED);
  const f = path.join(ROOT, ".wallets/spike.json");
  return Wallet.fromSeed((JSON.parse(fs.readFileSync(f, "utf8")) as { treasury: string }).treasury);
}

async function main(): Promise<void> {
  const wallet = treasury();
  const url = `${SHOPS}/shops/${shopId}/orders/${productId}`;
  const body = JSON.stringify({
    // Fixed ref per product so a rerun demonstrates idempotency; pass a 4th arg to force a fresh order.
    invoice_ref: process.argv[4] ?? `q_demo:${productId}:${"ab".repeat(16)}`,
    delivery: { name: "Demo Buyer", email: process.env.DEMO_BILLING_EMAIL ?? "demo.buyer@example.com", address: "1 Marina Bay, Singapore" },
  });
  const headers = { "content-type": "application/json" };

  // 1. Look at the 402 first, so the terms are visible in the log.
  const first = await fetch(url, { method: "POST", headers, body });
  console.log("first response:", first.status);
  if (first.status === 200) {
    // Same invoice_ref as a settled order: the shop returns it without a second payment.
    console.log("already settled for this invoice_ref (idempotent), no payment made:", await first.json());
    return;
  }
  const pr = first.headers.get("PAYMENT-REQUIRED");
  if (first.status !== 402 || !pr) throw new Error(`expected 402 with PAYMENT-REQUIRED, got ${first.status}: ${await first.text()}`);
  const terms = decodePaymentRequiredHeader(pr).accepts[0]!;
  console.log("402 terms:", { amount: terms.amount, asset: terms.asset, payTo: terms.payTo, invoiceId: terms.extra?.invoiceId });

  // 2. Pay with the SDK client: it re-requests, gets a fresh 402, signs, retries.
  const fetchPaid = x402Fetch({ wallet, network: "xrpl:1", maxValue: terms.amount });
  const t0 = Date.now();
  const resp = await fetchPaid(url, { method: "POST", headers, body });
  console.log(`paid response: ${resp.status} in ${Date.now() - t0}ms`);
  const prh = resp.headers.get("PAYMENT-RESPONSE");
  if (prh) {
    const settled = decodePaymentResponseHeader(prh);
    console.log("settlement:", settled);
    console.log(`explorer https://testnet.xrpl.org/transactions/${settled.transaction}`);
  }
  const order = (await resp.json()) as { order_id?: string };
  console.log("order:", order);
  if (order.order_id) {
    const f = path.join(ROOT, ".outbox", `${order.order_id}.json`);
    console.log("invoice outbox:", fs.existsSync(f) ? f : "(missing)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
