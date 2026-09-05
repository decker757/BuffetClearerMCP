import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createShopsApp } from "./app.js";
import { Catalog } from "./catalog.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

/** Shop payTo addresses: env SHOP_A_ADDRESS / SHOP_B_ADDRESS, else .wallets/shops.json from scripts/provision.ts. */
function loadPayTo(shopIds: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const file = path.join(ROOT, ".wallets/shops.json");
  const saved = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, { address: string }>)
    : {};
  for (const id of shopIds) {
    const env = process.env[`${id.toUpperCase()}_ADDRESS`];
    const addr = env ?? saved[id]?.address;
    if (!addr) throw new Error(`no address for ${id}: set ${id.toUpperCase()}_ADDRESS or run: npm run provision -- shops`);
    out[id] = addr;
  }
  return out;
}

const catalog = Catalog.fromFile();
const network = (process.env.XRPL_NETWORK ?? "xrpl:1") as "xrpl:0" | "xrpl:1" | "xrpl:2";
const { app } = createShopsApp({
  catalog,
  payTo: loadPayTo(catalog.shops.map((s) => s.shop_id)),
  rlusd: {
    currencyHex: process.env.RLUSD_CURRENCY_HEX ?? "524C555344000000000000000000000000000000",
    issuer: process.env.RLUSD_ISSUER ?? "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
  },
  network,
  facilitatorUrl: process.env.X402_FACILITATOR_URL ?? "https://xrpl-facilitator-testnet.t54.ai",
  outboxDir: path.join(ROOT, ".outbox"),
  email: { apiKey: process.env.RESEND_API_KEY, from: process.env.INVOICE_FROM },
});

const port = Number.parseInt(process.env.SHOPS_PORT ?? "4002", 10);
app.listen(port, () => {
  console.log(`aishop4u shops: http://localhost:${port}  (${catalog.shops.length} shops, ${catalog.all().length} products, ${network})`);
});
