import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/src/**/*.test.ts", "tests/**/*.test.ts"],
    // The agent evals have their own config (`npm run eval`): they cost API money.
    exclude: ["**/node_modules/**", "**/dist/**", "packages/evals/**"],
    environment: "node",
    testTimeout: 20_000,
  },
});
