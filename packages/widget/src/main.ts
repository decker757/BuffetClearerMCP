import { App, applyDocumentTheme, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Hello-world MCP App (CLAUDE.md §5 step 1). Renders a box, shows the session id
// from the tool result, and proves the widget can call an app-only tool.

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};

// Seller-derived strings are rendered as text, never HTML (invariant 4).
function setText(id: string, value: unknown): void {
  $(id).textContent = typeof value === "string" ? value : JSON.stringify(value);
}

const app = new App({ name: "Buffet monitor", version: "0.0.1" });

app.onhostcontextchanged = (ctx: McpUiHostContext) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  setText("host", `host: theme=${ctx.theme ?? "?"}`);
};

app.ontoolresult = (result: CallToolResult) => {
  const sc = (result.structuredContent ?? {}) as { session_id?: string };
  setText("session", sc.session_id ?? "(no session_id in result)");
};

app.onerror = (e) => setText("host", `error: ${String(e)}`);

$("ping").addEventListener("click", async () => {
  try {
    const res = await app.callServerTool({ name: "widget_ping", arguments: {} });
    const sc = (res.structuredContent ?? {}) as { time?: string };
    setText("time", sc.time ?? "(no time)");
  } catch (e) {
    setText("time", `error: ${String(e)}`);
  }
});

app
  .connect()
  .then(() => {
    const ctx = app.getHostContext();
    if (ctx?.theme) applyDocumentTheme(ctx.theme);
    setText("host", `host: connected, theme=${ctx?.theme ?? "?"}`);
  })
  .catch((e: unknown) => setText("host", `host: connect failed: ${String(e)}`));
