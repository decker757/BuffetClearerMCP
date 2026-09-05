/**
 * Package entry point. `main.ts` is the executable (Claude Desktop launches
 * `dist/main.js` by absolute path); this is what other workspaces import when
 * they need to build a server against their own Deps — today, `@aishop4u/evals`.
 */
export { createHttpApp } from "./http.js";
export { EventLog } from "./eventlog.js";
export { projectSnapshot } from "./projection.js";
export { INSTRUCTIONS, WIDGET_URI, createServer } from "./server.js";
export { SessionError, SessionManager, type Billing, type SessionRecord } from "./session.js";
export type { Deps } from "./deps.js";
