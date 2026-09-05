import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL, addUsage, emptyUsage, estimateCost, hasApiKey, type Trace, type Usage } from "./claude.js";

/**
 * Scenario results are written as JSON lines by the worker that ran them and
 * printed as one table by the global teardown, because vitest runs each file in
 * its own worker and module state is not shared.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPORT_FILE = process.env.EVAL_REPORT_FILE ?? path.join(HERE, "..", ".eval-report.jsonl");

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface Row {
  scenario: string;
  model: string;
  pass: boolean;
  checks: Check[];
  toolSeq: string[];
  keyEvents: string[];
  notes: string[];
  usage: Usage;
  runs?: number;
  /** the run hit a harness limit (turn cap, max_tokens): not an agent verdict */
  inconclusive?: boolean;
}

const INTERESTING = new Set([
  "session.started",
  "browse.refused",
  "browse.returned",
  "candidate.rejected",
  "candidate.selected",
  "billing.submitted",
  "quote.ready",
  "approval.refused",
  "approval.granted",
  "card.authorised",
  "session.funded",
  "payment.quoted",
  "payment.refused",
  "purchase.settled",
  "purchase.failed",
  "manifest.anchored",
  "card.captured",
  "card.released",
  "session.aborted",
]);

/** The event types worth showing, in order, deduplicated. */
export function keyEvents(types: string[]): string[] {
  const out: string[] = [];
  for (const t of types) if (INTERESTING.has(t) && out[out.length - 1] !== t) out.push(t);
  return out;
}

export function rowFrom(trace: Trace, checks: Check[], notes: string[] = [], runs?: number): Row {
  const inconclusive = trace.stopped === "turn_cap" || trace.stopped === "max_tokens";
  return {
    scenario: trace.scenario,
    model: trace.model,
    pass: checks.every((c) => c.pass),
    checks,
    toolSeq: trace.toolSeq,
    keyEvents: keyEvents(trace.eventTypes),
    notes: inconclusive ? [...notes, `run ended on a HARNESS limit (${trace.stopped}), not on the agent finishing: raise EVAL_MAX_TURNS before reading this as a defect`] : notes,
    usage: trace.usage,
    ...(runs ? { runs } : {}),
    ...(inconclusive ? { inconclusive } : {}),
  };
}

/**
 * A scenario that throws (a 429 that outlived the retries, a bug in a check)
 * would otherwise vanish from the report and leave "N/N passed" over a short
 * list. Wrap each scenario body in this.
 */
export async function recordingFailures<T>(scenario: string, model: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    // A scenario that scored itself and then threw on its own assertions has already
    // recorded the interesting row; a second one would double-count it as a failure.
    if (readRows().some((r) => r.scenario === scenario)) throw e;
    record({
      scenario,
      model,
      pass: false,
      checks: [{ name: "the scenario ran to completion", pass: false, detail: (e instanceof Error ? e.message : String(e)).slice(0, 300) }],
      toolSeq: [],
      keyEvents: [],
      notes: ["the run threw before it could be scored; see the vitest output above"],
      usage: emptyUsage(),
    });
    throw e;
  }
}

export function record(row: Row): void {
  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.appendFileSync(REPORT_FILE, `${JSON.stringify(row)}\n`);
}

export function resetReport(): void {
  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, "");
}

export function readRows(): Row[] {
  if (!fs.existsSync(REPORT_FILE)) return [];
  return fs
    .readFileSync(REPORT_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row);
}

export function printReport(): void {
  const rows = readRows().sort((a, b) => a.scenario.localeCompare(b.scenario));
  if (rows.length === 0) {
    console.log("\nNo eval scenarios recorded.\n");
    return;
  }
  const lines: string[] = ["", "AGENT BEHAVIOUR EVAL", "=".repeat(78)];
  let total = emptyUsage();
  let model = DEFAULT_MODEL;
  for (const r of rows) {
    // Rows with no real model (the guardrails, the scripted self-test) cost nothing.
    if (r.model !== "none" && r.model !== "scripted") {
      total = addUsage(total, r.usage);
      model = r.model;
    }
    lines.push("");
    const verdict = r.pass ? "PASS  " : r.inconclusive ? "INCONC" : "FAIL  ";
    lines.push(`${verdict}  ${r.scenario}${r.runs ? `  (${r.runs} runs)` : ""}`);
    for (const c of r.checks) lines.push(`      ${c.pass ? "+" : "x"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
    if (r.toolSeq.length > 0) lines.push(`      tools:  ${r.toolSeq.join(" > ")}`);
    if (r.keyEvents.length > 0) lines.push(`      events: ${r.keyEvents.join(" > ")}`);
    for (const n of r.notes) lines.push(`      note:   ${n}`);
  }
  const failed = rows.filter((r) => !r.pass).length;
  const inconclusive = rows.filter((r) => !r.pass && r.inconclusive).length;
  lines.push("");
  lines.push("=".repeat(78));
  lines.push(`${rows.length - failed}/${rows.length} scenarios passed${inconclusive > 0 ? `, ${inconclusive} inconclusive (harness limit, not an agent verdict)` : ""}.`);
  if (total.requests > 0) {
    lines.push(
      `API usage: ${total.requests} requests, ${total.input_tokens.toLocaleString()} input + ${total.output_tokens.toLocaleString()} output tokens ` +
        `(~$${estimateCost(total, model).toFixed(3)} at ${model} list prices).`,
    );
  } else if (!hasApiKey()) {
    lines.push("API usage: none (no ANTHROPIC_API_KEY; only the deterministic guardrail suite ran).");
  } else {
    lines.push("API usage: none — a key is set but no request succeeded. See the scenario rows above for the error.");
  }
  lines.push("");
  console.log(lines.join("\n"));
}
