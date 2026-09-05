import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasApiKey, NO_KEY_MESSAGE } from "./claude.js";
import { printReport, resetReport } from "./report.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export async function setup(): Promise<void> {
  dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
  resetReport();
  if (!hasApiKey()) console.log(`\n${NO_KEY_MESSAGE}\n`);
}

export async function teardown(): Promise<void> {
  printReport();
}
