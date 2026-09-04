import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertWidgetBuilt, createServer } from "./server.js";

// Claude Desktop's cwd is not the repo, so load .env by path. `quiet` keeps dotenv
// off stdout, which is the protocol channel in stdio mode.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
assertWidgetBuilt();

// `--stdio` for Claude Desktop (claude_desktop_config.json); default is Streamable HTTP
// on /mcp for the ext-apps basic-host and for a custom connector behind a tunnel.

async function startStdio(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  // Never write to stdout here: it is the protocol channel.
  process.stderr.write("buffet mcp-server: stdio transport connected\n");
}

async function startHttp(): Promise<void> {
  const port = Number.parseInt(process.env.MCP_PORT ?? "3001", 10);
  const app = express();
  // Tighten to the tunnel / host origin before anything spendable exists (phase 3).
  const origin = process.env.MCP_CORS_ORIGIN ?? "*";
  app.use(cors({ origin, exposedHeaders: ["Mcp-Session-Id"] }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true, name: "buffet" }));

  app.post("/mcp", async (req, res) => {
    // Stateless: one server + transport per request, per the ext-apps example.
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({ error: "stateless server: use POST /mcp" });
  });

  app.listen(port, () => {
    console.log(`buffet mcp-server: http://localhost:${port}/mcp`);
  });
}

if (process.argv.includes("--stdio")) {
  await startStdio();
} else {
  await startHttp();
}
