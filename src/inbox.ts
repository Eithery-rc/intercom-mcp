import { readJson, updateJson } from "./store.js";
import { nowIso, sleep } from "./util.js";

/**
 * Reverse channel: workers -> orchestrator. Any agent (Codex, agy) posts here through its
 * worker-role intercom server; the orchestrator (Claude Code) reads it, and a background
 * `--wait-inbox` process blocks on it so a post can wake an idle session.
 */

export type NotifyKind = "note" | "question" | "review" | "blocked" | "done" | "progress";

export interface InboxEntry {
  seq: number;
  id: string;
  from: string;
  kind: NotifyKind;
  text: string;
  taskId?: string;
  at: string;
}

interface InboxFile {
  nextSeq: number;
  entries: InboxEntry[];
}

const EMPTY: InboxFile = { nextSeq: 1, entries: [] };
const CAP = 500;

export interface PostInput {
  from: string;
  kind?: NotifyKind;
  text: string;
  taskId?: string;
}

export class Inbox {
  constructor(private readonly file: string) {}

  async post(input: PostInput): Promise<InboxEntry> {
    let created: InboxEntry | undefined;
    await updateJson<InboxFile>(this.file, EMPTY, (cur) => {
      const entry: InboxEntry = {
        seq: cur.nextSeq,
        id: `n${cur.nextSeq}`,
        from: input.from,
        kind: input.kind ?? "note",
        text: input.text.trim(),
        taskId: input.taskId,
        at: nowIso(),
      };
      cur.nextSeq += 1;
      cur.entries.push(entry);
      if (cur.entries.length > CAP) cur.entries = cur.entries.slice(-CAP);
      created = entry;
      return cur;
    });
    return created as InboxEntry;
  }

  /** Entries with seq > sinceSeq (0 = all kept). Also returns the current max seq as the cursor. */
  async read(sinceSeq = 0): Promise<{ entries: InboxEntry[]; cursor: number }> {
    const cur = await readJson<InboxFile>(this.file, EMPTY);
    const cursor = cur.nextSeq - 1;
    return { entries: cur.entries.filter((e) => e.seq > sinceSeq), cursor };
  }

  /** Block until an entry newer than sinceSeq appears, or the timeout elapses. */
  async waitForNew(sinceSeq: number, timeoutSec: number, pollMs = 1500): Promise<{ entries: InboxEntry[]; cursor: number; timedOut: boolean }> {
    const start = Date.now();
    for (;;) {
      const { entries, cursor } = await this.read(sinceSeq);
      if (entries.length) return { entries, cursor, timedOut: false };
      if (Date.now() - start > timeoutSec * 1000) return { entries: [], cursor, timedOut: true };
      await sleep(pollMs);
    }
  }
}
