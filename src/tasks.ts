import fsp from "node:fs/promises";
import { readJson, updateJson } from "./store.js";
import { nowIso, truncate } from "./util.js";

/**
 * Shared task board: the structured replacement for agent_exchange.md.
 * Every MCP process (orchestrator and workers) reads and writes the same tasks.json;
 * TASKS.md is a rendered view for humans.
 */

export type TaskStatus = "todo" | "in_progress" | "review" | "done" | "blocked" | "cancelled";
export type TaskPriority = "low" | "normal" | "high";

export interface TaskNote {
  at: string;
  by: string;
  text: string;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  assignee: string;
  status: TaskStatus;
  priority: TaskPriority;
  tags: string[];
  parent?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  notes: TaskNote[];
  result?: string;
  jobIds: string[];
}

interface BoardFile {
  nextId: number;
  tasks: Task[];
}

const EMPTY: BoardFile = { nextId: 1, tasks: [] };
const CLOSED: TaskStatus[] = ["done", "cancelled"];
const ORDER: TaskStatus[] = ["in_progress", "review", "blocked", "todo", "done", "cancelled"];

export interface TaskCreateInput {
  title: string;
  assignee: string;
  description?: string;
  priority?: TaskPriority;
  tags?: string[];
  parent?: string;
}

export interface TaskUpdateInput {
  status?: TaskStatus;
  note?: string;
  result?: string;
  assignee?: string;
  title?: string;
  description?: string;
  priority?: TaskPriority;
  addJobId?: string;
}

export interface TaskFilter {
  status?: TaskStatus;
  assignee?: string;
  includeClosed?: boolean;
}

export class TaskBoard {
  constructor(
    private readonly file: string,
    private readonly mdFile: string,
  ) {}

  async list(filter: TaskFilter = {}): Promise<Task[]> {
    const board = await readJson<BoardFile>(this.file, EMPTY);
    return board.tasks
      .filter((t) => (filter.status ? t.status === filter.status : filter.includeClosed || !CLOSED.includes(t.status)))
      .filter((t) => (filter.assignee ? t.assignee === filter.assignee : true))
      .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<Task | undefined> {
    const board = await readJson<BoardFile>(this.file, EMPTY);
    return board.tasks.find((t) => t.id === id);
  }

  async create(input: TaskCreateInput, by: string): Promise<Task> {
    let created: Task | undefined;
    const board = await updateJson<BoardFile>(this.file, EMPTY, (cur) => {
      const now = nowIso();
      const task: Task = {
        id: `T-${String(cur.nextId).padStart(3, "0")}`,
        title: input.title.trim(),
        description: input.description?.trim() || undefined,
        assignee: input.assignee,
        status: "todo",
        priority: input.priority ?? "normal",
        tags: input.tags ?? [],
        parent: input.parent,
        createdBy: by,
        createdAt: now,
        updatedAt: now,
        notes: [],
        jobIds: [],
      };
      cur.nextId += 1;
      cur.tasks.push(task);
      created = task;
      return cur;
    });
    await this.render(board);
    return created as Task;
  }

  async update(id: string, patch: TaskUpdateInput, by: string): Promise<Task> {
    let updated: Task | undefined;
    const board = await updateJson<BoardFile>(this.file, EMPTY, (cur) => {
      const t = cur.tasks.find((x) => x.id === id);
      if (!t) throw new Error(`unknown task ${id}`);
      const now = nowIso();
      const changes: string[] = [];
      if (patch.status && patch.status !== t.status) {
        changes.push(`${t.status} -> ${patch.status}`);
        t.status = patch.status;
      }
      if (patch.assignee && patch.assignee !== t.assignee) {
        changes.push(`assignee -> ${patch.assignee}`);
        t.assignee = patch.assignee;
      }
      if (patch.title) t.title = patch.title.trim();
      if (patch.description !== undefined) t.description = patch.description.trim() || undefined;
      if (patch.priority) t.priority = patch.priority;
      if (patch.result !== undefined) t.result = patch.result.trim() || undefined;
      if (patch.addJobId && !t.jobIds.includes(patch.addJobId)) t.jobIds.push(patch.addJobId);
      const noteText = [patch.note?.trim(), changes.length ? `(${changes.join(", ")})` : ""].filter(Boolean).join(" ");
      if (noteText) t.notes.push({ at: now, by, text: noteText });
      t.updatedAt = now;
      updated = t;
      return cur;
    });
    await this.render(board);
    return updated as Task;
  }

  private async render(board: BoardFile): Promise<void> {
    const lines: string[] = [
      "# Intercom task board",
      "",
      `_Rendered ${nowIso()} from tasks.json. Edit through the intercom MCP tools, not by hand._`,
      "",
    ];
    for (const status of ORDER) {
      const tasks = board.tasks.filter((t) => t.status === status);
      if (!tasks.length) continue;
      const shown = status === "done" || status === "cancelled" ? tasks.slice(-20) : tasks;
      lines.push(`## ${status} (${tasks.length})`, "");
      for (const t of shown) {
        const prio = t.priority === "normal" ? "" : ` [${t.priority}]`;
        lines.push(`- **${t.id}** \`${t.assignee}\`${prio} ${t.title}`);
        if (t.description) lines.push(`  - ${truncate(t.description.replace(/\s+/g, " "), 200)}`);
        if (t.result) lines.push(`  - result: ${truncate(t.result.replace(/\s+/g, " "), 300)}`);
        const lastNote = t.notes[t.notes.length - 1];
        if (lastNote) lines.push(`  - ${lastNote.at.slice(0, 16).replace("T", " ")} ${lastNote.by}: ${truncate(lastNote.text.replace(/\s+/g, " "), 200)}`);
      }
      lines.push("");
    }
    try {
      await fsp.writeFile(this.mdFile, `${lines.join("\n")}\n`, "utf8");
    } catch {
      /* the markdown view is best-effort */
    }
  }
}
