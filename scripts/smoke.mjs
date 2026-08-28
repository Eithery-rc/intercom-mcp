// End-to-end smoke test: starts the server over stdio like Claude Code would and walks
// through the main flow. Steps marked "codex" spend real Codex turns; skip them with --no-codex.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const useCodex = !process.argv.includes("--no-codex");
const dataDir = process.env.SMOKE_DIR ?? path.join(os.tmpdir(), "intercom-smoke", ".intercom");
const agentCwd = path.dirname(dataDir);
fs.mkdirSync(agentCwd, { recursive: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "index.js")],
  env: { ...process.env, INTERCOM_DIR: dataDir, INTERCOM_ACTOR: "claude" },
  stderr: "pipe",
});
transport.stderr?.on("data", (d) => process.stderr.write(`  [server] ${d}`));

const client = new Client({ name: "intercom-smoke", version: "0.0.0" });
await client.connect(transport);

const text = (r) => r.content?.[0]?.text ?? JSON.stringify(r);
const call = async (name, args = {}) => {
  const started = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const body = text(r);
  console.log(`\n== ${name} ${JSON.stringify(args).slice(0, 120)} (${Date.now() - started}ms)${r.isError ? " ERROR" : ""}\n${body.slice(0, 1500)}`);
  if (r.isError) throw new Error(`${name} failed: ${body}`);
  return JSON.parse(body);
};

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

await call("info");
await call("agent_upsert", { name: "smoke", cwd: agentCwd, role: "smoke-test agent, replies briefly", sandbox: "read-only" });
const task = await call("task_create", { title: "Smoke task", assignee: "smoke", description: "Reply with OK" });
await call("task_list", {});

if (useCodex) {
  const first = await call("agent_send", { agent: "smoke", message: "Reply with exactly the word OK and nothing else.", wait_seconds: 240, task_id: task.id });
  if (first.status !== "succeeded") throw new Error(`first turn ${first.status}: ${first.error}`);
  await call("agents_list");
  await call("thread_history", { agent: "smoke", last: 4 });
  await call("tui_send", { agent: "smoke", message: "queued note: the magic word is PINEAPPLE" });
  const second = await call("agent_send", { agent: "smoke", message: "What is the magic word from the queued note? Answer with the word only.", wait_seconds: 240 });
  if (!/pineapple/i.test(second.final_message ?? "")) throw new Error(`queue drain not observed: ${second.final_message}`);
  await call("job_list", { limit: 5 });
  await call("job_events", { job_id: second.job_id, last: 5 });
  await call("task_get", { id: task.id });

  // Auto-wake: fire-and-forget, then run the wake_command as a separate process (as Claude would
  // via Bash run_in_background). The server stays alive on THIS client, so the job runs to completion
  // and the waiter exits with the result. The waiter's exit is what wakes a real session.
  const bg = await call("agent_send", { agent: "smoke", message: "Reply with exactly the word DONE and nothing else.", wait_seconds: 0 });
  if (!bg.wake_command) throw new Error("no wake_command returned for wait_seconds:0");
  console.log("wake_command:", bg.wake_command);
  const waiter = await new Promise((resolve) => {
    const child = spawn(bg.wake_command, { shell: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => process.stderr.write(`  [waiter] ${d}`));
    child.on("exit", (code) => resolve({ code, out: out.trim() }));
  });
  console.log(`waiter exit=${waiter.code} out=${waiter.out}`);
  const waited = JSON.parse(waiter.out);
  if (waiter.code !== 0 || waited.status !== "succeeded" || !/DONE/.test(waited.final_message ?? "")) {
    throw new Error(`auto-wake failed: exit ${waiter.code}, ${waiter.out}`);
  }

  // Reverse channel: Codex must see the same board through its own intercom MCP (worker role).
  const info = await call("info");
  if (info.drivers?.codex?.workerMcpConfigured) {
    // A standing inbox listener wakes when the worker posts (as Claude would run it via Bash
    // run_in_background). Arm it, then have Codex call notify from inside its turn.
    const inbox0 = await call("inbox", {});
    const listener = new Promise((resolve) => {
      const child = spawn(inbox0.listen_command, { shell: true });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => process.stderr.write(`  [listener] ${d}`));
      child.on("exit", (code) => resolve({ code, out: out.trim() }));
    });
    const ping = await call("agent_send", { agent: "smoke", message: 'Call the intercom MCP tool "notify" with text "smoke ping from codex" and kind "note". Then reply with exactly: pinged.', wait_seconds: 240 });
    if (!/pinged/i.test(ping.final_message ?? "")) throw new Error(`notify turn did not confirm: ${ping.final_message}`);
    const woke = await listener;
    console.log(`listener exit=${woke.code} out=${woke.out}`);
    const wokeData = JSON.parse(woke.out);
    if (woke.code !== 0 || !wokeData.entries?.some((e) => /smoke ping from codex/.test(e.text))) {
      throw new Error(`reverse channel failed: ${woke.out}`);
    }

    const third = await call("agent_send", {
      agent: "smoke",
      message: `Call the intercom MCP tool "info", then call "task_update" for task ${task.id} with status "review" and result "checked from codex". Reply with one line: role=<role> data_dir=<data_dir> actor=<actor> copied from the info result.`,
      wait_seconds: 240,
    });
    console.log("worker MCP check:", third.final_message);
    if (!/role=worker/.test(third.final_message ?? "")) throw new Error(`worker MCP not visible from Codex: ${third.final_message}`);
    const t = await call("task_get", { id: task.id });
    if (t.status !== "review") throw new Error(`task not updated by worker: ${t.status}`);
  } else {
    console.log("worker MCP not configured in codex config.toml, skipping reverse-channel check");
  }
}

await call("task_update", { id: task.id, status: "done", note: "smoke finished" });
await call("threads_recent", { limit: 3 });

if (process.argv.includes("--agy")) {
  await call("agent_upsert", { name: "agysmoke", driver: "agy", cwd: agentCwd, role: "smoke-test agent, replies briefly", sandbox: "workspace-write" });
  const a1 = await call("agent_send", { agent: "agysmoke", message: "Reply with exactly the word OK and nothing else.", wait_seconds: 240 });
  if (a1.status !== "succeeded" || !a1.thread_id) throw new Error(`agy first turn ${a1.status}: ${a1.error}`);
  const a2 = await call("agent_send", { agent: "agysmoke", message: "What word did you reply with before? Answer with that word followed by -2.", wait_seconds: 240 });
  if (!/OK-2/i.test(a2.final_message ?? "")) throw new Error(`agy resume lost context: ${a2.final_message}`);
  await call("thread_history", { agent: "agysmoke", last: 4 });
  await call("threads_recent", { driver: "agy", limit: 3 });
}
await client.close();
console.log("\nSMOKE OK");
