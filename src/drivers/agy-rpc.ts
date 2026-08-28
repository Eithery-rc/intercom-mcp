import fsp from "node:fs/promises";
import path from "node:path";
import { errorMessage, log } from "../util.js";

/**
 * Client for the local language server embedded in every running `agy` session.
 *
 * Each interactive agy process listens on a random localhost port ("Language server listening on
 * random port at N for HTTP" in ~/.gemini/antigravity-cli/log/cli-*.log) and serves Connect-RPC
 * over plain HTTP + JSON, no auth. That is how the TUI itself talks to the agent, so a message
 * sent through it shows up in the open session and runs as a normal user turn.
 */

const SERVICE = "exa.language_server_pb.LanguageServerService";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CascadeStep = { type?: string; status?: string; [k: string]: any };

export const STEP = {
  userInput: "CORTEX_STEP_TYPE_USER_INPUT",
  plannerResponse: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
  error: "CORTEX_STEP_TYPE_ERROR_MESSAGE",
  system: "CORTEX_STEP_TYPE_SYSTEM_MESSAGE",
  done: "CORTEX_STEP_STATUS_DONE",
} as const;

async function readHead(file: string, bytes: number): Promise<string> {
  const h = await fsp.open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await h.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await h.close();
  }
}

export class AgyRpcClient {
  private readonly cache = new Map<string, { port: number; at: number }>();

  constructor(private readonly home: string) {}

  async call<T = Record<string, unknown>>(port: number, method: string, body: unknown, timeoutMs = 15000, signal?: AbortSignal): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/${SERVICE}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await res.text();
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = { raw: text };
      }
      if (!res.ok || typeof json.code === "string") throw new Error(`${method}: ${String(json.message ?? json.raw ?? res.status)}`);
      return json as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Ports of recently started agy sessions, newest log first. Dead ones are filtered by the caller. */
  private async candidatePorts(): Promise<number[]> {
    const dir = path.join(this.home, "log");
    let names: string[];
    try {
      names = (await fsp.readdir(dir)).filter((n) => /^cli-.*\.log$/.test(n));
    } catch {
      return [];
    }
    const stats = await Promise.all(
      names.map(async (n) => {
        try {
          return { n, m: (await fsp.stat(path.join(dir, n))).mtimeMs };
        } catch {
          return undefined;
        }
      }),
    );
    const recent = stats
      .filter((s): s is { n: string; m: number } => !!s)
      .sort((a, b) => b.m - a.m)
      .slice(0, 12);
    const ports: number[] = [];
    for (const { n } of recent) {
      try {
        const head = await readHead(path.join(dir, n), 64 * 1024);
        const m = /listening on random port at (\d+) for HTTP\b/.exec(head);
        if (m) ports.push(Number(m[1]));
      } catch {
        /* unreadable log */
      }
    }
    return [...new Set(ports)];
  }

  /** Port of the running session that hosts this conversation, if any. */
  async findServerFor(conversationId: string): Promise<number | undefined> {
    const cached = this.cache.get(conversationId);
    if (cached && Date.now() - cached.at < 5000) return cached.port;
    for (const port of await this.candidatePorts()) {
      try {
        const r = await this.call<{ trajectorySummaries?: Record<string, unknown> }>(port, "GetAllCascadeTrajectories", {}, 2500);
        if (r.trajectorySummaries && Object.hasOwn(r.trajectorySummaries, conversationId)) {
          this.cache.set(conversationId, { port, at: Date.now() });
          return port;
        }
      } catch {
        /* port dead or another session */
      }
    }
    this.cache.delete(conversationId);
    return undefined;
  }

  async steps(port: number, conversationId: string, signal?: AbortSignal): Promise<CascadeStep[]> {
    const r = await this.call<{ steps?: CascadeStep[] }>(port, "GetCascadeTrajectorySteps", { cascadeId: conversationId }, 20000, signal);
    return r.steps ?? [];
  }

  /**
   * Deliver a user message into the live session. The request must carry the model configuration,
   * which we copy from the conversation's latest user turn (the TUI does the same).
   */
  async sendUserMessage(port: number, conversationId: string, text: string): Promise<{ stepsBefore: number }> {
    const steps = await this.steps(port, conversationId);
    const template = [...steps].reverse().find((s) => s.type === STEP.userInput && s.userInput?.userConfig)?.userInput?.userConfig
      ?? [...steps].reverse().find((s) => s.userInput?.lastUserConfig)?.userInput?.lastUserConfig;
    if (!template) throw new Error("cannot copy the model configuration from the conversation (no user turn with a config yet); send one message from the TUI first");
    await this.call(port, "SendUserCascadeMessage", { cascadeId: conversationId, items: [{ text }], cascadeConfig: template }, 20000);
    return { stepsBefore: steps.length };
  }

  async cancel(port: number, conversationId: string): Promise<void> {
    try {
      await this.call(port, "CancelCascadeSteps", { cascadeId: conversationId }, 5000);
    } catch (e) {
      log(`agy rpc cancel failed: ${errorMessage(e)}`);
    }
  }
}

/** Human-readable text of a step, for logs and history. */
export function stepText(s: CascadeStep): string {
  if (s.type === STEP.userInput) return (s.userInput?.items ?? []).map((i: { text?: string }) => i.text ?? "").join("");
  if (s.type === STEP.plannerResponse) return String(s.plannerResponse?.response ?? "");
  if (s.type === STEP.error) return String(s.errorMessage?.error?.modelErrorMessage ?? s.errorMessage?.error?.userErrorMessage ?? "error");
  if (s.type === STEP.system) return String(s.systemMessage?.message ?? "");
  const payloadKey = Object.keys(s).find((k) => !["type", "status", "metadata"].includes(k));
  return payloadKey ? `${payloadKey}: ${JSON.stringify(s[payloadKey]).slice(0, 300)}` : "";
}
