/**
 * Phase 1 spike A, automated half: connect a real MCP client to the HTTP server,
 * list tools, call start_session, read the ui:// resource, and assert the
 * MCP Apps wiring (tool _meta.ui.resourceUri -> resource with the app mime type).
 * The visual half (does Claude render it?) is checked by a human in Claude Desktop.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.MCP_URL ?? "http://localhost:3001/mcp");

function fail(msg: string): never {
  console.error("FAIL:", msg);
  process.exit(1);
}

const client = new Client({ name: "buffet-smoke", version: "0.0.1" });
await client.connect(new StreamableHTTPClientTransport(url));

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
console.log("tools:", names.join(", "));
const start = tools.find((t) => t.name === "start_session") ?? fail("start_session tool missing");
const meta = (start._meta ?? {}) as { ui?: { resourceUri?: string } };
const resourceUri = meta.ui?.resourceUri ?? fail("start_session has no _meta.ui.resourceUri");
console.log("ui resource:", resourceUri);

const result = await client.callTool({
  name: "start_session",
  arguments: { objective: "a laptop for uni under 1200", reason: "smoke test" },
});
const sc = (result.structuredContent ?? {}) as { session_id?: string };
if (!sc.session_id) fail("start_session returned no session_id");
console.log("start_session ->", sc);

const { resources } = await client.listResources();
console.log("resources:", resources.map((r) => `${r.uri} (${r.mimeType})`).join(", "));

const read = await client.readResource({ uri: resourceUri });
const first = read.contents[0] ?? fail("resource has no contents");
const html = "text" in first ? first.text : "";
if (!first.mimeType?.startsWith("text/html")) fail(`unexpected mime type ${first.mimeType}`);
if (!html.includes("Buffet monitor")) fail("resource html does not look like the widget");
console.log(`resource ok: ${first.mimeType}, ${html.length} chars`);

await client.close();
console.log("PASS");
