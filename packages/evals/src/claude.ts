import Anthropic from "@anthropic-ai/sdk";
import type { SessionEvent } from "@aishop4u/shared";
import type { Harness, ToolCall } from "./harness.js";
import type { ScriptedUser } from "./user.js";

/**
 * Drives real Claude over the real MCP tool surface, with a scripted user on the
 * other side. A manual loop rather than the SDK tool runner: every tool call has
 * to pass through the host emulation in `harness.modelCall`, and the scripted
 * user has to act between turns, neither of which the runner exposes.
 *
 * Only the TEXT part of a tool result is fed back, because that is all Claude
 * Desktop shows the model (REVIEW-LOG phase 6). An eval that fed back
 * structuredContent would pass on a build that is broken in the real host.
 */

export const DEFAULT_MODEL = process.env.EVAL_MODEL ?? "claude-sonnet-5";
const MAX_TOKENS = 8192;

/** A typo in an env var must not silently turn every cap into NaN. */
export function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function envFloat(name: string, fallback: number): number {
  const n = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(n) ? n : fallback;
}

/** The happy path needs ~10 turns; the cap is a runaway guard, not a target. */
const MAX_TURNS = envInt("EVAL_MAX_TURNS", 24);

/** $/1M tokens, for the estimate printed at the end of a run. */
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

export interface Usage {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
}

export interface Trace {
  scenario: string;
  model: string;
  session_id?: string;
  /** every tool call the model made, in order, including host refusals */
  calls: ToolCall[];
  toolSeq: string[];
  /** what the model said to the user, turn by turn */
  assistant: string[];
  /** what the scripted user said back */
  user: string[];
  events: SessionEvent[];
  eventTypes: string[];
  /** anything the server printed during the run: the "never in logs" half of §10 */
  stdout: string[];
  usage: Usage;
  stopped: "user_ended" | "turn_cap" | "max_tokens" | "refusal";
}

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export const NO_KEY_MESSAGE =
  "ANTHROPIC_API_KEY is not set: skipping the model-driven scenarios. Put a key in .env (gitignored) and re-run `npm run eval`. The deterministic guardrail suite still ran.";

export function estimateCost(u: Usage, model: string): number {
  const p = PRICES[model] ?? PRICES["claude-sonnet-5"]!;
  return (u.input_tokens * p.in + u.output_tokens * p.out) / 1_000_000;
}

export function emptyUsage(): Usage {
  return { requests: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    requests: a.requests + b.requests,
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
  };
}

/** Just enough of the SDK to run the loop; the offline self-test passes a stub. */
export interface MessagesClient {
  messages: { create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

export interface RunOptions {
  scenario: string;
  harness: Harness;
  user: ScriptedUser;
  /** the user's opening line in the chat */
  opening: string;
  maxTurns?: number;
  model?: string;
  /** test seam: a scripted model, so the harness can be proven without spending anything */
  client?: MessagesClient;
}

export async function runScenario(o: RunOptions): Promise<Trace> {
  const client: MessagesClient = o.client ?? new Anthropic();
  const model = o.model ?? DEFAULT_MODEL;
  const maxTurns = o.maxTurns ?? MAX_TURNS;
  const tools: Anthropic.Tool[] = o.harness.modelTools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));

  // The server's own instructions, plus the one fact the API cannot see: that the
  // user has the widget open beside the chat. Nothing here hints at the answers.
  const system = `${o.harness.instructions}

You are Claude, talking to a user in a chat window. The AIShop4U monitor widget is open beside the chat; the user acts there (selecting, entering billing details, approving) and tells you when they have. You cannot see or click the widget yourself.`;

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: o.opening }];
  const assistant: string[] = [];
  const userSaid: string[] = [o.opening];
  const usage = emptyUsage();
  let stopped: Trace["stopped"] = "turn_cap";
  const printed = captureConsole();

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      const response = await withRetry(() => client.messages.create({ model, max_tokens: MAX_TOKENS, system, tools, messages }));
      usage.requests += 1;
      usage.input_tokens += response.usage.input_tokens;
      usage.output_tokens += response.usage.output_tokens;
      usage.cache_read_input_tokens += response.usage.cache_read_input_tokens ?? 0;

      const said = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (said) assistant.push(said);
      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "refusal") {
        stopped = "refusal";
        break;
      }
      if (response.stop_reason === "max_tokens") {
        stopped = "max_tokens";
        break;
      }

      // Parallel tool_use blocks must come back as tool_result blocks in ONE user message.
      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (toolUses.length > 0) {
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const use of toolUses) {
          const call = await o.harness.modelCall(use.name, (use.input ?? {}) as Record<string, unknown>);
          results.push({ type: "tool_result", tool_use_id: use.id, content: call.text, is_error: call.isError });
        }
        messages.push({ role: "user", content: results });
        continue;
      }

      // The model handed the turn back: the scripted user acts in the widget and replies.
      const next = await o.user.respond({ said, harness: o.harness });
      if (next === null) {
        stopped = "user_ended";
        break;
      }
      userSaid.push(next);
      messages.push({ role: "user", content: next });
    }
  } finally {
    printed.restore();
  }

  const events = o.harness.events();
  return {
    scenario: o.scenario,
    model,
    ...(o.harness.sessionId() ? { session_id: o.harness.sessionId()! } : {}),
    calls: o.harness.calls,
    toolSeq: o.harness.calls.map((c) => c.name),
    assistant,
    user: userSaid,
    events,
    eventTypes: events.map((e) => e.type),
    stdout: printed.lines,
    usage,
    stopped,
  };
}

/**
 * One transient 429 or 529 would otherwise delete a whole scenario from the
 * report. The SDK retries twice on its own; this is the outer belt.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const delays = [2_000, 8_000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const status = (e as { status?: number }).status;
      const retryable = status === 429 || status === 408 || (typeof status === "number" && status >= 500) || e instanceof Anthropic.APIConnectionError;
      if (!retryable || attempt >= delays.length) throw e;
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}

/** Capture anything the server prints, so `secretsLeaked` can cover logs too. */
function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originals = { log: console.log, error: console.error, warn: console.warn };
  const tee = (original: (...a: unknown[]) => void) => (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    original(...args);
  };
  console.log = tee(originals.log);
  console.error = tee(originals.error);
  console.warn = tee(originals.warn);
  return {
    lines,
    restore: () => {
      console.log = originals.log;
      console.error = originals.error;
      console.warn = originals.warn;
    },
  };
}
