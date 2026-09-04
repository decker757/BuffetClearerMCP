import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express, { type Express } from "express";
import type { Deps } from "./deps.js";
import { EventLog } from "./eventlog.js";
import { createServer } from "./server.js";
import { SessionError } from "./session.js";

/**
 * HTTP surface (CLAUDE.md §12): the MCP Streamable HTTP endpoint plus the two reads
 * exposed a second time for the fallback dashboard and for a judge with curl.
 *
 *   POST /mcp
 *   GET  /sessions/:id                 snapshot (never billing content)
 *   GET  /sessions/:id/events?after=N  events with seq > N
 *   GET  /sessions/:id/verify          re-hash the chain from genesis
 *   GET  /health
 *   GET  /dashboard?session=<id>       the widget bundle in read-only HTTP mode (demo insurance)
 */
export function createHttpApp(deps: Deps): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  // Reads are public by session id (a judge with curl, the fallback dashboard).
  app.use("/sessions", cors({ origin: "*" }));
  app.use("/health", cors({ origin: "*" }));
  // The MCP endpoint is not for browsers: no CORS unless an origin is configured (e.g. the ext-apps basic-host).
  if (process.env.MCP_CORS_ORIGIN) app.use("/mcp", cors({ origin: process.env.MCP_CORS_ORIGIN, exposedHeaders: ["Mcp-Session-Id"] }));

  app.get("/health", (_req, res) => res.json({ ok: true, name: "buffet", pool: deps.pool.counts() }));

  // The fallback dashboard: the same widget bundle, in HTTP read-only mode (?session=<id>).
  app.get("/dashboard", (_req, res) => {
    res.type("html").sendFile(deps.widgetHtml);
  });

  app.post("/mcp", async (req, res) => {
    const server = createServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.get("/mcp", (_req, res) => res.status(405).json({ error: "stateless server: use POST /mcp" }));

  app.get("/sessions/:id", (req, res) => {
    try {
      res.json({ ...deps.manager.snapshot(req.params.id), pool: deps.pool.counts() });
    } catch (e) {
      res.status(e instanceof SessionError ? 404 : 500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // Events and verification come from the log, so they survive a restart even when the live session does not.
  app.get("/sessions/:id/events", (req, res) => {
    if (deps.manager.log.all(req.params.id).length === 0) return res.status(404).json({ error: "unknown_session" });
    const after = Number.parseInt(String(req.query.after ?? "0"), 10);
    const events = deps.manager.log.after(req.params.id, Number.isFinite(after) ? after : 0);
    return res.json({ events, head_seq: deps.manager.log.head(req.params.id).seq });
  });

  app.get("/sessions/:id/verify", (req, res) => {
    if (deps.manager.log.all(req.params.id).length === 0) return res.status(404).json({ error: "unknown_session" });
    const events = deps.manager.log.all(req.params.id);
    return res.json({ ...EventLog.verify(events), events: events.length, head: deps.manager.log.head(req.params.id) });
  });

  return app;
}
