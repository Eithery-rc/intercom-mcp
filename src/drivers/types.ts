import type { AgentRecord } from "../registry.js";

export type TurnMode = "resume" | "new" | "fork";

export interface TurnFiles {
  events: string;
  stderr: string;
  lastMessage: string;
}

export interface TurnRequest {
  agent: AgentRecord;
  /** Full text sent to the agent (brief already prepended when applicable). */
  message: string;
  images: string[];
  /** Effective mode: "resume"/"fork" only when agent.threadId is set. */
  mode: TurnMode;
  files: TurnFiles;
  onThreadId: (id: string) => void;
}

export interface CommandSummary {
  command: string;
  exitCode: number | null;
  status?: string;
  outputTail?: string;
}

export interface TurnSummary {
  finalMessage: string | null;
  agentMessages: string[];
  commands: CommandSummary[];
  fileChanges: { path: string; kind: string }[];
  mcpCalls: { server: string; tool: string; status?: string }[];
  webSearches: string[];
  errors: string[];
  itemCounts: Record<string, number>;
  usage?: Record<string, unknown>;
}

export interface TurnOutcome extends TurnSummary {
  threadId: string | null;
  exitCode: number | null;
  signal: string | null;
  spawnError?: string;
}

export interface TurnHandle {
  pid: number | undefined;
  kill(): Promise<void>;
  done: Promise<TurnOutcome>;
  /** Live snapshot while the turn is running. */
  summary(): TurnSummary;
}

export interface HistoryEntry {
  role: "user" | "assistant";
  text: string;
  at?: string;
  turnId?: string;
}

export interface ThreadInfo {
  threadId: string;
  cwd?: string;
  startedAt?: string;
  updatedAt: string;
  source?: string;
  originator?: string;
  firstMessage?: string;
  file: string;
}

export interface AgentDriver {
  readonly name: string;
  /** Whether queueMessage can deliver into a running interactive session. */
  readonly hasInbox: boolean;
  startTurn(req: TurnRequest): TurnHandle;
  /** Drop a message into the agent's inbox; delivered on the thread's next turn (TUI or headless). */
  queueMessage(threadRef: string, message: string, images: string[]): Promise<{ ok: boolean; output: string }>;
  /** true = an interactive session currently holds this thread; undefined = cannot tell. */
  isLive(threadId: string): boolean | undefined;
  threadHistory(threadId: string, last: number): Promise<HistoryEntry[]>;
  recentThreads(limit: number, cwdFilter?: string): Promise<ThreadInfo[]>;
  describe(): Record<string, unknown>;
}
