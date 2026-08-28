import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { errorMessage, log, tail, truncate } from "../util.js";
import { killTree, probeHeldFile, runCapture } from "./proc.js";
import type { AgentDriver, HistoryEntry, ThreadInfo, TurnHandle, TurnOutcome, TurnRequest, TurnSummary } from "./types.js";

/**
 * Antigravity CLI (`agy`) driver.
 *
 * Turns run as `agy --input-format stream-json --output-format stream-json [--conversation <id>]`:
 * one NDJSON user message on stdin, NDJSON events on stdout (init / step_update / result).
 * Conversations persist under ~/.gemini/antigravity-cli/conversations/<id>.db (sqlite, protobuf
 * payloads); the summaries db lists them. There is no inbox equivalent of `codex queue`.
 */

export interface AgyLaunch {
  command: string;
  shell: boolean;
  source: string;
}

export function resolveAgyLaunch(): AgyLaunch {
  const override = process.env.INTERCOM_AGY;
  if (override) return { command: override, shell: false, source: override };
  const isWin = process.platform === "win32";
  const names = isWin ? ["agy.exe", "agy.cmd", "agy.bat"] : ["agy"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return { command: p, shell: n.endsWith(".cmd") || n.endsWith(".bat"), source: p };
    }
  }
  throw new Error("agy CLI not found on PATH. Install the Antigravity CLI or set INTERCOM_AGY to the binary.");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgyEvent = { event?: string; [k: string]: any };

const FILE_TOOL = /write|replace|edit|create|delete|remove|move|rename|patch/i;
const FILE_PARAM_KEYS = ["TargetFile", "AbsolutePath", "FilePath", "Path", "path", "file", "File"];

class AgyTurnState {
  conversationId: string | null = null;
  usage: Record<string, unknown> | undefined;
  errors: string[] = [];
  finalResponse: string | null = null;
  status: string | null = null;
  private responses = new Map<number, string>();
  private responseOrder: number[] = [];
  private tools: { name: string; params: Record<string, unknown>; output?: string; state?: string }[] = [];
  private toolsByStep = new Map<number, number>();

  ingest(evt: AgyEvent): void {
    switch (evt.event) {
      case "init":
        if (typeof evt.conversation_id === "string") this.conversationId = evt.conversation_id;
        break;
      case "step_update": {
        const su = evt.step_update ?? {};
        const idx = typeof su.step_index === "number" ? su.step_index : -1;
        if (su.step_type === "agent_response") {
          if (typeof su.text_delta === "string") {
            if (!this.responses.has(idx)) this.responseOrder.push(idx);
            this.responses.set(idx, (this.responses.get(idx) ?? "") + su.text_delta);
          }
          if (su.usage && typeof su.usage === "object") this.usage = su.usage;
        } else if (su.step_type === "tool") {
          const info = su.tool_info ?? {};
          const name = String(su.tool_name ?? info.name ?? "tool");
          const rec = { name, params: (info.parameters ?? {}) as Record<string, unknown>, output: typeof info.output === "string" ? info.output : undefined, state: su.state };
          const existing = this.toolsByStep.get(idx);
          if (existing !== undefined) this.tools[existing] = rec;
          else {
            this.toolsByStep.set(idx, this.tools.length);
            this.tools.push(rec);
          }
        } else if (su.step_type === "error" || su.error) {
          this.errors.push(String(su.error?.message ?? su.error ?? "step error"));
        }
        break;
      }
      case "result": {
        const r = evt.result ?? {};
        if (typeof r.response === "string") this.finalResponse = r.response.trim();
        if (typeof r.status === "string") this.status = r.status;
        if (r.usage && typeof r.usage === "object") this.usage = r.usage;
        if (r.status && r.status !== "SUCCESS") this.errors.push(`agy result status ${r.status}${r.error ? `: ${r.error}` : ""}`);
        break;
      }
      case "error":
        this.errors.push(String(evt.message ?? evt.error ?? JSON.stringify(evt)));
        break;
      default:
        break;
    }
  }

  lastAgentMessage(): string | null {
    if (this.finalResponse) return this.finalResponse;
    const last = this.responseOrder.at(-1);
    return last === undefined ? null : (this.responses.get(last)?.trim() ?? null);
  }

  summary(): TurnSummary {
    const out: TurnSummary = {
      finalMessage: this.lastAgentMessage(),
      agentMessages: this.responseOrder.map((i) => this.responses.get(i) ?? "").filter((t) => t.trim()),
      commands: [],
      fileChanges: [],
      mcpCalls: [],
      webSearches: [],
      errors: [...this.errors],
      itemCounts: {},
      usage: this.usage,
    };
    if (out.agentMessages.length) out.itemCounts.agent_message = out.agentMessages.length;
    for (const t of this.tools) {
      out.itemCounts[t.name] = (out.itemCounts[t.name] ?? 0) + 1;
      const p = t.params;
      if (t.name === "run_command" || typeof p.CommandLine === "string") {
        out.commands.push({ command: String(p.CommandLine ?? p.command ?? ""), exitCode: null, status: t.state, outputTail: t.output ? tail(t.output, 400) : undefined });
        continue;
      }
      if (/^mcp[_:.-]/i.test(t.name)) {
        const parts = t.name.replace(/^mcp[_:.-]/i, "").split(/[_:.-]/);
        out.mcpCalls.push({ server: parts[0] ?? "", tool: parts.slice(1).join("_") || t.name, status: t.state });
        continue;
      }
      if (/search/i.test(t.name) && typeof p.query === "string") {
        out.webSearches.push(p.query);
        continue;
      }
      if (FILE_TOOL.test(t.name)) {
        const key = FILE_PARAM_KEYS.find((k) => typeof p[k] === "string");
        out.fileChanges.push({ path: key ? String(p[key]) : "", kind: t.name });
      }
    }
    return out;
  }
}

export interface AgyDriverOptions {
  dataDir: string;
  /** ~/.gemini/antigravity-cli by default */
  home?: string;
}

interface SummaryRow {
  conversation_id: string;
  title: string;
  preview: string;
  step_count: number;
  last_modified_time: string;
  workspace_uris: string;
  source: string;
}

export class AgyDriver implements AgentDriver {
  readonly name = "agy";
  readonly hasInbox = false;
  private launch: AgyLaunch | undefined;
  private readonly home: string;

  constructor(private readonly opts: AgyDriverOptions) {
    this.home = opts.home ?? process.env.INTERCOM_AGY_HOME ?? path.join(os.homedir(), ".gemini", "antigravity-cli");
  }

  private getLaunch(): AgyLaunch {
    if (!this.launch) this.launch = resolveAgyLaunch();
    return this.launch;
  }

  describe(): Record<string, unknown> {
    try {
      const l = this.getLaunch();
      return { binary: l.source, home: this.home, inbox: false, fork: false };
    } catch (e) {
      return { error: errorMessage(e), home: this.home };
    }
  }

  private buildArgs(req: TurnRequest): string[] {
    const a = req.agent;
    const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--print-timeout", "24h"];
    if (a.threadId && req.mode === "resume") args.push("--conversation", a.threadId);
    if (a.model) args.push("--model", a.model);
    for (const d of a.addDirs) args.push("--add-dir", d);
    if (a.fullAuto || a.sandbox === "danger-full-access") args.push("--dangerously-skip-permissions");
    else if (a.sandbox === "read-only") args.push("--mode", "plan");
    else args.push("--mode", "accept-edits");
    return args;
  }

  startTurn(req: TurnRequest): TurnHandle {
    const state = new AgyTurnState();
    let child: ChildProcess | undefined;
    let spawnError: string | undefined;

    const done = new Promise<TurnOutcome>((resolve) => {
      const failEarly = (msg: string) => resolve({ ...state.summary(), threadId: null, exitCode: null, signal: null, spawnError: msg });
      if (req.mode === "fork") return failEarly("agy does not support forking a conversation; use thread='new' or 'resume'");
      let launch: AgyLaunch;
      try {
        launch = this.getLaunch();
      } catch (e) {
        return failEarly(errorMessage(e));
      }
      let message = req.message;
      if (req.images.length) message += `\n\nAttached files (open them with your tools): ${req.images.join(", ")}`;
      const args = this.buildArgs(req);
      const env = {
        ...process.env,
        NO_COLOR: "1",
        INTERCOM_DIR: this.opts.dataDir,
        INTERCOM_ROLE: "worker",
        INTERCOM_ACTOR: req.agent.name,
        INTERCOM_AGENT: req.agent.name,
      };
      const eventsOut = fs.createWriteStream(req.files.events, { flags: "a" });
      const stderrOut = fs.createWriteStream(req.files.stderr, { flags: "a" });
      log(`spawn ${launch.command} ${args.join(" ")} (cwd=${req.agent.cwd})`);
      try {
        child = spawn(launch.command, args, { cwd: req.agent.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: launch.shell });
      } catch (e) {
        eventsOut.end();
        stderrOut.end();
        return failEarly(errorMessage(e));
      }
      const proc = child;
      proc.on("error", (e) => {
        spawnError = errorMessage(e);
        stderrOut.write(`[intercom] spawn error: ${spawnError}\n`);
      });
      const rl = readline.createInterface({ input: proc.stdout as NodeJS.ReadableStream });
      rl.on("line", (line) => {
        eventsOut.write(`${line}\n`);
        let evt: AgyEvent;
        try {
          evt = JSON.parse(line) as AgyEvent;
        } catch {
          return;
        }
        state.ingest(evt);
        if (evt.event === "init" && typeof evt.conversation_id === "string") req.onThreadId(evt.conversation_id);
      });
      proc.stderr?.on("data", (d: Buffer) => stderrOut.write(d));
      proc.stdin?.on("error", () => {
        /* agy may exit before reading stdin */
      });
      proc.stdin?.end(`${JSON.stringify({ event: "user", message: { content: message } })}\n`);
      proc.on("close", (code, signal) => {
        rl.close();
        eventsOut.end();
        stderrOut.end(() => {
          // agy writes the final answer to the last message file only through us
          const finalMessage = state.lastAgentMessage();
          if (finalMessage) fs.writeFile(req.files.lastMessage, finalMessage, () => undefined);
          resolve({ ...state.summary(), finalMessage, threadId: state.conversationId, exitCode: code, signal: signal ?? null, spawnError });
        });
      });
    });

    return {
      get pid() {
        return child?.pid;
      },
      kill: () => killTree(child),
      done,
      summary: () => state.summary(),
    };
  }

  async queueMessage(): Promise<{ ok: boolean; output: string }> {
    return { ok: false, output: "agy has no message inbox; send the message with agent_send instead" };
  }

  /** An open agy session (TUI or IDE) holds presence/<id>.lock; stale locks stay behind but are not held. */
  isLive(threadId: string): boolean | undefined {
    const cli = probeHeldFile(path.join(this.home, "presence", `${threadId}.lock`));
    if (cli !== false) return cli;
    return probeHeldFile(path.join(path.dirname(this.home), "antigravity", "presence", `${threadId}.lock`));
  }

  private conversationsDir(): string {
    return path.join(this.home, "conversations");
  }

  /** CLI conversations live under antigravity-cli/, IDE ones under the sibling antigravity/ dir. */
  private conversationFile(threadId: string): string {
    const cli = path.join(this.conversationsDir(), `${threadId}.db`);
    if (fs.existsSync(cli)) return cli;
    const ide = path.join(path.dirname(this.home), "antigravity", "conversations", `${threadId}.db`);
    return fs.existsSync(ide) ? ide : cli;
  }

  private async openDb(file: string): Promise<{ prepare: (sql: string) => { all: (...p: unknown[]) => Record<string, unknown>[] }; close: () => void } | undefined> {
    try {
      await fsp.access(file);
      // Node >= 22.5 ships node:sqlite; imported lazily so the server still starts without it.
      const mod = (await import("node:sqlite")) as unknown as { DatabaseSync: new (f: string, o: { readOnly: boolean }) => { prepare: (sql: string) => { all: (...p: unknown[]) => Record<string, unknown>[] }; close: () => void } };
      return new mod.DatabaseSync(file, { readOnly: true });
    } catch (e) {
      log(`agy: cannot open ${file}: ${errorMessage(e)}`);
      return undefined;
    }
  }

  async threadHistory(threadId: string, last: number): Promise<HistoryEntry[]> {
    const db = await this.openDb(this.conversationFile(threadId));
    if (!db) return [];
    const entries: HistoryEntry[] = [];
    try {
      const rows = db.prepare("select idx, step_type, step_payload from steps order by idx").all() as { idx: number; step_type: number; step_payload: Uint8Array | null }[];
      for (const row of rows) {
        const role = STEP_ROLE[row.step_type];
        if (!role || !row.step_payload) continue;
        const buf = Buffer.from(row.step_payload);
        let text: string | undefined;
        if (role === "user") {
          text = readFieldText(buf, USER_TEXT_PATH) ?? bestText(buf);
        } else {
          text = readFieldText(buf, AGENT_TEXT_PATH);
          if (!text?.trim()) {
            // Tool-only step: fold it into a running "[tools: ...]" marker instead of one entry per call.
            const tool = readFieldText(buf, AGENT_TOOL_NAME_PATH);
            if (!tool) continue;
            const prev = entries.at(-1);
            if (prev?.role === "assistant" && prev.text.startsWith("[tools: ")) {
              prev.text = `${prev.text.slice(0, -1)}, ${tool}]`;
              prev.turnId = String(row.idx);
            } else entries.push({ role, text: `[tools: ${tool}]`, turnId: String(row.idx) });
            continue;
          }
        }
        if (text?.trim()) entries.push({ role, text: text.trim(), turnId: String(row.idx) });
      }
    } finally {
      db.close();
    }
    return entries.slice(-last);
  }

  async recentThreads(limit: number, cwdFilter?: string): Promise<ThreadInfo[]> {
    const db = await this.openDb(path.join(this.home, "conversation_summaries.db"));
    if (!db) return [];
    try {
      const rows = db
        .prepare("select conversation_id, title, preview, step_count, last_modified_time, workspace_uris, app_data_dir as source from conversation_summaries order by last_modified_time desc limit ?")
        .all(cwdFilter ? limit * 8 : limit) as unknown as SummaryRow[];
      const wanted = cwdFilter ? path.resolve(cwdFilter).toLowerCase() : undefined;
      const out: ThreadInfo[] = [];
      for (const r of rows) {
        const cwd = workspaceToPath(r.workspace_uris);
        if (wanted && (cwd ?? "").toLowerCase() !== wanted) continue;
        out.push({
          threadId: r.conversation_id,
          cwd,
          updatedAt: new Date(r.last_modified_time).toISOString(),
          source: r.source === "antigravity" ? "ide" : r.source === "antigravity-cli" ? "cli" : r.source || undefined,
          firstMessage: truncate((r.title || r.preview || "").replace(/\s+/g, " "), 160) || undefined,
          file: this.conversationFile(r.conversation_id),
        });
        if (out.length >= limit) break;
      }
      return out;
    } finally {
      db.close();
    }
  }

  async version(): Promise<string | undefined> {
    try {
      const l = this.getLaunch();
      const r = await runCapture(l.command, ["--version"], { shell: l.shell });
      return r.stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * step_type values observed in conversation dbs: 14 = user input, 15 = agent response,
 * 132 = tool execution, 101 = system message. Payload field paths (protobuf field numbers):
 * user text = 19.2; agent text = 20.1 (20.3 = thinking, 20.7.2 = tool call name).
 */
const STEP_ROLE: Record<number, "user" | "assistant"> = { 14: "user", 15: "assistant" };
const USER_TEXT_PATH = [19, 2];
const AGENT_TEXT_PATH = [20, 1];
const AGENT_TOOL_NAME_PATH = [20, 7, 2];

function workspaceToPath(uris: string): string | undefined {
  let first: string | undefined;
  try {
    const parsed = JSON.parse(uris || "[]") as unknown;
    if (Array.isArray(parsed)) first = parsed.find((x) => typeof x === "string" && x.trim()) as string | undefined;
    else if (typeof parsed === "string") first = parsed;
  } catch {
    first = (uris ?? "").split(/[,\n ]/).map((s) => s.trim()).find(Boolean);
  }
  if (!first) return undefined;
  if (first.startsWith("file://")) {
    try {
      return path.resolve(decodeURIComponent(new URL(first).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
    } catch {
      return first;
    }
  }
  return first;
}

// ---- minimal protobuf wire-format walker: pull out the longest readable string of a payload ----

function readVarint(buf: Buffer, pos: number): { value: bigint; next: number } | null {
  let result = 0n;
  let shift = 0n;
  let i = pos;
  for (;;) {
    if (i >= buf.length) return null;
    const b = buf[i++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
    if (shift > 63n) return null;
  }
  return { value: result, next: i };
}

function asText(bytes: Buffer): string | undefined {
  if (!bytes.length) return undefined;
  let s: string;
  try {
    s = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  let printable = 0;
  let total = 0;
  for (const ch of s) {
    total++;
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 32 || c === 10 || c === 13 || c === 9) printable++;
  }
  return total && printable / total > 0.95 ? s : undefined;
}

function collectStrings(buf: Buffer, depth: number, out: string[]): boolean {
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) return false;
    const wt = Number(tag.value & 7n);
    pos = tag.next;
    if (wt === 0) {
      const v = readVarint(buf, pos);
      if (!v) return false;
      pos = v.next;
    } else if (wt === 1) pos += 8;
    else if (wt === 5) pos += 4;
    else if (wt === 2) {
      const len = readVarint(buf, pos);
      if (!len) return false;
      pos = len.next;
      const n = Number(len.value);
      if (n < 0 || pos + n > buf.length) return false;
      const sub = buf.subarray(pos, pos + n);
      pos += n;
      const t = asText(sub);
      if (t !== undefined && t.length >= 2) out.push(t);
      if (depth < 6 && sub.length >= 2) {
        const inner: string[] = [];
        if (collectStrings(sub, depth + 1, inner)) out.push(...inner);
      }
    } else return false;
  }
  return true;
}

/** Bytes of the first occurrence of a nested length-delimited field, e.g. [20, 1]. */
function readFieldBytes(buf: Buffer, fieldPath: number[]): Buffer | undefined {
  if (!fieldPath.length) return buf;
  const [want, ...rest] = fieldPath;
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) return undefined;
    const field = Number(tag.value >> 3n);
    const wt = Number(tag.value & 7n);
    pos = tag.next;
    if (wt === 0) {
      const v = readVarint(buf, pos);
      if (!v) return undefined;
      pos = v.next;
    } else if (wt === 1) pos += 8;
    else if (wt === 5) pos += 4;
    else if (wt === 2) {
      const len = readVarint(buf, pos);
      if (!len) return undefined;
      pos = len.next;
      const n = Number(len.value);
      if (n < 0 || pos + n > buf.length) return undefined;
      if (field === want) return readFieldBytes(buf.subarray(pos, pos + n), rest);
      pos += n;
    } else return undefined;
  }
  return undefined;
}

export function readFieldText(buf: Buffer, fieldPath: number[]): string | undefined {
  const bytes = readFieldBytes(buf, fieldPath);
  return bytes ? asText(bytes) : undefined;
}

export function bestText(payload: Buffer): string | undefined {
  const strings: string[] = [];
  collectStrings(payload, 0, strings);
  return strings.sort((a, b) => b.length - a.length)[0]?.trim() || undefined;
}
