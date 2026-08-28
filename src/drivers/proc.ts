import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { errorMessage } from "../util.js";

/**
 * Is `file` currently held open by another process? Windows keeps an open handle from being
 * renamed, so a failed rename means "held". Elsewhere rename succeeds regardless: unknown.
 * Returns false when the file does not exist.
 */
export function probeHeldFile(file: string): boolean | undefined {
  if (!fs.existsSync(file)) return false;
  if (process.platform !== "win32") return undefined;
  const probe = `${file}.probe-${process.pid}`;
  try {
    fs.renameSync(file, probe);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "EPERM" || code === "EBUSY" || code === "EACCES" ? true : undefined;
  }
  try {
    fs.renameSync(probe, file);
  } catch {
    /* best effort: leave the probe name, the owner recreates locks on demand */
  }
  return false;
}

/** Kill a child and everything it spawned (Windows: taskkill /T, elsewhere SIGTERM then SIGKILL). */
export async function killTree(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      k.on("exit", () => resolve());
      k.on("error", () => resolve());
    });
  } else {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5000).unref();
  }
}

export interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a short command and capture its output. */
export function runCapture(command: string, args: string[], opts: { cwd?: string; shell?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<CaptureResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, NO_COLOR: "1", ...opts.env },
      windowsHide: true,
      shell: opts.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ code: null, stdout, stderr: `${stderr}${errorMessage(e)}` }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
