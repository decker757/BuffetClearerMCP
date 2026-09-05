/**
 * Real run of the payments layer on XRPL testnet (CLAUDE.md §5 step 4 gate):
 * authorise (mock card) -> fund a pool wallet from treasury -> pay one line over x402
 * through the t54 facilitator -> sweep -> capture. Prints every event and the hashes.
 *
 *   npx tsx scripts/settle-demo.ts [product_id=p_a08]
 *
 * Requires: shops server running (npm run dev -w @aishop4u/shops), a provisioned pool
 * (npm run provision -- pool 2), treasury with RLUSD (npm run fund:treasury).
 */
import { chainHash, type Quote } from "@aishop4u/shared";
import { MockCardAuthoriser, WalletPool, XrplLedger, loadShopRegistry, settlePurchase, type EventSink } from "@aishop4u/payments";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet } from "xrpl";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const SHOPS = process.env.SHOPS_URL ?? `http://localhost:${process.env.SHOPS_PORT ?? "4002"}`;
const RLUSD = {
  currencyHex: process.env.RLUSD_CURRENCY_HEX ?? "524C555344000000000000000000000000000000",
  issuer: process.env.RLUSD_ISSUER ?? "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
};
const WS = process.env.XRPL_WS_URL ?? "wss://s.altnet.rippletest.net:51233";
const productId = process.argv[2] ?? "p_a08";
/** Pass a fixed quote id as the 3rd arg to rerun the same quote and exercise on-ledger recovery. */
const quoteId = process.argv[3] ?? `q_${Date.now().toString(36)}`;

function treasury(): { seed: string; address: string } {
  const seed = process.env.TREASURY_SEED ?? (JSON.parse(fs.readFileSync(path.join(ROOT, ".wallets/spike.json"), "utf8")) as { treasury: string }).treasury;
  return { seed, address: Wallet.fromSeed(seed).address };
}

const sink: EventSink = {
  emit: (e) => {
    const p = e.payload as Record<string, unknown>;
    const extra = p.tx_hash ? `  ${String(p.explorer ?? p.tx_hash)}` : p.rule ? `  rule=${String(p.rule)}` : "";
    console.log(`[${e.type}]${e.duration_ms !== undefined ? ` ${e.duration_ms}ms` : ""}${extra}`);
  },
};

async function main(): Promise<void> {
  const shops = await loadShopRegistry(SHOPS);
  const products = (await fetch(`${SHOPS}/products?q=laptop%20cable&min_price=1&max_price=5000`).then((r) => r.json())) as { products: Array<{ id: string; shop_id: string; product_name: string; price: string }> };
  const product = products.products.find((p) => p.id === productId);
  if (!product) throw new Error(`product ${productId} not found via browse`);

  const lines = [{ line_id: "l_1", product_id: product.id, shop_id: product.shop_id, product_name: product.product_name, price: product.price }];
  const fee = process.env.SERVICE_FEE ?? "0.25";
  const total = (Number(product.price) + Number(fee)).toFixed(2);
  const base = { session_id: "s_demo", quote_id: quoteId, lines, items_total: product.price, fee, total, expires_at: new Date(Date.now() + 600_000).toISOString() };
  const quote: Quote = { ...base, quote_hash: chainHash(base) };
  const manifest_hash = chainHash({ demo: true, quote_id: quote.quote_id });
  console.log(`quote ${quote.quote_id}: ${product.product_name} @ ${product.price} RLUSD from ${product.shop_id}, fee ${fee}, total ${total}`);

  const ledger = new XrplLedger(WS, RLUSD);
  const pool = WalletPool.fromFile(path.join(ROOT, ".wallets/pool.json"));
  console.log("pool:", pool.counts());
  try {
    const t0 = Date.now();
    const r = await settlePurchase({
      session_id: "s_demo",
      quote,
      manifest_hash,
      delivery: { name: "Demo Buyer", email: process.env.DEMO_BILLING_EMAIL ?? "demo.buyer@example.com", address: "1 Marina Bay, Singapore" },
      shops,
      shopsUrl: SHOPS,
      treasury: treasury(),
      pool,
      ledger,
      card: new MockCardAuthoriser(),
      rlusd: RLUSD,
      network: "xrpl:1",
      sink,
    });
    console.log(`\nresult in ${Date.now() - t0}ms:`, { ok: r.ok, wallet: r.wallet, funded: r.funded, settled: r.settled, released: r.released, fee: r.fee, captured: r.captured, fund_tx: r.fund_tx, sweep_tx: r.sweep_tx });
    for (const l of r.lines) console.log("line", l.line_id, l.result);
    console.log("pool after:", pool.counts());
  } finally {
    await ledger.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
