import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { errorMessage, log, tail, truncate } from "../util.js";
import { killTree, probeHeldFile, runCapture } from "./proc.js";
import type {
  AgentDriver,
  CommandSummary,
  HistoryEntry,
  ThreadInfo,
  TurnHandle,
  TurnOutcome,
  TurnRequest,
  TurnSummary,
} from "./types.js";

/**
 * Codex CLI driver.
 *
 * Headless turns: `codex exec --json` (new thread) / `codex exec resume <id> --json` (continue)
 * / `codex exec fork <id>`. Prompt goes through stdin, events come back as JSONL on stdout,
 * the final answer is also written by `-o` to a file so we never depend on parsing alone.
 *
 * Inbox: `codex queue --thread <id|name> --message ...`. Codex drains the queue at the start of the
 * thread's next turn, whether that turn happens in an interactive TUI or in our next exec resume.
 */

export interface CodexLaunch {
  command: string;
  args: string[];
  shell: boolean;
  source: string;
}

const TRIPLES: Record<string, string> = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
};

function findNativeBinary(pkgRoot: string): string | undefined {
  const key = `${process.platform}-${process.arch}`;
  const triple = TRIPLES[key];
  if (!triple) return undefined;
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  const candidates = [
    path.join(pkgRoot, "node_modules", "@openai", `codex-${key}`, "vendor", triple, "bin", exe),
    path.join(pkgRoot, "..", `codex-${key}`, "vendor", triple, "bin", exe),
    path.join(pkgRoot, "vendor", triple, "codex", exe),
  ];
  return candidates.find((c) => fs.existsSync(c));
}

/** Prefer the native binary (clean process tree, no cmd.exe quoting), fall back to the npm launcher. */
export function resolveCodexLaunch(): CodexLaunch {
  const override = process.env.INTERCOM_CODEX;
  if (override) {
    if (override.endsWith(".js")) return { command: process.execPath, args: [override], shell: false, source: override };
    return { command: override, args: [], shell: false, source: override };
  }
  const isWin = process.platform === "win32";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    if (isWin) {
      const exe = path.join(dir, "codex.exe");
      if (fs.existsSync(exe)) return { command: exe, args: [], shell: false, source: exe };
      const cmd = path.join(dir, "codex.cmd");
      if (fs.existsSync(cmd)) {
        const pkgRoot = path.join(dir, "node_modules", "@openai", "codex");
        const native = findNativeBinary(pkgRoot);
        if (native) return { command: native, args: [], shell: false, source: native };
        const js = path.join(pkgRoot, "bin", "codex.js");
        if (fs.existsSync(js)) return { command: process.execPath, args: [js], shell: false, source: js };
        return { command: cmd, args: [], shell: true, source: cmd };
      }
    } else {
      const bin = path.join(dir, "codex");
      try {
        fs.accessSync(bin, fs.constants.X_OK);
        return { command: bin, args: [], shell: false, source: bin };
      } catch {
        /* keep looking */
      }
    }
  }
  throw new Error("codex CLI not found on PATH. Install @openai/codex or set INTERCOM_CODEX to the binary.");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexEvent = { type?: string; [k: string]: any };

/** Accumulates `codex exec --json` events into a readable summary. */
class TurnState {
  threadId: string | null = null;
  usage: Record<string, unknown> | undefined;
  errors: string[] = [];
  private items = new Map<string, CodexEvent>();
  private order: string[] = [];

  ingest(evt: CodexEvent): void {
    switch (evt.type) {
      case "thread.started":
        if (typeof evt.thread_id === "string") this.threadId = evt.thread_id;
        break;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const it = evt.item as CodexEvent | undefined;
        if (!it || typeof it.id !== "string") break;
        if (!this.items.has(it.id)) this.order.push(it.id);
        this.items.set(it.id, it);
        break;
      }
      case "turn.completed":
        if (evt.usage && typeof evt.usage === "object") this.usage = evt.usage;
        break;
      case "turn.failed":
        this.errors.push(evt.error?.message ?? JSON.stringify(evt.error ?? evt));
        break;
      case "error":
        this.errors.push(evt.message ?? JSON.stringify(evt));
        break;
      default:
        break;
    }
  }

  lastAgentMessage(): string | null {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const it = this.items.get(this.order[i]);
      if (it?.type === "agent_message" && typeof it.text === "string") return it.text;
    }
    return null;
  }

  summary(): TurnSummary {
    const out: TurnSummary = {
      finalMessage: this.lastAgentMessage(),
      agentMessages: [],
      commands: [],
      fileChanges: [],
      mcpCalls: [],
      webSearches: [],
      errors: [...this.errors],
      itemCounts: {},
      usage: this.usage,
    };
    for (const id of this.order) {
      const it = this.items.get(id);
      if (!it) continue;
      const type = String(it.type ?? "unknown");
      out.itemCounts[type] = (out.itemCounts[type] ?? 0) + 1;
      switch (type) {
        case "agent_message":
          if (typeof it.text === "string") out.agentMessages.push(it.text);
          break;
        case "command_execution": {
          const c: CommandSummary = {
            command: String(it.command ?? ""),
            exitCode: typeof it.exit_code === "number" ? it.exit_code : null,
            status: it.status,
          };
          if (typeof it.aggregated_output === "string" && it.aggregated_output.length) {
            c.outputTail = tail(it.aggregated_output, 400);
          }
          out.commands.push(c);
          break;
        }
        case "file_change":
          for (const ch of Array.isArray(it.changes) ? it.changes : []) {
            out.fileChanges.push({ path: String(ch.path ?? ""), kind: String(ch.kind ?? "") });
          }
          break;
        case "mcp_tool_call":
          out.mcpCalls.push({ server: String(it.server ?? ""), tool: String(it.tool ?? ""), status: it.status });
          break;
        case "web_search":
          if (typeof it.query === "string") out.webSearches.push(it.query);
          break;
        case "error":
          if (typeof it.message === "string") out.errors.push(it.message);
          break;
        default:
          break;
      }
    }
    return out;
  }
}

async function readFinalFile(file: string): Promise<string | null> {
  try {
    const text = (await fsp.readFile(file, "utf8")).trim();
    return text.length ? text : null;
  } catch {
    return null;
  }
}

const SYSTEMISH = /^\s*<[a-z_]+[\s>]/i;
const ROLLOUT_RE = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Last `maxBytes` of a file as whole lines. `complete` when the whole file fit. */
async function readTailLines(file: string, maxBytes: number): Promise<{ lines: string[]; complete: boolean }> {
  const h = await fsp.open(file, "r");
  try {
    const { size } = await h.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let off = 0;
    while (off < buf.length) {
      const { bytesRead } = await h.read(buf, off, buf.length - off, start + off);
      if (!bytesRead) break;
      off += bytesRead;
    }
    const lines = buf.subarray(0, off).toString("utf8").split("\n");
    if (start > 0) lines.shift(); // first line is cut
    return { lines, complete: start === 0 };
  } finally {
    await h.close();
  }
}

function parseHistoryLines(lines: string[]): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: CodexEvent;
    try {
      row = JSON.parse(line) as CodexEvent;
    } catch {
      continue;
    }
    if (row.type !== "response_item") continue;
    const p = row.payload as CodexEvent | undefined;
    if (!p || p.type !== "message") continue;
    if (p.role !== "user" && p.role !== "assistant") continue;
    const content = Array.isArray(p.content) ? p.content : [];
    const body = content.map((c: CodexEvent) => (typeof c.text === "string" ? c.text : "")).join("");
    if (!body.trim()) continue;
    if (p.role === "user" && SYSTEMISH.test(body)) continue;
    entries.push({
      role: p.role,
      text: body,
      at: typeof row.timestamp === "string" ? row.timestamp : undefined,
      turnId: p.internal_chat_message_metadata_passthrough?.turn_id,
    });
  }
  return entries;
}

export interface CodexDriverOptions {
  dataDir: string;
  /** Name of the intercom entry in Codex's config.toml [mcp_servers.<name>] */
  workerMcpName?: string;
}

export class CodexDriver implements AgentDriver {
  readonly name = "codex";
  readonly hasInbox = true;
  private launch: CodexLaunch | undefined;
  private mcpEntryCache: { at: number; has: boolean } | undefined;

  constructor(
    private readonly codexHome: string,
    private readonly opts: CodexDriverOptions,
  ) {}

  private getLaunch(): CodexLaunch {
    if (!this.launch) this.launch = resolveCodexLaunch();
    return this.launch;
  }

  describe(): Record<string, unknown> {
    try {
      const l = this.getLaunch();
      return { binary: l.source, codexHome: this.codexHome, workerMcpConfigured: this.hasWorkerMcpEntry() };
    } catch (e) {
      return { error: errorMessage(e), codexHome: this.codexHome };
    }
  }

  /** True when Codex's config.toml declares [mcp_servers.<intercom>] so we can pass env to it. */
  private hasWorkerMcpEntry(): boolean {
    const now = Date.now();
    if (this.mcpEntryCache && now - this.mcpEntryCache.at < 15000) return this.mcpEntryCache.has;
    const name = this.opts.workerMcpName ?? "intercom";
    let has = false;
    try {
      const toml = fs.readFileSync(path.join(this.codexHome, "config.toml"), "utf8");
      has = new RegExp(`^\\s*\\[mcp_servers\\.${name}(\\.|\\])`, "m").test(toml);
    } catch {
      has = false;
    }
    this.mcpEntryCache = { at: now, has };
    return has;
  }

  private buildArgs(req: TurnRequest): string[] {
    const a = req.agent;
    const common: string[] = ["--json", "--skip-git-repo-check", "-o", req.files.lastMessage];
    if (a.model) common.push("-m", a.model);
    if (a.fullAuto) common.push("--dangerously-bypass-approvals-and-sandbox");
    for (const img of req.images) common.push("-i", img);
    if (this.hasWorkerMcpEntry()) {
      const name = this.opts.workerMcpName ?? "intercom";
      const env: Record<string, string> = {
        INTERCOM_DIR: this.opts.dataDir,
        INTERCOM_ROLE: "worker",
        INTERCOM_ACTOR: a.name,
        INTERCOM_AGENT: a.name,
      };
      // JSON string literals are valid TOML basic strings (backslashes escaped).
      for (const [k, v] of Object.entries(env)) common.push("-c", `mcp_servers.${name}.env.${k}=${JSON.stringify(v)}`);
      // exec runs with approval_policy=never: MCP tools that are not read-only fail with
      // "requires approval" unless the server's tools are pre-approved ("approve" mode).
      common.push("-c", `mcp_servers.${name}.default_tools_approval_mode="approve"`);
    }
    if (req.mode === "new" || !a.threadId) {
      const addDirs = a.addDirs.flatMap((d) => ["--add-dir", d]);
      return ["exec", ...common, "-C", a.cwd, "-s", a.sandbox, ...addDirs, "-"];
    }
    const sub = req.mode === "fork" ? "fork" : "resume";
    // `exec resume` has no -s; the equivalent config override works on every subcommand.
    return ["exec", sub, a.threadId, ...common, "-c", `sandbox_mode=${JSON.stringify(a.sandbox)}`, "-"];
  }

  startTurn(req: TurnRequest): TurnHandle {
    const state = new TurnState();
    let child: ChildProcess | undefined;
    let spawnError: string | undefined;

    const done = new Promise<TurnOutcome>((resolve) => {
      let launch: CodexLaunch;
      try {
        launch = this.getLaunch();
      } catch (e) {
        resolve({ ...state.summary(), threadId: null, exitCode: null, signal: null, spawnError: errorMessage(e) });
        return;
      }
      const args = [...launch.args, ...this.buildArgs(req)];
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
        child = spawn(launch.command, args, {
          cwd: req.agent.cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          shell: launch.shell,
        });
      } catch (e) {
        eventsOut.end();
        stderrOut.end();
        resolve({ ...state.summary(), threadId: null, exitCode: null, signal: null, spawnError: errorMessage(e) });
        return;
      }
      const proc = child;
      proc.on("error", (e) => {
        spawnError = errorMessage(e);
        stderrOut.write(`[intercom] spawn error: ${spawnError}\n`);
      });
      const rl = readline.createInterface({ input: proc.stdout as NodeJS.ReadableStream });
      rl.on("line", (line) => {
        eventsOut.write(`${line}\n`);
        let evt: CodexEvent;
        try {
          evt = JSON.parse(line) as CodexEvent;
        } catch {
          return;
        }
        state.ingest(evt);
        if (evt.type === "thread.started" && typeof evt.thread_id === "string") req.onThreadId(evt.thread_id);
      });
      proc.stderr?.on("data", (d: Buffer) => stderrOut.write(d));
      proc.stdin?.on("error", () => {
        /* codex may exit before reading stdin */
      });
      proc.stdin?.end(req.message.endsWith("\n") ? req.message : `${req.message}\n`);
      proc.on("close", (code, signal) => {
        rl.close();
        eventsOut.end();
        stderrOut.end(async () => {
          const finalMessage = (await readFinalFile(req.files.lastMessage)) ?? state.lastAgentMessage();
          resolve({
            ...state.summary(),
            finalMessage,
            threadId: state.threadId,
            exitCode: code,
            signal: signal ?? null,
            spawnError,
          });
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

  private async runCodex(args: string[], cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    let launch: CodexLaunch;
    try {
      launch = this.getLaunch();
    } catch (e) {
      return { code: null, stdout: "", stderr: errorMessage(e) };
    }
    return runCapture(launch.command, [...launch.args, ...args], { cwd, shell: launch.shell });
  }

  /**
   * Codex leaves thread-writer-locks/<id>.lock behind and does not hold it open, so the file only
   * tells us the thread has been in a TUI at some point. A held file (rare) is a definite yes;
   * a missing one is a definite no; anything else is unknown and the exec attempt decides.
   */
  isLive(threadId: string): boolean | undefined {
    const lock = path.join(this.codexHome, "thread-writer-locks", `${threadId}.lock`);
    const held = probeHeldFile(lock);
    if (held === true) return true;
    return fs.existsSync(lock) ? undefined : false;
  }

  async queueMessage(threadRef: string, message: string, images: string[]): Promise<{ ok: boolean; output: string }> {
    const args = ["queue", "--thread", threadRef, "--message", message, ...images.flatMap((i) => ["-i", i])];
    const r = await this.runCodex(args);
    return { ok: r.code === 0, output: `${r.stdout}${r.stderr}`.trim() };
  }

  private sessionsRoot(): string {
    return path.join(this.codexHome, "sessions");
  }

  private async listRolloutFiles(): Promise<string[]> {
    const root = this.sessionsRoot();
    let entries: string[];
    try {
      entries = await fsp.readdir(root, { recursive: true });
    } catch {
      return [];
    }
    return entries.filter((e) => ROLLOUT_RE.test(e)).map((e) => path.join(root, e));
  }

  /**
   * Rollout files grow without bound (a long-lived TUI thread can reach gigabytes), so only the
   * tail of each file is read, newest file first, until enough messages are collected.
   */
  async threadHistory(threadId: string, last: number): Promise<HistoryEntry[]> {
    const files = (await this.listRolloutFiles()).filter((f) => f.toLowerCase().endsWith(`${threadId.toLowerCase()}.jsonl`)).sort();
    const entries: HistoryEntry[] = [];
    for (let i = files.length - 1; i >= 0 && entries.length < last; i--) {
      let budget = 4 * 1024 * 1024;
      let fileEntries: HistoryEntry[] = [];
      for (;;) {
        const { lines, complete } = await readTailLines(files[i], budget);
        fileEntries = parseHistoryLines(lines);
        if (complete || fileEntries.length + entries.length >= last || budget >= 64 * 1024 * 1024) break;
        budget *= 4;
      }
      entries.unshift(...fileEntries);
    }
    return entries.slice(-last);
  }

  async recentThreads(limit: number, cwdFilter?: string): Promise<ThreadInfo[]> {
    const files = await this.listRolloutFiles();
    const stats = await Promise.all(
      files.map(async (f) => {
        try {
          const st = await fsp.stat(f);
          return { f, mtime: st.mtimeMs };
        } catch {
          return undefined;
        }
      }),
    );
    const sorted = stats
      .filter((s): s is { f: string; mtime: number } => !!s)
      .sort((a, b) => b.mtime - a.mtime);
    const wanted = cwdFilter ? path.resolve(cwdFilter).toLowerCase() : undefined;
    const out: ThreadInfo[] = [];
    for (const { f, mtime } of sorted) {
      if (out.length >= limit) break;
      const info = await this.readThreadHead(f, mtime);
      if (!info) continue;
      if (wanted && (info.cwd ?? "").toLowerCase() !== wanted) continue;
      out.push(info);
    }
    return out;
  }

  private async readThreadHead(file: string, mtime: number): Promise<ThreadInfo | undefined> {
    const m = ROLLOUT_RE.exec(file);
    if (!m) return undefined;
    let head = "";
    try {
      const h = await fsp.open(file, "r");
      try {
        const buf = Buffer.alloc(256 * 1024);
        const { bytesRead } = await h.read(buf, 0, buf.length, 0);
        head = buf.subarray(0, bytesRead).toString("utf8");
      } finally {
        await h.close();
      }
    } catch {
      return undefined;
    }
    const info: ThreadInfo = { threadId: m[1], updatedAt: new Date(mtime).toISOString(), file };
    for (const line of head.split("\n")) {
      if (!line.trim()) continue;
      let row: CodexEvent;
      try {
        row = JSON.parse(line) as CodexEvent;
      } catch {
        continue; // last line may be cut
      }
      if (row.type === "session_meta") {
        const p = row.payload ?? {};
        info.cwd = p.cwd;
        info.startedAt = p.timestamp;
        info.source = p.source;
        info.originator = p.originator;
        continue;
      }
      if (row.type === "response_item" && row.payload?.type === "message" && row.payload.role === "user") {
        const body = (Array.isArray(row.payload.content) ? row.payload.content : [])
          .map((c: CodexEvent) => (typeof c.text === "string" ? c.text : ""))
          .join("");
        if (body.trim() && !SYSTEMISH.test(body)) {
          info.firstMessage = truncate(body.trim().replace(/\s+/g, " "), 160);
          break;
        }
      }
    }
    return info;
  }
}
