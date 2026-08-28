# intercom-mcp

MCP server that lets Claude Code drive other coding agents directly: Codex CLI and Antigravity CLI
(`agy`), through one set of tools.

The model is orchestrator / workers, not chat between windows:

- Claude Code calls `agent_send("sprites", "draw the enemy walk cycle ...")`.
- intercom runs `codex exec resume <thread>` headlessly in the agent's workspace, streams the
  events to disk, and returns Codex's final message plus a summary (commands, file changes, errors).
- The Codex thread persists. The human can open the same conversation any time with
  `codex resume <thread_id>`; intercom keeps using it afterwards.
- `tui_send` drops a message into a thread's inbox (`codex queue`). Codex reads it at the start
  of its next turn, in the TUI or in the next `agent_send`.
- A shared task board (`task_*`) replaces the hand-maintained `agent_exchange.md`. Codex sees the
  same board from inside its session through a worker-role copy of this server, so it can mark
  tasks `review` / `blocked` itself.

## Install

```powershell
git clone https://github.com/Eithery-rc/intercom-mcp C:\path\to\intercom-mcp
cd C:\path\to\intercom-mcp
npm install
npm run build

# Claude Code (orchestrator, available in every project)
claude mcp add -s user intercom -e INTERCOM_ACTOR=claude -- node C:\path\to\intercom-mcp\dist\index.js

# Codex (worker role: task board only). Lets agents report back on their own.
codex mcp add intercom --env INTERCOM_ROLE=worker -- node C:\path\to\intercom-mcp\dist\index.js
```

Then add one line under `[mcp_servers.intercom]` in `~/.codex/config.toml`:

```toml
default_tools_approval_mode = "approve"
```

Headless runs use `approval_policy = never`, and Codex fails MCP calls that are not read-only with
"requires approval" unless the server's tools are pre-approved. intercom also passes this setting
with `-c` on every run it spawns; the config line matters for Codex sessions the human opens in the TUI.

```powershell
# Antigravity CLI (worker role). Flags go before the name.
agy mcp add --env INTERCOM_ROLE=worker intercom node C:\path\to\intercom-mcp\dist\index.js
```

agy inherits the environment of the run that spawned it, so workers get `INTERCOM_DIR` /
`INTERCOM_AGENT` automatically. For unattended runs set `"toolPermission": "always-proceed"` in
`~/.gemini/antigravity-cli/settings.json`, or give the agent `full_auto: true`
(`--dangerously-skip-permissions`); otherwise agy soft-denies tools that would need approval.

Check: `node dist/index.js --doctor`, or the `info` tool from Claude Code.
`npm run smoke` runs an end-to-end test (spends three short Codex turns; `-- --no-codex` skips them).

## Data layout

Per project, next to the code (add `.intercom/` to `.gitignore` or keep `tasks.json` tracked, your call):

```
.intercom/
  agents.json      registry: name, cwd, role, sandbox, thread_id ...
  tasks.json       task board
  TASKS.md         rendered board for humans
  jobs/
    job_*.json         one record per turn (status, result summary, timings)
    job_*.events.jsonl raw codex --json events
    job_*.last.md      final message
    job_*.stderr.log
```

The data dir is resolved as: `--data-dir` / `INTERCOM_DIR`, else the nearest `.intercom/` walking
up from cwd, else (workers only) the pointer left by the last orchestrator, else `<cwd>/.intercom`.
Claude Code starts the server in the project directory, so each project gets its own board.

## Tools

Orchestrator (Claude Code):

| tool | purpose |
|---|---|
| `info` | resolved config, codex binary, running jobs |
| `agent_upsert` | register/update an agent: `name`, `cwd`, `role`, `sandbox`, `model`, `add_dirs`, `thread_id` (attach an existing conversation) |
| `agent_remove`, `agents_list` | |
| `agent_send` | send a message on the agent's persistent thread; waits up to `wait_seconds` (default 240) and returns the final message. `thread: new / fork`, `images`, `task_id`, `timeout_seconds` |
| `job_wait` | keep waiting for a running job |
| `job_list`, `job_events`, `job_cancel` | inspect or kill runs |
| `thread_history` | user/assistant messages of a thread as stored by Codex, including turns the human had in the TUI |
| `threads_recent` | recent Codex conversations on this machine, to attach one to an agent |
| `tui_send` | `codex queue` a message into a thread (by agent, uuid, or session name) |
| `task_create`, `task_update`, `task_list`, `task_get` | shared board |

| `inbox` | read the reverse channel (worker notifications) and get a `listen_command` |

Worker (inside Codex/agy): `info`, `agents_list`, `task_*`, and `notify` (ping the orchestrator).

## Typical session

```
agent_upsert  name=sprites  cwd=C:\Work\Personal\GlowRider  role="pixel artist: owns assets/sprites, never touches src/"
agent_upsert  name=tracks   cwd=C:\Work\Personal\GlowRider  role="level designer: owns assets/tracks"

task_create   title="enemy walk cycle, 8 frames, 32x32"  assignee=sprites  description="..."
agent_send    agent=sprites  task_id=T-001  message="Take T-001 from the board. ..."
   -> returns Codex's final report; Codex has set T-001 to review by itself
task_get T-001, review the files, then either:
   task_update T-001 status=done
   agent_send agent=sprites message="frame 5 clips the ground, fix and resend"
```

First message of a fresh thread gets a generated brief (who the agent is, its workspace, how to
use the board, "end each turn with a report"). Set `brief` on the agent to replace it.

## Auto-wake: no human relay

An MCP server cannot wake an idle Claude Code session on its own. The supported primitive is a
background task: the session launches a blocking process and the harness re-invokes the session
when that process exits. intercom uses it to make a finished agent task wake the session by itself.

```
agent_send  agent=sprites  message="..."  wait_seconds=0     -> returns job_id + wake_command
# then, in the SAME session:
Bash(run_in_background):  <wake_command>
```

`wake_command` is `node dist/index.js --wait <job_id> --data-dir <dir>`: it blocks until the job
reaches a terminal state (works for headless jobs and for messages delivered into a live TUI, since
both write the same job file), prints the result as one JSON line, and exits. That exit wakes the
session, which reads the result and continues. `agent_send` and `job_wait` also return `wake_command`
whenever they time out, so a task longer than the ~5 min MCP cap never needs a human to say "it's done".

The job keeps running inside the session's own MCP server process, so the session must stay open
(idle is fine); if it is closed, the job is orphaned and the waiter reports it on the next server start.

## Reverse channel: an agent pinging the orchestrator

Agents reach the orchestrator without it asking. From inside its session an agent calls `notify`
(and automatically when it sets a task to `review`/`blocked`), which posts to a shared inbox. The
orchestrator reads it with the `inbox` tool, and arms a listener the same way as auto-wake:

```
inbox                                    -> entries + a listen_command
Bash(run_in_background):  <listen_command>   # blocks until an agent posts, then exits and wakes the session
# after handling, re-arm with the new cursor:
inbox { since: <cursor> }  -> new listen_command
```

So both directions are covered with the same background-task primitive: `wake_command` for "the
task I sent finished", `listen_command` for "an agent has something to tell me". Neither needs a
human relay. Worker-role agents get `notify` in addition to the task board; the inbox lives in
`.intercom/inbox.json`.

## Notes and limits

- One turn at a time per agent (Codex locks the thread). `agent_send` refuses while a job runs;
  use `job_wait`, `job_cancel`, or `tui_send` to leave a note for the next turn.
- Thread open in the Codex TUI: `agent_send` cannot resume it (Codex reports "already has an
  active writer"), so intercom queues the message into that session instead and the job ends as
  `queued_tui`. An idle TUI picks the message up within seconds and answers there; the reply is in
  the thread (`thread_history`), not in the job. Close the TUI to get synchronous answers again.
- Conversation open in an agy TUI or the Antigravity IDE: intercom detects the running session (it
  serves the conversation over a local RPC port, logged in `~/.gemini/antigravity-cli/log/cli-*.log`)
  and drives the turn *through* that session, so the message shows up in the open window, runs there,
  and the reply comes back to `agent_send`. `agents_list` shows `live_session` per agent.
- Claude Code aborts an MCP call that is silent for ~5 minutes, so waits are capped at 290 s and
  send progress notifications. Long tasks: `agent_send` returns `still_running`, then `job_wait`.
- Sandbox defaults to `workspace-write`. `full_auto` passes `--dangerously-bypass-approvals-and-sandbox`.
- Env vars: `INTERCOM_DIR`, `INTERCOM_ROLE`, `INTERCOM_ACTOR`, `INTERCOM_AGENT`, `INTERCOM_CODEX`
  (path to the codex binary if it is not on PATH), `CODEX_HOME`.
- Agents in one repo should own disjoint directories, or work in separate git worktrees.

## Drivers

| | codex | agy |
|---|---|---|
| turn | `codex exec` / `exec resume <id>` / `exec fork <id>`, prompt on stdin, `--json` events | `agy --input-format stream-json --output-format stream-json [--conversation <id>]` |
| thread id | `thread.started` event | `init` event (`conversation_id`) |
| sandbox | `-s read-only / workspace-write / danger-full-access`; `full_auto` bypasses approvals | `read-only` -> `--mode plan`, `workspace-write` -> `--mode accept-edits`, `danger-full-access` or `full_auto` -> `--dangerously-skip-permissions` |
| images | `-i file` | no flag; paths are appended to the message for the agent to open |
| live session (thread open in a TUI/IDE) | message queued into the session inbox (`codex queue`), reply read back from the thread | message posted through the session's local RPC, runs in that window, reply read from its trajectory |
| `tui_send` | `codex queue --thread` | not available (no inbox) |
| `thread: fork` | yes | no |
| history | rollout `.jsonl` under `~/.codex/sessions` | sqlite `~/.gemini/antigravity-cli/conversations/<id>.db` (protobuf payloads, decoded best-effort) |
| `threads_recent` | rollout files by mtime | `conversation_summaries.db` (CLI and IDE conversations, with workspace) |

## Roadmap

- Codex app-server driver for streaming and live TUI attach once the daemon works on Windows.
- Live-session detection (thread writer lock) to route `agent_send` vs `tui_send` automatically.
