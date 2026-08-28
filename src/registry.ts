import path from "node:path";
import { readJson, updateJson } from "./store.js";
import { nowIso } from "./util.js";

export type DriverName = "codex" | "agy";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface AgentRecord {
  name: string;
  driver: DriverName;
  /** Working root the agent operates in. New threads start here. */
  cwd: string;
  /** Free text shown to the agent in its brief ("draws sprites, owns assets/sprites"). */
  role?: string;
  /** Full custom brief for new threads. Replaces the generated one. */
  brief?: string;
  model?: string;
  sandbox: SandboxMode;
  /** --dangerously-bypass-approvals-and-sandbox */
  fullAuto: boolean;
  addDirs: string[];
  /** Persistent conversation. null = next send starts a fresh thread. */
  threadId: string | null;
  /** Optional Codex session name, usable with `codex queue --thread <name>`. */
  threadName?: string;
  createdAt: string;
  updatedAt: string;
  lastJobId?: string;
  turns: number;
  /** The intercom brief was delivered on the current thread (new or attached). */
  briefSent: boolean;
}

interface RegistryFile {
  agents: AgentRecord[];
}

const EMPTY: RegistryFile = { agents: [] };

export interface AgentInput {
  name: string;
  driver?: DriverName;
  cwd?: string;
  role?: string | null;
  brief?: string | null;
  model?: string | null;
  sandbox?: SandboxMode;
  fullAuto?: boolean;
  addDirs?: string[];
  threadId?: string | null;
  threadName?: string | null;
}

export class Registry {
  constructor(private readonly file: string) {}

  async list(): Promise<AgentRecord[]> {
    return (await readJson<RegistryFile>(this.file, EMPTY)).agents;
  }

  async get(name: string): Promise<AgentRecord | undefined> {
    return (await this.list()).find((a) => a.name === name);
  }

  /** Create or update. `null` on an optional field clears it; `undefined` keeps the previous value. */
  async upsert(input: AgentInput): Promise<AgentRecord> {
    let out: AgentRecord | undefined;
    await updateJson<RegistryFile>(this.file, EMPTY, (cur) => {
      const idx = cur.agents.findIndex((a) => a.name === input.name);
      const prev = idx >= 0 ? cur.agents[idx] : undefined;
      const now = nowIso();
      const pick = <T>(v: T | null | undefined, prevV: T | undefined): T | undefined =>
        v === null ? undefined : (v ?? prevV);
      const threadId = input.threadId === undefined ? (prev?.threadId ?? null) : input.threadId;
      const threadChanged = threadId !== (prev?.threadId ?? null);
      const rec: AgentRecord = {
        name: input.name,
        driver: input.driver ?? prev?.driver ?? "codex",
        cwd: path.resolve(input.cwd ?? prev?.cwd ?? process.cwd()),
        role: pick(input.role, prev?.role),
        brief: pick(input.brief, prev?.brief),
        model: pick(input.model, prev?.model),
        sandbox: input.sandbox ?? prev?.sandbox ?? "workspace-write",
        fullAuto: input.fullAuto ?? prev?.fullAuto ?? false,
        addDirs: (input.addDirs ?? prev?.addDirs ?? []).map((d) => path.resolve(d)),
        threadId,
        threadName: pick(input.threadName, prev?.threadName),
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
        lastJobId: prev?.lastJobId,
        turns: prev?.turns ?? 0,
        briefSent: threadChanged ? false : (prev?.briefSent ?? false),
      };
      if (idx >= 0) cur.agents[idx] = rec;
      else cur.agents.push(rec);
      out = rec;
      return cur;
    });
    return out as AgentRecord;
  }

  async patch(
    name: string,
    fields: Partial<Pick<AgentRecord, "threadId" | "lastJobId" | "turns" | "threadName" | "briefSent">>,
  ): Promise<AgentRecord | undefined> {
    let out: AgentRecord | undefined;
    await updateJson<RegistryFile>(this.file, EMPTY, (cur) => {
      const a = cur.agents.find((x) => x.name === name);
      if (a) {
        Object.assign(a, fields, { updatedAt: nowIso() });
        out = a;
      }
      return cur;
    });
    return out;
  }

  async remove(name: string): Promise<boolean> {
    let removed = false;
    await updateJson<RegistryFile>(this.file, EMPTY, (cur) => {
      const before = cur.agents.length;
      cur.agents = cur.agents.filter((a) => a.name !== name);
      removed = cur.agents.length !== before;
      return cur;
    });
    return removed;
  }
}
