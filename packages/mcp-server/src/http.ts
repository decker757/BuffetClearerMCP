import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express, { type Express } from "express";
import type { Deps } from "./deps.js";
import { EventLog } from "./eventlog.js";
import { projectSnapshot } from "./projection.js";
import { createServer } from "./server.js";

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

  app.get("/health", (_req, res) => res.json({ ok: true, name: "aishop4u", pool: deps.pool.counts() }));

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

  // Every read goes through the log, which is re-tailed from disk on each request, so a session
  // owned by another process (Claude Desktop launches several) is still visible here.
  const log = deps.manager.log;
  const events = (id: string) => {
    log.reload(id);
    return log.all(id);
  };

  app.get("/sessions", (_req, res) => {
    const ids = log.sessionsOnDisk().slice(0, 50);
    res.json({
      sessions: ids.map((id) => {
        const snap = projectSnapshot(events(id));
        return snap ? { session_id: id, objective: snap.objective, phase: snap.phase, head_seq: snap.head_seq } : { session_id: id };
      }),
    });
  });

  app.get("/sessions/:id", (req, res) => {
    const id = req.params.id;
    if (deps.manager.has(id)) {
      res.json({ ...deps.manager.snapshot(id), pool: deps.pool.counts(), card: deps.card.descriptor, source: "live" });
      return;
    }
    const snap = projectSnapshot(events(id));
    if (!snap) {
      res.status(404).json({ error: "unknown_session" });
      return;
    }
    res.json({ ...snap, pool: deps.pool.counts(), card: deps.card.descriptor, source: "log" });
  });

  app.get("/sessions/:id/events", (req, res) => {
    const all = events(req.params.id);
    if (all.length === 0) return res.status(404).json({ error: "unknown_session" });
    const after = Number.parseInt(String(req.query.after ?? "0"), 10);
    const afterSeq = Number.isFinite(after) ? after : 0;
    return res.json({ events: all.filter((e) => e.seq > afterSeq), head_seq: all[all.length - 1]!.seq });
  });

  app.get("/sessions/:id/verify", (req, res) => {
    const all = events(req.params.id);
    if (all.length === 0) return res.status(404).json({ error: "unknown_session" });
    return res.json({ ...EventLog.verify(all), events: all.length, head: { seq: all[all.length - 1]!.seq, hash: all[all.length - 1]!.hash } });
  });

  return app;
}
