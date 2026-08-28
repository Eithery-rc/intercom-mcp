import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IntercomConfig } from "./config.js";
import type { AgentDriver, TurnSummary } from "./drivers/types.js";
import type { JobManager, JobRecord } from "./jobs.js";
import type { Registry } from "./registry.js";
import type { TaskBoard } from "./tasks.js";
import { errorMessage, fail, ok, truncate } from "./util.js";

export interface ServerDeps {
  cfg: IntercomConfig;
  registry: Registry;
  jobs: JobManager;
  tasks: TaskBoard;
  drivers: Record<string, AgentDriver>;
  /** Absolute path of this server's entry script, for building the background wake command. */
  entry: string;
}

/** Claude Code aborts an MCP call that stays silent for ~5 minutes; keep waits under that. */
const MAX_WAIT_SEC = 290;

const sandboxSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const taskStatusSchema = z.enum(["todo", "in_progress", "review", "done", "blocked", "cancelled"]);
const prioritySchema = z.enum(["low", "normal", "high"]);

function compactEvent(evt: unknown): unknown {
  if (!evt || typeof evt !== "object") return evt;
  const e = evt as Record<string, unknown>;
  const item = e.item as Record<string, unknown> | undefined;
  if (!item) return evt;
  const copy: Record<string, unknown> = { ...item };
  if (typeof copy.aggregated_output === "string" && copy.aggregated_output.length > 600) {
    copy.aggregated_output = `${copy.aggregated_output.slice(0, 300)} ... ${copy.aggregated_output.slice(-300)}`;
  }
  if (typeof copy.text === "string" && copy.text.length > 1500) copy.text = truncate(copy.text, 1500);
  return { ...e, item: copy };
}

function presentSummary(s: TurnSummary | undefined) {
  if (!s) return undefined;
  return {
    agent_messages: s.agentMessages.length,
    commands: s.commands.length,
    failed_commands: s.commands.filter((c) => c.exitCode !== null && c.exitCode !== 0).map((c) => ({ command: truncate(c.command, 200), exit_code: c.exitCode, output_tail: c.outputTail })),
    file_changes: s.fileChanges,
    mcp_calls: s.mcpCalls,
    web_searches: s.webSearches,
    errors: s.errors,
    item_counts: s.itemCounts,
    usage: s.usage,
  };
}

function presentJob(j: JobRecord, opts: { full?: boolean; progress?: TurnSummary } = {}) {
  return {
    job_id: j.id,
    agent: j.agent,
    status: j.status,
    mode: j.mode,
    thread_id: j.threadId,
    task_id: j.taskId,
    started_at: j.startedAt,
    finished_at: j.finishedAt,
    duration_ms: j.durationMs,
    message: opts.full ? j.message : truncate(j.message, 200),
    final_message: j.result?.finalMessage ?? null,
    summary: presentSummary(j.result),
    progress: opts.progress
      ? {
          items: opts.progress.itemCounts,
          last_agent_message: truncate(opts.progress.agentMessages.at(-1) ?? "", 400) || null,
          last_command: opts.progress.commands.at(-1)?.command ?? null,
        }
      : undefined,
    error: j.error,
    note: j.note,
    exit_code: j.exitCode,
    files: j.files,
  };
}

const INSTRUCTIONS = `intercom: drive other coding agents (Codex and Antigravity/agy) from this session.
Workflow: agent_upsert (once per agent: cwd and role) -> agent_send (a task; waits up to wait_seconds and returns the agent's final message) -> job_wait if still running -> review, then reply on the same thread with agent_send again. Threads persist on disk; the human can open the same conversation in the agent's TUI (\`codex resume <id>\` / \`agy --conversation <id>\`), and intercom keeps using it.
If a thread is open in a live interactive session, agent_send still works: for Codex the message goes through the session inbox, for agy through the session's local RPC, and the job returns the reply once the session answers there.
AUTO-WAKE (no human relay): for a long task, call agent_send with wait_seconds:0, then run the returned wake_command via Bash run_in_background. It blocks until the job finishes and its exit wakes this session with the result. Use this instead of asking the human to tell you when the agent is done. On a wait timeout, agent_send/job_wait return the same wake_command.
tui_send drops a message into a Codex thread's inbox without running it (no reply expected).
The task board (task_*) is shared with the agents: they see and update their own tasks from inside their sessions.`;

export function buildServer(deps: ServerDeps): McpServer {
  const { cfg, registry, jobs, tasks, drivers, entry } = deps;
  const server = new McpServer({ name: "intercom", version: cfg.version }, { instructions: cfg.role === "orchestrator" ? INSTRUCTIONS : undefined });
  const isOrchestrator = cfg.role === "orchestrator";

  // Forward slashes so the command runs in both git-bash and PowerShell on Windows (node accepts them).
  const slash = (s: string) => s.replace(/\\/g, "/");
  const q = (s: string) => (/[\s"]/.test(s) ? `"${slash(s).replace(/"/g, '\\"')}"` : slash(s));
  // Command Claude runs via Bash run_in_background: it blocks until the job finishes, and its exit
  // wakes the session. This is how a finished task notifies the session without a human relay.
  const wakeCommand = (jobId: string) => `${q(process.execPath)} ${q(entry)} --wait ${jobId} --data-dir ${q(cfg.dataDir)}`;

  server.registerTool(
    "info",
    {
      title: "Intercom status",
      description: "Server configuration: role, actor, data directory, codex binary, running jobs. Call this first if anything looks off.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const agents = await registry.list();
      return ok({
        version: cfg.version,
        role: cfg.role,
        actor: cfg.actor,
        agent: cfg.agentName,
        data_dir: cfg.dataDir,
        data_dir_source: cfg.dataDirSource,
        cwd: cfg.cwd,
        drivers: Object.fromEntries(Object.entries(drivers).map(([k, d]) => [k, d.describe()])),
        agents: agents.length,
        running_jobs: agents.map((a) => jobs.runningFor(a.name)?.id).filter(Boolean),
        pid: process.pid,
      });
    },
  );

  server.registerTool(
    "agents_list",
    {
      title: "List agents",
      description: "Registered agents with their persistent thread id, cwd, role and current/last job.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const agents = await registry.list();
      const out = [];
      for (const a of agents) {
        const running = jobs.runningFor(a.name);
        const last = a.lastJobId ? await jobs.get(a.lastJobId) : undefined;
        out.push({
          name: a.name,
          driver: a.driver,
          cwd: a.cwd,
          role: a.role,
          model: a.model,
          sandbox: a.sandbox,
          full_auto: a.fullAuto,
          add_dirs: a.addDirs,
          thread_id: a.threadId,
          thread_name: a.threadName,
          live_session: a.threadId ? ((await drivers[a.driver]?.isLive(a.threadId)) ?? "unknown") : false,
          turns: a.turns,
          running_job: running ? { job_id: running.id, since: running.startedAt } : null,
          last_job: last ? { job_id: last.id, status: last.status, finished_at: last.finishedAt, final_message: truncate(last.result?.finalMessage ?? "", 300) || null } : null,
        });
      }
      return ok(out);
    },
  );

  // ---- task board: available to everyone ----------------------------------------------------

  server.registerTool(
    "task_list",
    {
      title: "List tasks",
      description: "Open tasks on the shared board (todo/in_progress/review/blocked). Filter by status or assignee; include_closed adds done/cancelled.",
      inputSchema: {
        status: taskStatusSchema.optional(),
        assignee: z.string().optional().describe("agent name, or the orchestrator's actor name"),
        include_closed: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status, assignee, include_closed }) => {
      const list = await tasks.list({ status, assignee: assignee ?? (cfg.role === "worker" ? cfg.agentName : undefined), includeClosed: include_closed });
      return ok(
        list.map((t) => ({
          id: t.id,
          status: t.status,
          assignee: t.assignee,
          priority: t.priority,
          title: t.title,
          description: t.description ? truncate(t.description, 300) : undefined,
          result: t.result ? truncate(t.result, 300) : undefined,
          last_note: t.notes.at(-1),
          updated_at: t.updatedAt,
        })),
      );
    },
  );

  server.registerTool(
    "task_get",
    {
      title: "Get task",
      description: "Full task record including all notes and linked job ids.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const t = await tasks.get(id);
      return t ? ok(t) : fail(`unknown task ${id}`);
    },
  );

  server.registerTool(
    "task_create",
    {
      title: "Create task",
      description: "Create a task on the shared board. assignee is an agent name (or the orchestrator). Returns the new id (T-001...).",
      inputSchema: {
        title: z.string().min(1),
        assignee: z.string().min(1),
        description: z.string().optional().describe("acceptance criteria, file paths, references"),
        priority: prioritySchema.optional(),
        tags: z.array(z.string()).optional(),
        parent: z.string().optional().describe("parent task id"),
        actor: z.string().optional().describe("override the author name (defaults to this server's actor)"),
      },
    },
    async ({ actor, ...input }) => {
      try {
        return ok(await tasks.create(input, actor ?? cfg.actor));
      } catch (e) {
        return fail(errorMessage(e));
      }
    },
  );

  server.registerTool(
    "task_update",
    {
      title: "Update task",
      description: "Change status, add a note, record a result, reassign. Workers: set status=review with a result when finished, or blocked with a note. Orchestrator: set done after reviewing.",
      inputSchema: {
        id: z.string(),
        status: taskStatusSchema.optional(),
        note: z.string().optional().describe("progress note, question, or reason for blocked"),
        result: z.string().optional().describe("what was delivered: files, decisions"),
        assignee: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        priority: prioritySchema.optional(),
        actor: z.string().optional().describe("override the author name (defaults to this server's actor)"),
      },
    },
    async ({ id, actor, ...patch }) => {
      try {
        return ok(await tasks.update(id, patch, actor ?? cfg.actor));
      } catch (e) {
        return fail(errorMessage(e));
      }
    },
  );

  if (!isOrchestrator) return server;

  // ---- orchestrator only ----------------------------------------------------------------------

  server.registerTool(
    "agent_upsert",
    {
      title: "Register or update agent",
      description:
        "Create or update an agent. name is stable (e.g. 'sprites'); cwd is its working root; role is a one-line job description used in its brief. thread_id attaches an existing Codex conversation (see threads_recent); pass null to start fresh on the next send. Unspecified fields keep their previous values.",
      inputSchema: {
        name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i, "letters, digits, - and _"),
        driver: z.enum(["codex", "agy"]).optional().describe("codex (default) or agy (Antigravity CLI)"),
        cwd: z.string().optional().describe("absolute path; defaults to the server cwd for new agents"),
        role: z.string().nullable().optional(),
        brief: z.string().nullable().optional().describe("custom first-message brief; replaces the generated one"),
        model: z.string().nullable().optional(),
        sandbox: sandboxSchema.optional().describe("default workspace-write"),
        full_auto: z.boolean().optional().describe("bypass approvals and sandbox entirely (danger)"),
        add_dirs: z.array(z.string()).optional().describe("extra writable directories"),
        thread_id: z.string().nullable().optional(),
        thread_name: z.string().nullable().optional().describe("Codex session name, for tui_send by name"),
      },
    },
    async (a) => {
      try {
        const rec = await registry.upsert({
          name: a.name,
          driver: a.driver,
          cwd: a.cwd,
          role: a.role,
          brief: a.brief,
          model: a.model,
          sandbox: a.sandbox,
          fullAuto: a.full_auto,
          addDirs: a.add_dirs,
          threadId: a.thread_id,
          threadName: a.thread_name,
        });
        return ok(rec);
      } catch (e) {
        return fail(errorMessage(e));
      }
    },
  );

  server.registerTool(
    "agent_remove",
    {
      title: "Remove agent",
      description: "Remove an agent from the registry. The Codex thread stays on disk and can be re-attached later.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      if (jobs.runningFor(name)) return fail(`agent ${name} has a running job`);
      return (await registry.remove(name)) ? ok({ removed: name }) : fail(`unknown agent ${name}`);
    },
  );

  const waitFor = async (jobId: string, seconds: number, extra: { _meta?: { progressToken?: string | number }; sendNotification: (n: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void> }) => {
    const token = extra._meta?.progressToken;
    const { job, timedOut } = await jobs.wait(jobId, Math.min(seconds, MAX_WAIT_SEC), (elapsed, live) => {
      if (token === undefined) return;
      const items = live ? Object.values(live.itemCounts).reduce((a, b) => a + b, 0) : 0;
      void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: Math.round(elapsed / 1000), message: `job ${jobId}: ${items} items, last: ${truncate(live?.commands.at(-1)?.command ?? live?.agentMessages.at(-1) ?? "", 80)}` } }).catch(() => undefined);
    });
    const progress = timedOut ? jobs.progress(jobId) : undefined;
    let hint: string | undefined;
    if (timedOut) hint = `still running. To be woken automatically when it finishes instead of polling, run this via Bash run_in_background: ${wakeCommand(jobId)} . Or call job_wait again with job_id ${jobId}.`;
    else if (job.note) hint = job.note;
    return { ...presentJob(job, { progress }), still_running: timedOut, wake_command: timedOut ? wakeCommand(jobId) : undefined, hint };
  };

  server.registerTool(
    "agent_send",
    {
      title: "Send a message to an agent",
      description:
        "Send a task or reply to an agent on its persistent thread and (optionally) wait for the answer. Returns the agent's final message plus a summary of commands and file changes. thread='new' starts a fresh conversation, 'fork' branches the current one. Use task_id to link the run to a board task. If the thread is currently open in an interactive session (human in the TUI), the message is delivered into that session instead (Codex: inbox, agy: local RPC) and the job returns the session's reply once it answers there.",
      inputSchema: {
        agent: z.string(),
        message: z.string().min(1),
        images: z.array(z.string()).optional().describe("absolute paths of images to attach"),
        thread: z.enum(["resume", "new", "fork"]).optional().describe("default resume"),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SEC).optional().describe(`default 240; 0 returns immediately with a job_id`),
        timeout_seconds: z.number().int().min(10).optional().describe("kill the run after this long (default: no limit)"),
        task_id: z.string().optional(),
      },
    },
    async ({ agent, message, images, thread, wait_seconds, timeout_seconds, task_id }, extra) => {
      let job: JobRecord;
      try {
        job = await jobs.start({ agentName: agent, message, images, mode: thread, timeoutSec: timeout_seconds, taskId: task_id });
      } catch (e) {
        return fail(errorMessage(e));
      }
      if (task_id) {
        try {
          const t = await tasks.get(task_id);
          if (t) await tasks.update(task_id, { addJobId: job.id, note: `sent to ${agent} (job ${job.id})`, status: t.status === "todo" ? "in_progress" : undefined }, cfg.actor);
        } catch (e) {
          return ok({ ...presentJob(job), warning: `task link failed: ${errorMessage(e)}` });
        }
      }
      const wait = wait_seconds ?? 240;
      if (wait <= 0)
        return ok({
          ...presentJob(job),
          wake_command: wakeCommand(job.id),
          hint: `job started in the background. To be woken automatically when it finishes, run this via Bash run_in_background: ${wakeCommand(job.id)} . Or poll with job_wait job_id ${job.id}.`,
        });
      try {
        return ok(await waitFor(job.id, wait, extra));
      } catch (e) {
        return fail(errorMessage(e));
      }
    },
  );

  server.registerTool(
    "job_wait",
    {
      title: "Wait for a job",
      description: "Block until a running job finishes (or timeout_seconds pass) and return its result. Safe to call repeatedly.",
      inputSchema: {
        job_id: z.string(),
        timeout_seconds: z.number().int().min(1).max(MAX_WAIT_SEC).optional().describe("default 240"),
      },
    },
    async ({ job_id, timeout_seconds }, extra) => {
      try {
        return ok(await waitFor(job_id, timeout_seconds ?? 240, extra));
      } catch (e) {
        return fail(errorMessage(e));
      }
    },
  );

  server.registerTool(
    "job_list",
    {
      title: "List jobs",
      description: "Recent jobs (newest first) with status and final message. Pass job_id for one job in full.",
      inputSchema: {
        job_id: z.string().optional(),
        agent: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional().describe("default 10"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ job_id, agent, limit }) => {
      if (job_id) {
        const job = await jobs.get(job_id);
        return job ? ok(presentJob(job, { full: true, progress: jobs.progress(job_id) })) : fail(`unknown job ${job_id}`);
      }
      const list = await jobs.list(limit ?? 10, agent);
      return ok(list.map((j) => ({ ...presentJob(j, { progress: jobs.progress(j.id) }), summary: undefined, files: undefined, final_message: truncate(j.result?.finalMessage ?? "", 300) || null })));
    },
  );

  server.registerTool(
    "job_events",
    {
      title: "Job event log",
      description: "Raw Codex events of a job (commands run, outputs, file changes, messages). For debugging a run that went sideways.",
      inputSchema: {
        job_id: z.string(),
        last: z.number().int().min(1).max(500).optional().describe("default 40"),
        types: z.array(z.string()).optional().describe("only these item types, e.g. ['command_execution','error']"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ job_id, last, types }) => {
      try {
        let events = await jobs.events(job_id, types ? 5000 : (last ?? 40));
        if (types) {
          const set = new Set(types);
          events = events.filter((e) => {
            const item = (e as { item?: { type?: string } }).item;
            return item?.type ? set.has(item.type) : set.has(String((e as { type?: string }).type));
          }).slice(-(last ?? 40));
        }
        return ok(events.map(compactEvent));
      } catch (e) {
        return fail(errorMessage(e));
      }
    },
  );

  server.registerTool(
    "job_cancel",
    {
      title: "Cancel job",
      description: "Kill a running job's process tree. The thread stays usable.",
      inputSchema: { job_id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ job_id }) => {
      const job = await jobs.cancel(job_id);
      return job ? ok(presentJob(job)) : fail(`unknown job ${job_id}`);
    },
  );

  server.registerTool(
    "thread_history",
    {
      title: "Thread history",
      description: "User/assistant messages of an agent's thread as stored on disk by Codex or agy, including turns the human had in the TUI. Give agent, or thread_id (+ driver).",
      inputSchema: {
        agent: z.string().optional(),
        thread_id: z.string().optional(),
        driver: z.enum(["codex", "agy"]).optional().describe("with thread_id; default codex"),
        last: z.number().int().min(1).max(200).optional().describe("default 10 messages"),
        max_chars: z.number().int().min(100).max(20000).optional().describe("per message, default 2000"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ agent, thread_id, driver: driverName, last, max_chars }) => {
      let threadId = thread_id;
      let driver: AgentDriver | undefined = drivers[driverName ?? "codex"];
      if (!threadId && agent) {
        const a = await registry.get(agent);
        if (!a) return fail(`unknown agent ${agent}`);
        if (!a.threadId) return ok({ thread_id: null, messages: [], note: "agent has no thread yet" });
        threadId = a.threadId;
        driver = drivers[a.driver];
      }
      if (!threadId || !driver) return fail("give agent or thread_id");
      const messages = await driver.threadHistory(threadId, last ?? 10);
      return ok({ thread_id: threadId, messages: messages.map((m) => ({ ...m, text: truncate(m.text, max_chars ?? 2000) })) });
    },
  );

  server.registerTool(
    "threads_recent",
    {
      title: "Recent threads",
      description: "Most recently active conversations on this machine for a driver (codex: TUI, exec, intercom; agy: CLI and IDE), to attach one to an agent with agent_upsert thread_id. Filter by cwd to see one project.",
      inputSchema: {
        driver: z.enum(["codex", "agy"]).optional().describe("default codex"),
        limit: z.number().int().min(1).max(50).optional().describe("default 10"),
        cwd: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ driver: driverName, limit, cwd }) => {
      const driver = drivers[driverName ?? "codex"];
      if (!driver) return fail(`unknown driver ${driverName}`);
      const threads = await driver.recentThreads(limit ?? 10, cwd);
      const agents = await registry.list();
      return ok(threads.map((t) => ({ ...t, driver: driver.name, agent: agents.find((a) => a.threadId === t.threadId)?.name ?? null })));
    },
  );

  server.registerTool(
    "tui_send",
    {
      title: "Queue a message into a thread",
      description:
        "Drop a message into a Codex thread's inbox without running it (codex queue). The agent sees it at the start of its next turn: immediately if the human has the thread open in the TUI and it is idle, otherwise on the next agent_send. Good for notes, extra context, or nudging a live TUI session. Give agent, or thread (uuid or session name).",
      inputSchema: {
        agent: z.string().optional(),
        thread: z.string().optional().describe("thread uuid or Codex session name"),
        message: z.string().min(1),
        images: z.array(z.string()).optional(),
      },
    },
    async ({ agent, thread, message, images }) => {
      let ref = thread;
      if (!ref && agent) {
        const a = await registry.get(agent);
        if (!a) return fail(`unknown agent ${agent}`);
        if (a.driver !== "codex") return fail(`agent ${agent} uses ${a.driver}, which has no message inbox; use agent_send`);
        ref = a.threadId ?? a.threadName ?? undefined;
        if (!ref) return fail(`agent ${agent} has no thread yet; use agent_send first`);
      }
      if (!ref) return fail("give agent or thread");
      const r = await drivers.codex.queueMessage(ref, message, images ?? []);
      return r.ok ? ok({ queued: true, thread: ref, output: r.output }) : fail(`codex queue failed: ${r.output}`);
    },
  );

  return server;
}
