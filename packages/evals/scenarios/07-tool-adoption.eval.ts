import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MODEL, hasApiKey, runScenario } from "../src/claude.js";
import { WEB_SEARCH_DECOY, createHarness, type Harness } from "../src/harness.js";
import { record, recordingFailures, rowFrom, type Check } from "../src/report.js";
import { successfulCalls } from "../src/score.js";
import { scriptedUser } from "../src/user.js";

/**
 * Scenario 7 — the failure that actually happened on the night (REVIEW-LOG phase
 * 6): with web search available, "I want to buy a laptop" went to memory and the
 * web, and `start_session` was never called. A tool the model does not pick is a
 * feature that does not exist on stage.
 *
 * Every other scenario opens with "Use AIShop4U:", which is the demo-day
 * mitigation, not a test of adoption. This one opens bare and offers the web
 * search decoy.
 *
 * Read a PASS here as weaker evidence than a live run: the harness puts the
 * server's instructions in the system prompt, which is a stronger placement than
 * Claude Desktop's MCP instructions block. A FAIL is strong evidence.
 */

const SCENARIO = "7. Tool adoption (bare opening)";
let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe.skipIf(!hasApiKey())("7. tool adoption", () => {
  it("starts a session from a bare 'I want to buy a laptop', without being told the tool's name", async () => {
    await recordingFailures(SCENARIO, DEFAULT_MODEL, async () => {
      harness = await createHarness({ decoyTools: [WEB_SEARCH_DECOY] });
      const trace = await runScenario({
        scenario: SCENARIO,
        harness,
        opening: "I want to buy a laptop.",
        user: scriptedUser({ range: { min: "300", max: "1300" }, stopAfter: "propose", maxNudges: 2 }),
      });

      const webReaches = trace.calls.filter((c) => c.refusedByHost === "decoy_tool");
      const checks: Check[] = [
        { name: "called start_session without being told the tool's name", pass: successfulCalls(trace, "start_session").length > 0, detail: trace.toolSeq[0] ?? "no tool call at all" },
        { name: "did not go to the web instead", pass: webReaches.length === 0, detail: `${webReaches.length} web_search attempt(s)` },
        { name: "went on to browse our inventory", pass: successfulCalls(trace, "browse").length > 0 },
      ];

      record(rowFrom(trace, checks, ["the instructions sit in the system prompt here, a stronger placement than the host's; a pass is weaker evidence than a live run"]));
      for (const c of checks) expect(c.pass, `${c.name}${c.detail ? ` — ${c.detail}` : ""}`).toBe(true);
    });
  }, 300_000);
});
