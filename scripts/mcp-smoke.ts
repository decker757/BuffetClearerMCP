/**
 * Live driver for the whole loop over MCP (Streamable HTTP), playing both Claude
 * and the widget. Proves phase 4 against the real shops server and XRPL testnet.
 *
 *   npx tsx scripts/mcp-smoke.ts [query=usb-c cable] [min=5] [max=30]
 *
 * Requires: shops server (npm run dev -w @buffet/shops) and the MCP server
 * (npm run dev:mcp) running, pool provisioned, treasury funded.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MCP = process.env.MCP_URL ?? "http://localhost:3001";
const [query = "usb-c cable", min = "5", max = "30"] = process.argv.slice(2);
// MCP_TRANSPORT=stdio spawns a second server instance the way Claude Desktop does, while the
// HTTP instance keeps the port; the reads at the end must still show this session (log projection).
const useStdio = process.env.MCP_TRANSPORT === "stdio";

const client = new Client({ name: "buffet-driver", version: "0.1.0" });
if (useStdio) {
  const main = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/mcp-server/dist/main.js");
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [main, "--stdio"], stderr: "inherit" }));
} else {
  await client.connect(new StreamableHTTPClientTransport(new URL(`${MCP}/mcp`)));
}

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as Array<{ text?: string }>)[0]?.text ?? "";
  console.log(`${r.isError ? "✗" : "✓"} ${name} (${Date.now() - t0}ms): ${text.slice(0, 160)}`);
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return (r.structuredContent ?? {}) as Record<string, unknown>;
}

const { tools } = await client.listTools();
console.log(`driver transport: ${useStdio ? "stdio (spawned a second server instance)" : `http ${MCP}`}`);
console.log("tools:", tools.map((t) => t.name).join(", "));

const start = await call("start_session", { objective: query, reason: "driver: user asked" });
const sid = start.session_id as string;

try {
  await call("browse", { session_id: sid, query, min_price: "0", max_price: "0", reason: "driver: deliberately bad range" });
} catch {
  console.log("  (bad range refused as expected)");
}

const browse = await call("browse", { session_id: sid, query, min_price: min, max_price: max, reason: "driver: user gave range" });
const products = browse.products as Array<{ id: string; product_name: string; price: string; quantity_sold: number; product_rating: number; shop_rating: number }>;
if (products.length === 0) throw new Error("nothing in range");
// Rank like the instructions say, flag anything with a high rating on very few sales.
const ranked = [...products].sort((a, b) => b.quantity_sold - a.quantity_sold);
const flagged = ranked.filter((p) => p.product_rating >= 4.8 && p.quantity_sold < 10);
const recommended = ranked.filter((p) => !flagged.includes(p)).slice(0, 5);
await call("propose", {
  session_id: sid,
  recommended: recommended.map((p) => p.id),
  rejected: flagged.map((p) => ({ product_id: p.id, reason: `${p.product_rating} rating on only ${p.quantity_sold} sales`, evidence: { product_rating: p.product_rating, quantity_sold: p.quantity_sold, price: p.price } })),
  reason: "driver: rank by sales, flag thin-history listings",
});

// Widget actions
const pick = recommended[0]!;
await call("select_candidate", { session_id: sid, product_id: pick.id });
await call("submit_billing", { session_id: sid, name: "Demo Buyer", email: "demo.buyer@example.com", address: "1 Marina Bay, Singapore" });
const checkout = await call("checkout", { session_id: sid, reason: "driver: selection and billing are in" });
const quote_id = checkout.quote_id as string;

try {
  await call("purchase", { session_id: sid, quote_id, reason: "driver: deliberately before approval" });
} catch {
  console.log("  (purchase before approval refused as expected)");
}

await call("approve_quote", { session_id: sid, quote_id });
const receipt = await call("purchase", { session_id: sid, quote_id, reason: "driver: user approved in the widget" });
console.log("\nreceipt:", JSON.stringify(receipt, null, 2));

// What a judge can curl
const verify = (await fetch(`${MCP}/sessions/${sid}/verify`).then((r) => r.json())) as { ok: boolean; events: number };
console.log(`\nchain verify: ok=${verify.ok} over ${verify.events} events  ->  curl ${MCP}/sessions/${sid}/events`);
const snap = (await fetch(`${MCP}/sessions/${sid}`).then((r) => r.json())) as { phase?: string; source?: string; ledger?: unknown };
console.log(`snapshot via HTTP: phase=${snap.phase} source=${snap.source} ledger=${JSON.stringify(snap.ledger)}`);
await client.close();
