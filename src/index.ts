#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION, loadConfig, parseArgs } from "./config.js";
import { AgyDriver } from "./drivers/agy.js";
import { CodexDriver } from "./drivers/codex.js";
import { JobManager, waitForJobFile } from "./jobs.js";
import { Registry } from "./registry.js";
import { buildServer } from "./server.js";
import { TaskBoard } from "./tasks.js";
import { log, truncate } from "./util.js";

const USAGE = `intercom-mcp ${VERSION}
MCP server (stdio) that drives Codex and Antigravity sessions from Claude Code.

  intercom-mcp [--data-dir DIR] [--role orchestrator|worker] [--actor NAME] [--agent NAME]
  intercom-mcp --doctor              print resolved configuration and exit
  intercom-mcp --wait JOB_ID         block until a job finishes, print the result, exit
                                     (run via Bash run_in_background to wake the session on completion)
  intercom-mcp --version

Env: INTERCOM_DIR, INTERCOM_ROLE, INTERCOM_ACTOR, INTERCOM_AGENT, INTERCOM_CODEX, INTERCOM_AGY, CODEX_HOME
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }

  const cfg = loadConfig(argv);

  // Blocking waiter, meant to run as a background task so the session wakes when the job finishes.
  const args = parseArgs(argv);
  if (args.wait) {
    const jobId = args.wait;
    const timeoutSec = Number(args.timeout ?? 3600);
    const { job, timedOut } = await waitForJobFile(path.join(cfg.dataDir, "jobs"), jobId, timeoutSec);
    if (!job) {
      process.stdout.write(`${JSON.stringify({ job_id: jobId, status: "unknown", error: "no such job file" })}\n`);
      process.exit(2);
    }
    process.stdout.write(
      `${JSON.stringify({
        job_id: job.id,
        agent: job.agent,
        status: timedOut ? "still_running" : job.status,
        final_message: job.result?.finalMessage ?? null,
        note: job.note,
        error: job.error,
        task_id: job.taskId,
      })}\n`,
    );
    process.exit(timedOut ? 3 : job.status === "succeeded" ? 0 : 1);
  }
  const registry = new Registry(path.join(cfg.dataDir, "agents.json"));
  const tasks = new TaskBoard(path.join(cfg.dataDir, "tasks.json"), path.join(cfg.dataDir, "TASKS.md"));
  const codex = new CodexDriver(cfg.codexHome, { dataDir: cfg.dataDir, workerMcpName: "intercom" });
  const agy = new AgyDriver({ dataDir: cfg.dataDir });
  const drivers = { codex, agy };
  const jobs = new JobManager(path.join(cfg.dataDir, "jobs"), registry, drivers, cfg.actor, {
    onFinished: async (job) => {
      if (!job.taskId) return;
      const t = await tasks.get(job.taskId);
      if (!t) return;
      const final = job.result?.finalMessage ? truncate(job.result.finalMessage.replace(/\s+/g, " "), 400) : "";
      await tasks.update(job.taskId, { note: `job ${job.id} ${job.status}${final ? `: ${final}` : ""}` }, job.agent);
    },
  });

  if (argv.includes("--doctor")) {
    const agents = await registry.list();
    process.stdout.write(
      `${JSON.stringify(
        {
          version: cfg.version,
          role: cfg.role,
          actor: cfg.actor,
          agent: cfg.agentName,
          data_dir: cfg.dataDir,
          data_dir_source: cfg.dataDirSource,
          cwd: cfg.cwd,
          codex: codex.describe(),
          agents: agents.map((a) => ({ name: a.name, cwd: a.cwd, thread_id: a.threadId })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const orphans = await jobs.reconcile();
  if (orphans.length) log(`marked orphaned jobs as failed: ${orphans.join(", ")}`);

  const entry = fileURLToPath(import.meta.url);
  const server = buildServer({ cfg, registry, jobs, tasks, drivers, entry });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready v${cfg.version} role=${cfg.role} actor=${cfg.actor} data=${cfg.dataDir} (${cfg.dataDirSource})`);
}

main().catch((e) => {
  log("fatal", e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
