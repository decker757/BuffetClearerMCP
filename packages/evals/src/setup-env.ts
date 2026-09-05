import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Each vitest worker is its own process: load .env here too, not only in globalSetup.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..", ".env"), quiet: true });
