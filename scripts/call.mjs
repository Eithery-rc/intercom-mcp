// Call one intercom tool from the shell, without Claude Code:
//   node scripts/call.mjs agents_list
//   node scripts/call.mjs agent_send '{"agent":"sprites","message":"status?","wait_seconds":120}'
// Env: INTERCOM_DIR (data dir, defaults to <cwd>/.intercom), INTERCOM_ROLE, INTERCOM_ACTOR.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [tool, rawArgs] = process.argv.slice(2);
if (!tool) {
  console.error("usage: node scripts/call.mjs <tool> [json-args]");
  process.exit(2);
}
const args = rawArgs ? JSON.parse(rawArgs) : {};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "index.js")],
  env: { ...process.env },
  stderr: "pipe",
});
transport.stderr?.on("data", (d) => process.stderr.write(`  [server] ${d}`));
const client = new Client({ name: "intercom-call", version: "0.0.0" });
await client.connect(transport);
const r = await client.callTool({ name: tool, arguments: args });
console.log(r.content?.map((c) => c.text ?? JSON.stringify(c)).join("\n"));
await client.close();
process.exit(r.isError ? 1 : 0);
