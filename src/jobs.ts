import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentDriver, HistoryEntry, TurnHandle, TurnMode, TurnOutcome, TurnSummary } from "./drivers/types.js";
import type { AgentRecord, Registry } from "./registry.js";
import { readJson, writeJsonAtomic } from "./store.js";
import { isPidAlive, log, newId, nowIso, sleep } from "./util.js";

export type JobStatus = "running" | "succeeded" | "failed" | "cancelled" | "timeout";

const ACTIVE_WRITER = /already has an active writer|thread-store conflict/i;

export interface JobRecord {
  id: string;
  agent: string;
  driver: string;
  mode: TurnMode;
  threadId: string | null;
  message: string;
  images: string[];
  taskId?: string;
  status: JobStatus;
  pid?: number;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  note?: string;
  result?: TurnSummary;
  files: { events: string; stderr: string; lastMessage: string };
  createdBy: string;
}

export interface StartJobOptions {
  agentName: string;
  message: string;
  images?: string[];
  mode?: TurnMode;
  timeoutSec?: number;
  taskId?: string;
}

export interface JobHooks {
  onFinished?: (job: JobRecord) => Promise<void> | void;
}

const TERMINAL: JobStatus[] = ["succeeded", "failed", "cancelled", "timeout"];

/**
 * Poll a job file on disk until it reaches a terminal status. Process-independent: the running
 * job is owned by whichever server process spawned it (the one in Claude Code's MCP connection),
 * which writes the file; any other process, including a background `--wait`, just reads it.
 */
export async function waitForJobFile(dir: string, jobId: string, timeoutSec: number, pollMs = 2000): Promise<{ job: JobRecord | undefined; timedOut: boolean }> {
  const file = path.join(dir, `${jobId}.json`);
  const start = Date.now();
  for (;;) {
    const job = await readJson<JobRecord | undefined>(file, undefined);
    if (job && TERMINAL.includes(job.status)) return { job, timedOut: false };
    if (Date.now() - start > timeoutSec * 1000) return { job, timedOut: true };
    await sleep(pollMs);
  }
}

interface RunningJob {
  record: JobRecord;
  handle: TurnHandle;
  /** message as delivered (brief included when applicable) */
  fullMessage: string;
  /** resolves after finish() has persisted the final state (including the queue fallback) */
  finished: Promise<void>;
  timer?: NodeJS.Timeout;
  cancelled: boolean;
  timedOut: boolean;
}

/** Brief prepended to the first message of a fresh thread. Custom `agent.brief` replaces it. */
export function defaultBrief(agent: AgentRecord, orchestrator: string): string {
  const extraDirs = agent.addDirs.length ? ` (also writable: ${agent.addDirs.join(", ")})` : "";
  return [
    `[intercom] You are agent "${agent.name}", a worker on a multi-agent team. The orchestrator ("${orchestrator}", running in Claude Code) sends you tasks through this thread and reads only the final message of each of your turns.`,
    agent.role ? `Role: ${agent.role}` : "",
    `Workspace: ${agent.cwd}${extraDirs}. Stay inside it.`,
    `Coordination tools (MCP server "intercom", when available): task_list, task_get, task_update, task_create. Use actor "${agent.name}". When you finish a task set its status to "review" with a short result; if you cannot proceed set "blocked" and say why. Never mark tasks "done" yourself: the orchestrator does that after review.`,
    `End every turn with a concise report: what changed (paths), decisions made, open questions. If the task is ambiguous, ask in the final message instead of guessing. Do not wait for a human: the orchestrator is your counterpart.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export class JobManager {
  private readonly running = new Map<string, RunningJob>();
  private readonly byAgent = new Map<string, string>();

  constructor(
    private readonly dir: string,
    private readonly registry: Registry,
    private readonly drivers: Record<string, AgentDriver>,
    private readonly actor: string,
    private readonly hooks: JobHooks = {},
  ) {}

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private async save(record: JobRecord): Promise<void> {
    await writeJsonAtomic(this.file(record.id), record);
  }

  /** On startup: jobs left "running" by a previous server process are dead or orphaned. */
  async reconcile(): Promise<string[]> {
    const fixed: string[] = [];
    for (const job of await this.list(200)) {
      if (job.status !== "running") continue;
      if (job.pid && isPidAlive(job.pid)) continue;
      job.status = "failed";
      job.error = "orphaned: server restarted while the job was running";
      job.finishedAt = nowIso();
      await this.save(job);
      fixed.push(job.id);
    }
    return fixed;
  }

  runningFor(agentName: string): JobRecord | undefined {
    const id = this.byAgent.get(agentName);
    return id ? this.running.get(id)?.record : undefined;
  }

  /**
   * After a message went into a live session's inbox, watch the thread on disk until that
   * session has answered it, then hand the reply back like a normal turn.
   */
  private watchQueuedReply(driver: AgentDriver, threadId: string, fullMessage: string, queuedAtMs: number): TurnHandle {
    let aborted = false;
    let reply: string | null = null;
    const tailSnippet = fullMessage.trim().slice(-80);
    const summary = (): TurnSummary => ({
      finalMessage: reply,
      agentMessages: reply ? [reply] : [],
      commands: [],
      fileChanges: [],
      mcpCalls: [],
      webSearches: [],
      errors: [],
      itemCounts: reply ? { agent_message: 1 } : {},
    });
    const done = (async (): Promise<TurnOutcome> => {
      while (!aborted) {
        await sleep(3000);
        if (aborted) break;
        let entries: HistoryEntry[] = [];
        try {
          entries = await driver.threadHistory(threadId, 8);
        } catch {
          /* transient read error, try again */
        }
        const idx = entries.findIndex((e) => e.role === "user" && (!e.at || Date.parse(e.at) >= queuedAtMs - 15000) && e.text.trim().endsWith(tailSnippet));
        if (idx >= 0) {
          const r = entries.slice(idx + 1).find((e) => e.role === "assistant");
          if (r) {
            reply = r.text;
            break;
          }
        }
      }
      return {
        ...summary(),
        threadId,
        exitCode: aborted ? null : 0,
        signal: aborted ? "cancelled" : null,
        note: aborted ? undefined : "the thread was open in an interactive session: the message went through its inbox (codex queue), the session answered there, and the reply was read back from the thread",
      };
    })();
    return {
      pid: undefined,
      kill: async () => {
        aborted = true;
      },
      done,
      summary,
    };
  }

  /** Register a watcher job for a queued message. It does not block further sends to the agent. */
  private trackQueuedWatch(record: JobRecord, handle: TurnHandle, fullMessage: string, timeoutSec?: number): RunningJob {
    const run: RunningJob = { record, handle, fullMessage, finished: Promise.resolve(), cancelled: false, timedOut: false };
    run.finished = handle.done.then((outcome) => this.finish(run, outcome)).catch((e) => log(`job ${record.id} finish failed: ${String(e)}`));
    if (timeoutSec && timeoutSec > 0) {
      run.timer = setTimeout(() => {
        run.timedOut = true;
        void handle.kill();
      }, timeoutSec * 1000);
    }
    record.status = "running";
    record.note = "the thread is open in an interactive session, so the message was queued into that session (codex queue); waiting for the session to answer it there";
    this.running.set(record.id, run);
    this.byAgent.set(record.agent, record.id);
    return run;
  }

  async start(opts: StartJobOptions): Promise<JobRecord> {
    const agent = await this.registry.get(opts.agentName);
    if (!agent) throw new Error(`unknown agent "${opts.agentName}". Register it with agent_upsert first.`);
    const busy = this.runningFor(agent.name);
    if (busy) throw new Error(`agent "${agent.name}" is busy with job ${busy.id}; wait for it (job_wait) or cancel it (job_cancel). To drop a note into its inbox instead, use tui_send.`);
    const driver = this.drivers[agent.driver];
    if (!driver) throw new Error(`no driver "${agent.driver}"`);
    if (!opts.message.trim()) throw new Error("message is empty");

    let mode: TurnMode = opts.mode ?? "resume";
    if (!agent.threadId && mode !== "new") mode = "new";

    // Thread held by an interactive session right now?
    const live = mode === "resume" && agent.threadId ? await driver.isLive(agent.threadId) : undefined;
    if (live === true && !driver.hasInbox && !driver.supportsLiveTurns) {
      throw new Error(
        `agent "${agent.name}": conversation ${agent.threadId} is open in a live ${driver.name} session (TUI or IDE) and ${driver.name} has no message inbox, so sending now would write behind that session's back. Close it, or send with thread='new'.`,
      );
    }

    const id = newId("job");
    const files = {
      events: path.join(this.dir, `${id}.events.jsonl`),
      stderr: path.join(this.dir, `${id}.stderr.log`),
      lastMessage: path.join(this.dir, `${id}.last.md`),
    };
    // Brief once per thread: on a fresh thread, or the first time we talk to an attached one.
    const withBrief = mode === "new" || !agent.briefSent;
    const fullMessage = withBrief ? `${agent.brief ?? defaultBrief(agent, this.actor)}\n\n---\n\n${opts.message}` : opts.message;

    const record: JobRecord = {
      id,
      agent: agent.name,
      driver: agent.driver,
      mode,
      threadId: mode === "new" ? null : agent.threadId,
      message: opts.message,
      images: opts.images ?? [],
      taskId: opts.taskId,
      status: "running",
      startedAt: nowIso(),
      files,
      createdBy: this.actor,
    };

    if (live === true && driver.hasInbox) {
      // Known-live Codex TUI: skip the doomed exec attempt, queue into its inbox, watch for the answer.
      const threadId = agent.threadId as string;
      const q = await driver.queueMessage(threadId, fullMessage, record.images);
      if (!q.ok) {
        record.status = "failed";
        record.error = `thread is open in an interactive session and queueing failed: ${q.output}`;
        record.finishedAt = nowIso();
        await this.save(record);
        await this.registry.patch(agent.name, { lastJobId: id });
        return record;
      }
      const watch = this.trackQueuedWatch(record, this.watchQueuedReply(driver, threadId, fullMessage, Date.now()), fullMessage, opts.timeoutSec);
      await this.save(watch.record);
      await this.registry.patch(agent.name, { lastJobId: id, ...(!agent.briefSent ? { briefSent: true } : {}) });
      log(`job ${id} queued into live session ${threadId}, watching for the reply`);
      return record;
    }

    const handle = driver.startTurn({
      agent,
      message: fullMessage,
      images: record.images,
      mode,
      files,
      onThreadId: (threadId) => {
        record.threadId = threadId;
        void this.save(record);
        if (mode !== "resume") void this.registry.patch(agent.name, { threadId });
      },
    });
    record.pid = handle.pid;
    const run: RunningJob = { record, handle, fullMessage, finished: Promise.resolve(), cancelled: false, timedOut: false };
    run.finished = handle.done.then((outcome) => this.finish(run, outcome)).catch((e) => log(`job ${id} finish failed: ${String(e)}`));
    if (opts.timeoutSec && opts.timeoutSec > 0) {
      run.timer = setTimeout(() => {
        run.timedOut = true;
        void handle.kill();
      }, opts.timeoutSec * 1000);
    }
    this.running.set(id, run);
    this.byAgent.set(agent.name, id);
    await this.save(record);
    log(`job ${id} started for ${agent.name} (${mode}${record.threadId ? ` ${record.threadId}` : ""})`);
    return record;
  }

  private async finish(run: RunningJob, outcome: TurnOutcome): Promise<void> {
    const { record } = run;
    if (run.timer) clearTimeout(run.timer);
    run.timer = undefined;
    const { threadId, exitCode, signal, spawnError, note, ...summary } = outcome;
    record.result = summary;
    if (note) record.note = note;
    record.threadId = threadId ?? record.threadId;
    record.exitCode = exitCode;
    record.signal = signal;
    record.finishedAt = nowIso();
    record.durationMs = Date.parse(record.finishedAt) - Date.parse(record.startedAt);
    if (run.cancelled) record.status = "cancelled";
    else if (run.timedOut) record.status = "timeout";
    else if (spawnError) {
      record.status = "failed";
      record.error = spawnError;
    } else if (exitCode !== 0) {
      record.status = "failed";
      record.error = summary.errors[0] ?? (await this.stderrTail(record)) ?? `codex exited with code ${exitCode}`;
    } else if (summary.errors.length) {
      record.status = "failed";
      record.error = summary.errors.join("; ");
    } else record.status = "succeeded";

    // The thread is open in an interactive session (TUI): hand the message to its inbox instead,
    // then keep the job alive until that session has answered.
    if (record.status === "failed" && record.threadId && ACTIVE_WRITER.test(record.error ?? "") && !run.cancelled && !run.timedOut) {
      const driver = this.drivers[record.driver];
      const q = driver ? await driver.queueMessage(record.threadId, run.fullMessage, record.images) : { ok: false, output: "no driver" };
      if (q.ok && driver) {
        log(`job ${record.id}: thread busy, message queued into the live session, watching for the reply`);
        if (this.byAgent.get(record.agent) === record.id) this.byAgent.delete(record.agent);
        record.error = undefined;
        record.finishedAt = undefined;
        record.durationMs = undefined;
        record.exitCode = undefined;
        record.signal = undefined;
        record.result = undefined;
        const watch = this.trackQueuedWatch(record, this.watchQueuedReply(driver, record.threadId, run.fullMessage, Date.now()), run.fullMessage);
        await this.save(watch.record);
        return;
      }
      record.error = `${record.error}; queue fallback failed: ${q.output}`;
    }

    this.running.delete(record.id);
    if (this.byAgent.get(record.agent) === record.id) this.byAgent.delete(record.agent);
    await this.save(record);
    const agent = await this.registry.get(record.agent);
    await this.registry.patch(record.agent, {
      lastJobId: record.id,
      turns: (agent?.turns ?? 0) + 1,
      ...(record.threadId && record.mode !== "resume" ? { threadId: record.threadId } : {}),
      ...(record.status === "succeeded" && (record.mode === "new" || !agent?.briefSent) ? { briefSent: true } : {}),
    });
    log(`job ${record.id} ${record.status} in ${record.durationMs}ms`);
    try {
      await this.hooks.onFinished?.(record);
    } catch (e) {
      log("onFinished hook failed", String(e));
    }
  }

  private async stderrTail(record: JobRecord): Promise<string | undefined> {
    try {
      const text = (await fsp.readFile(record.files.stderr, "utf8")).trim();
      return text ? text.split("\n").slice(-5).join("\n") : undefined;
    } catch {
      return undefined;
    }
  }

  async get(id: string): Promise<JobRecord | undefined> {
    const live = this.running.get(id);
    if (live) return live.record;
    return readJson<JobRecord | undefined>(this.file(id), undefined);
  }

  progress(id: string): TurnSummary | undefined {
    return this.running.get(id)?.handle.summary();
  }

  /**
   * Wait for a job. Resolves early when it finishes; `onTick` fires every `tickMs` so the caller
   * can send MCP progress notifications (Claude Code aborts silent calls after ~5 minutes).
   */
  async wait(id: string, timeoutSec: number, onTick?: (elapsedMs: number, live?: TurnSummary) => void, tickMs = 15000): Promise<{ job: JobRecord; timedOut: boolean }> {
    const start = Date.now();
    for (;;) {
      const live = this.running.get(id);
      if (!live) {
        const job = await this.get(id);
        if (!job) throw new Error(`unknown job ${id}`);
        return { job, timedOut: false };
      }
      const remaining = timeoutSec * 1000 - (Date.now() - start);
      if (remaining <= 0) return { job: live.record, timedOut: true };
      const slice = Math.min(remaining, tickMs);
      const finished = await Promise.race([live.finished.then(() => true), sleep(slice).then(() => false)]);
      if (finished) {
        // A live-session fallback can replace this run with a follow-up watcher; keep waiting on it.
        const successor = this.running.get(id);
        if (successor && successor !== live) continue;
        const job = await this.get(id);
        if (!job) throw new Error(`unknown job ${id}`);
        return { job, timedOut: false };
      }
      onTick?.(Date.now() - start, live.handle.summary());
    }
  }

  async cancel(id: string): Promise<JobRecord | undefined> {
    const live = this.running.get(id);
    if (!live) return this.get(id);
    live.cancelled = true;
    await live.handle.kill();
    await Promise.race([live.finished, sleep(5000)]);
    return this.get(id);
  }

  async list(limit: number, agent?: string): Promise<JobRecord[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return [];
    }
    const ids = names
      .filter((n) => n.startsWith("job_") && n.endsWith(".json"))
      .map((n) => n.slice(0, -".json".length))
      .sort()
      .reverse();
    const out: JobRecord[] = [];
    for (const id of ids) {
      if (out.length >= limit) break;
      const job = await this.get(id);
      if (!job) continue;
      if (agent && job.agent !== agent) continue;
      out.push(job);
    }
    return out;
  }

  async events(id: string, last: number): Promise<unknown[]> {
    const job = await this.get(id);
    if (!job) throw new Error(`unknown job ${id}`);
    let text: string;
    try {
      text = await fsp.readFile(job.files.events, "utf8");
    } catch {
      return [];
    }
    const lines = text.split("\n").filter((l) => l.trim());
    return lines.slice(-last).map((l) => {
      try {
        return JSON.parse(l) as unknown;
      } catch {
        return { raw: l };
      }
    });
  }
}
