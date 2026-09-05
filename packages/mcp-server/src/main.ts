import { MockCardAuthoriser, StripeCardAuthoriser, WalletPool, XrplLedger, loadShopRegistry, type CardAuthoriser, type RegisteredShop } from "@aishop4u/payments";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet } from "xrpl";
import type { Deps } from "./deps.js";
import { EventLog } from "./eventlog.js";
import { createHttpApp } from "./http.js";
import { createServer } from "./server.js";
import { SessionManager } from "./session.js";

/**
 * Real wiring. `--stdio` adds the stdio transport for Claude Desktop; the HTTP
 * surface (MCP over HTTP, read endpoints for the dashboard and curl) always runs.
 * Claude Desktop's cwd is not the repo, so every path is absolute.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const WIDGET_HTML = path.join(ROOT, "packages/widget/dist/index.html");
if (!fs.existsSync(WIDGET_HTML)) throw new Error(`widget bundle missing at ${WIDGET_HTML}; run: npm run build -w @aishop4u/widget`);

function treasury(): { seed: string; address: string } {
  const seed = process.env.TREASURY_SEED || (JSON.parse(fs.readFileSync(path.join(ROOT, ".wallets/spike.json"), "utf8")) as { treasury: string }).treasury;
  return { seed, address: Wallet.fromSeed(seed).address };
}

const rlusd = {
  currencyHex: process.env.RLUSD_CURRENCY_HEX ?? "524C555344000000000000000000000000000000",
  issuer: process.env.RLUSD_ISSUER ?? "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
};
const shopsUrl = process.env.SHOPS_URL ?? `http://localhost:${process.env.SHOPS_PORT ?? "4002"}`;
let registry: Record<string, RegisteredShop> | undefined;

// Real card charge when a Stripe test key is present; otherwise the mock (§15.4, §5 step 11).
const card: CardAuthoriser = process.env.STRIPE_SECRET_KEY
  ? new StripeCardAuthoriser(process.env.STRIPE_SECRET_KEY)
  : new MockCardAuthoriser();
process.stderr.write(`aishop4u mcp-server: card leg = ${card.mocked ? "mock" : "Stripe test-mode"}\n`);

const deps: Deps = {
  manager: new SessionManager(new EventLog(path.join(ROOT, ".sessions")), process.env.SERVICE_FEE ?? "0.25"),
  shopsUrl,
  fetchImpl: fetch,
  ledger: new XrplLedger(process.env.XRPL_WS_URL ?? "wss://s.altnet.rippletest.net:51233", rlusd),
  pool: WalletPool.fromFile(path.join(ROOT, ".wallets/pool.json")),
  card,
  treasury: treasury(),
  rlusd,
  network: (process.env.XRPL_NETWORK ?? "xrpl:1") as Deps["network"],
  loadRegistry: async () => (registry ??= await loadShopRegistry(shopsUrl)),
  widgetHtml: WIDGET_HTML,
};

const port = Number.parseInt(process.env.MCP_PORT ?? "3001", 10);
const stdio = process.argv.includes("--stdio");
createHttpApp(deps)
  .listen(port, () => {
    process.stderr.write(`aishop4u mcp-server: http://localhost:${port}/mcp  (pool ${JSON.stringify(deps.pool.counts())})\n`);
  })
  .on("error", (e: NodeJS.ErrnoException) => {
    // Claude Desktop launches several stdio instances (chat, plus its Cowork/Code pool). Only one
    // can own the port; the others must keep serving stdio. HTTP reads project from the shared
    // on-disk log, so whichever instance has the port can show every session.
    if (e.code === "EADDRINUSE") {
      process.stderr.write(`aishop4u mcp-server: port ${port} in use; this instance serves ${stdio ? "stdio only" : "nothing"}. Reads are served by the instance that owns the port.\n`);
      if (!stdio) process.exit(1);
      return;
    }
    throw e;
  });

// §15.5 expiry: abandoned sessions are expired; nothing is funded before purchase, so this is state only.
const SESSION_MAX_AGE_MS = Number.parseInt(process.env.SESSION_MAX_AGE_MS ?? String(30 * 60_000), 10);
setInterval(() => {
  const expired = deps.manager.expireStale(SESSION_MAX_AGE_MS);
  if (expired.length > 0) process.stderr.write(`aishop4u mcp-server: expired ${expired.length} stale session(s)\n`);
}, 60_000).unref();

if (stdio) {
  const server = createServer(deps);
  await server.connect(new StdioServerTransport());
  // stdout is the protocol channel in stdio mode; log to stderr only.
  process.stderr.write("aishop4u mcp-server: stdio transport connected\n");
}
