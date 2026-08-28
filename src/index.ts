#!/usr/bin/env node
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION, loadConfig } from "./config.js";
import { AgyDriver } from "./drivers/agy.js";
import { CodexDriver } from "./drivers/codex.js";
import { JobManager } from "./jobs.js";
import { Registry } from "./registry.js";
import { buildServer } from "./server.js";
import { TaskBoard } from "./tasks.js";
import { log, truncate } from "./util.js";

const USAGE = `intercom-mcp ${VERSION}
MCP server (stdio) that drives Codex sessions from Claude Code.

  intercom-mcp [--data-dir DIR] [--role orchestrator|worker] [--actor NAME] [--agent NAME]
  intercom-mcp --doctor      print resolved configuration and exit
  intercom-mcp --version

Env: INTERCOM_DIR, INTERCOM_ROLE, INTERCOM_ACTOR, INTERCOM_AGENT, INTERCOM_CODEX, CODEX_HOME
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

  const server = buildServer({ cfg, registry, jobs, tasks, drivers });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready v${cfg.version} role=${cfg.role} actor=${cfg.actor} data=${cfg.dataDir} (${cfg.dataDirSource})`);
}

main().catch((e) => {
  log("fatal", e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
