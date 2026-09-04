import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Phase 1 spike: one tool that opens the widget, one app-only tool the widget can call.
// The real tool surface (CLAUDE.md §3) replaces this in phase 4.

const HERE = path.dirname(fileURLToPath(import.meta.url));
// From packages/mcp-server/src or packages/mcp-server/dist -> packages/widget/dist/index.html
const WIDGET_HTML = path.resolve(HERE, "../../widget/dist/index.html");

export const WIDGET_URI = "ui://buffet/monitor.html";

/** Call once at startup: a missing widget bundle must fail loudly, not mid-demo. */
export function assertWidgetBuilt(): void {
  if (!existsSync(WIDGET_HTML)) {
    throw new Error(`widget bundle missing at ${WIDGET_HTML}; run: npm run build -w @buffet/widget`);
  }
}

export function newSessionId(): string {
  return `s_${randomBytes(8).toString("hex")}`;
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "buffet", version: "0.0.1" });

  registerAppTool(
    server,
    "start_session",
    {
      title: "Start a supervised shopping session",
      description:
        "Opens the Buffet monitor for a new shopping session. Call this first, before asking the user for preferences.",
      inputSchema: {
        objective: z.string().min(1).max(500).describe("What the user wants to buy, in their words"),
        reason: z.string().min(1).max(500).describe("Why you are starting a session now"),
      },
      outputSchema: z.object({ session_id: z.string(), phase: z.string() }),
      _meta: { ui: { resourceUri: WIDGET_URI } },
    },
    async ({ objective }): Promise<CallToolResult> => {
      const session_id = newSessionId();
      const structured = { session_id, phase: "started" };
      return {
        content: [{ type: "text", text: `Session ${session_id} started for: ${objective}` }],
        structuredContent: structured,
      };
    },
  );

  // App-only: the widget calls it, the model should not. Visibility is enforced
  // properly in phase 4 (tool annotations + name prefix filtering); for the spike
  // it simply exists so the round trip can be tested.
  registerAppTool(
    server,
    "widget_ping",
    {
      title: "Widget ping",
      description: "Internal: used by the monitor widget to check connectivity. Not for the model.",
      inputSchema: {},
      outputSchema: z.object({ time: z.string() }),
      _meta: { ui: { resourceUri: WIDGET_URI, visibility: ["app"] } },
    },
    async (): Promise<CallToolResult> => {
      const time = new Date().toISOString();
      return { content: [{ type: "text", text: time }], structuredContent: { time } };
    },
  );

  registerAppResource(
    server,
    WIDGET_URI,
    WIDGET_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(WIDGET_HTML, "utf8");
      return { contents: [{ uri: WIDGET_URI, mimeType: RESOURCE_MIME_TYPE, text: html }] };
    },
  );

  return server;
}
