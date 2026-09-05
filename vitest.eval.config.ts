import { defineConfig } from "vitest/config";

/**
 * The agent behaviour eval suite (`npm run eval`). Kept out of `npm test`: it
 * spends money on the Anthropic API and takes minutes, while `npm test` must stay
 * a fast deterministic gate.
 *
 * Files run one at a time so the API usage stays serial and the report reads in
 * order. Scenario 0 needs no API key; the rest skip without one.
 */
export default defineConfig({
  test: {
    include: ["packages/evals/scenarios/*.eval.ts"],
    environment: "node",
    globalSetup: ["packages/evals/src/global-setup.ts"],
    setupFiles: ["packages/evals/src/setup-env.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
