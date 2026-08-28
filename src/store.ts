import fsp from "node:fs/promises";
import path from "node:path";
import { sleep } from "./util.js";

/**
 * Tiny JSON-on-disk store shared by several server processes
 * (one per MCP client: Claude Code, each Codex run, ...).
 * Atomic writes (tmp + rename) and an advisory lock file around read-modify-write.
 */

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      // Windows: rename over a file another process is reading can transiently fail.
      if (attempt >= 6 || !["EPERM", "EBUSY", "EACCES"].includes(code)) {
        await fsp.rm(tmp, { force: true });
        throw e;
      }
      await sleep(25 * (attempt + 1));
    }
  }
}

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

export async function withFileLock<T>(file: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const staleMs = opts.staleMs ?? 20000;
  const lock = `${file}.lock`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      const h = await fsp.open(lock, "wx");
      await h.writeFile(String(process.pid));
      await h.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        const st = await fsp.stat(lock);
        if (Date.now() - st.mtimeMs > staleMs) {
          await fsp.rm(lock, { force: true });
          continue;
        }
      } catch {
        /* lock vanished between attempts */
      }
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for lock ${lock}`);
      await sleep(20 + Math.random() * 60);
    }
  }
  try {
    return await fn();
  } finally {
    await fsp.rm(lock, { force: true });
  }
}

export async function updateJson<T>(file: string, fallback: T, mutate: (cur: T) => T | Promise<T>): Promise<T> {
  return withFileLock(file, async () => {
    const cur = await readJson<T>(file, fallback);
    const next = await mutate(cur);
    await writeJsonAtomic(file, next);
    return next;
  });
}
