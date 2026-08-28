import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "./util.js";

export const VERSION = "0.1.0";

export type Role = "orchestrator" | "worker";

export interface IntercomConfig {
  version: string;
  /** Where agents.json, tasks.json and jobs/ live. Shared by every process of one project. */
  dataDir: string;
  dataDirSource: string;
  /** orchestrator = full tool set (Claude Code). worker = task board only (inside Codex/agy). */
  role: Role;
  /** Name used as author on tasks/notes: "claude", or the agent name for workers. */
  actor: string;
  /** Set when this server runs inside an agent spawned by intercom. */
  agentName?: string;
  codexHome: string;
  cwd: string;
}

const POINTER_FILE = path.join(os.homedir(), ".intercom", "last-data-dir");

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[++i];
    } else {
      out[a.slice(2)] = "true";
    }
  }
  return out;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolution order:
 *  1. --data-dir / INTERCOM_DIR
 *  2. nearest .intercom/ walking up from cwd (workers spawned inside the project find the board)
 *  3. ~/.intercom/last-data-dir pointer written by the last orchestrator (workers only)
 *  4. <cwd>/.intercom
 */
export function resolveDataDir(explicit: string | undefined, cwd: string, role: Role): { dir: string; source: string } {
  if (explicit) return { dir: path.resolve(explicit), source: "explicit" };
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, ".intercom");
    if (isDir(candidate)) return { dir: candidate, source: "walk-up" };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (role === "worker") {
    try {
      const p = fs.readFileSync(POINTER_FILE, "utf8").trim();
      if (p && isDir(p)) return { dir: p, source: "pointer" };
    } catch {
      /* no pointer */
    }
  }
  return { dir: path.join(path.resolve(cwd), ".intercom"), source: "cwd-default" };
}

export function loadConfig(argv: string[]): IntercomConfig {
  const args = parseArgs(argv);
  const roleRaw = args.role ?? process.env.INTERCOM_ROLE ?? "orchestrator";
  const role: Role = roleRaw === "worker" ? "worker" : "orchestrator";
  const agentName = args.agent ?? process.env.INTERCOM_AGENT;
  const actor = args.actor ?? process.env.INTERCOM_ACTOR ?? agentName ?? (role === "worker" ? "worker" : "claude");
  const cwd = process.cwd();
  const { dir, source } = resolveDataDir(args["data-dir"] ?? process.env.INTERCOM_DIR, cwd, role);
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

  fs.mkdirSync(path.join(dir, "jobs"), { recursive: true });
  if (role === "orchestrator") {
    try {
      fs.mkdirSync(path.dirname(POINTER_FILE), { recursive: true });
      fs.writeFileSync(POINTER_FILE, dir, "utf8");
    } catch (e) {
      log("could not write pointer file", String(e));
    }
  }

  return { version: VERSION, dataDir: dir, dataDirSource: source, role, actor, agentName, codexHome, cwd };
}
