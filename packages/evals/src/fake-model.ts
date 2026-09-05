import type Anthropic from "@anthropic-ai/sdk";
import type { MessagesClient } from "./claude.js";
import type { Harness } from "./harness.js";

/**
 * A scripted stand-in for Claude, used by the harness self-test. It exists so the
 * loop, the scripted user and the scoring can be proven without an API key and
 * without spending anything — never to substitute for the model in a scenario.
 */

export type Turn = { text: string } | { tool: string; input: (h: Harness) => Record<string, unknown> };

export function scriptedModel(harness: Harness, script: Turn[]): MessagesClient {
  let i = 0;
  return {
    messages: {
      async create(): Promise<Anthropic.Message> {
        const turn = script[i++];
        if (!turn) return message([{ type: "text", text: "(script exhausted)" }], "end_turn");
        if ("text" in turn) return message([{ type: "text", text: turn.text }], "end_turn");
        return message([{ type: "tool_use", id: `tu_${i}`, name: turn.tool, input: turn.input(harness) }], "tool_use");
      },
    },
  };
}

function message(content: unknown[], stop_reason: string): Anthropic.Message {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "scripted",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}
