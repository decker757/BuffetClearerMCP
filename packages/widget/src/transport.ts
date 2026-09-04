import { App, applyDocumentTheme, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SessionEvent, SessionSnapshot } from "@buffet/shared";

/**
 * Two ways to reach the server, one interface.
 *
 *  - HostTransport: inside Claude, over the MCP Apps bridge, calling the app-only tools.
 *    Can act (select, billing, approve, abort).
 *  - HttpTransport: the fallback dashboard, polling GET /sessions/:id and /events.
 *    Read-only: the write tools are app-only on purpose.
 */
export interface Snapshot extends SessionSnapshot {
  pool?: Record<string, number>;
}

export interface Transport {
  readonly canAct: boolean;
  readonly label: string;
  snapshot(session_id: string): Promise<Snapshot>;
  events(session_id: string, after_seq: number): Promise<{ events: SessionEvent[]; head_seq: number }>;
  select(session_id: string, product_id: string): Promise<void>;
  submitBilling(session_id: string, b: { name: string; email: string; address: string }): Promise<void>;
  approve(session_id: string, quote_id: string): Promise<void>;
  abort(session_id: string): Promise<void>;
  /** Ask the host to post a user message so the agent continues without the user typing. False if not delivered. */
  nudge(text: string): Promise<boolean>;
  /** Fires when the host pushes a tool result (the model called a tool that renders this widget). */
  onToolResult?: (structured: Record<string, unknown>) => void;
  /** Fires with the tool call's name and arguments, before the result: every model tool carries session_id. */
  onToolInput?: (tool: string | undefined, args: Record<string, unknown>) => void;
  onThemeChange?: (theme: string | undefined) => void;
}

function structured(r: CallToolResult): Record<string, unknown> {
  if (r.isError) {
    const text = (r.content as Array<{ text?: string }>)[0]?.text ?? "tool error";
    throw new Error(text);
  }
  return (r.structuredContent ?? {}) as Record<string, unknown>;
}

export class HostTransport implements Transport {
  readonly canAct = true;
  readonly label = "widget";
  onToolResult?: (structured: Record<string, unknown>) => void;
  onToolInput?: (tool: string | undefined, args: Record<string, unknown>) => void;
  onThemeChange?: (theme: string | undefined) => void;
  private readonly app = new App({ name: "Buffet monitor", version: "0.1.0" });

  async connect(): Promise<void> {
    this.app.ontoolinput = (params) => {
      const p = params as { name?: string; arguments?: Record<string, unknown> };
      this.onToolInput?.(p.name, p.arguments ?? {});
    };
    this.app.ontoolresult = (result: CallToolResult) => {
      if (!result.isError) this.onToolResult?.((result.structuredContent ?? {}) as Record<string, unknown>);
    };
    this.app.onhostcontextchanged = (ctx: McpUiHostContext) => this.theme(ctx);
    this.app.onerror = (e) => console.error("[buffet widget]", e);
    await this.app.connect();
    const ctx = this.app.getHostContext();
    if (ctx) this.theme(ctx);
  }

  private theme(ctx: McpUiHostContext): void {
    if (ctx.theme) applyDocumentTheme(ctx.theme);
    this.onThemeChange?.(ctx.theme);
  }

  private async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return structured(await this.app.callServerTool({ name, arguments: args }));
  }

  async snapshot(session_id: string): Promise<Snapshot> {
    return (await this.call("session_snapshot", { session_id })) as unknown as Snapshot;
  }
  async events(session_id: string, after_seq: number): Promise<{ events: SessionEvent[]; head_seq: number }> {
    return (await this.call("session_events", { session_id, after_seq })) as unknown as { events: SessionEvent[]; head_seq: number };
  }
  async select(session_id: string, product_id: string): Promise<void> {
    await this.call("select_candidate", { session_id, product_id });
  }
  async submitBilling(session_id: string, b: { name: string; email: string; address: string }): Promise<void> {
    await this.call("submit_billing", { session_id, ...b });
  }
  async approve(session_id: string, quote_id: string): Promise<void> {
    await this.call("approve_quote", { session_id, quote_id });
  }
  async abort(session_id: string): Promise<void> {
    await this.call("abort_session", { session_id });
  }
  async nudge(text: string): Promise<boolean> {
    try {
      const { isError } = await this.app.sendMessage({ role: "user", content: [{ type: "text", text }] }, { signal: AbortSignal.timeout(4000) });
      return !isError;
    } catch (e) {
      console.info("[buffet widget] nudge not delivered:", e);
      return false;
    }
  }
}

export class HttpTransport implements Transport {
  readonly canAct = false;
  readonly label = "dashboard (read-only)";
  onToolResult?: (structured: Record<string, unknown>) => void;
  onToolInput?: (tool: string | undefined, args: Record<string, unknown>) => void;
  onThemeChange?: (theme: string | undefined) => void;
  constructor(private readonly base: string) {}

  private async get<T>(path: string): Promise<T> {
    const r = await fetch(`${this.base}${path}`);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
    return (await r.json()) as T;
  }
  snapshot(session_id: string): Promise<Snapshot> {
    return this.get(`/sessions/${encodeURIComponent(session_id)}`);
  }
  events(session_id: string, after_seq: number): Promise<{ events: SessionEvent[]; head_seq: number }> {
    return this.get(`/sessions/${encodeURIComponent(session_id)}/events?after=${after_seq}`);
  }
  async select(): Promise<void> {
    throw new Error("read-only dashboard");
  }
  async submitBilling(): Promise<void> {
    throw new Error("read-only dashboard");
  }
  async approve(): Promise<void> {
    throw new Error("read-only dashboard");
  }
  async abort(): Promise<void> {
    throw new Error("read-only dashboard");
  }
  async nudge(): Promise<boolean> {
    return false;
  }
}
