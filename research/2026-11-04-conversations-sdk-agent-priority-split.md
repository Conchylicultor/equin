# SDK agents at normal priority; only what they launch in the background

## Context

Report `report-1793645460-lkkknd` (15 hits since 2026-11-02): `SDK agent conv-…: no reply to
hello within 10000ms`, and the user's "Failed to send". On 2026-11-04 17:30:42–17:32:02Z every
backend → agent socket call timed out (8 `mandate-change-notice` attempts, a `turn`, its
`retry`); at 17:32:08 the agent answered them all at once (14 `write EPIPE`: the backend had
closed each connection). `hello` touches no CLI state (`bin/agent.ts` `run`), so the agent's own
JS could not run for ~90 s. Host load was 224/18 CPUs with memory pressure, and the agent runs
darwinbg: `agent-process.ts` launches it under `backgroundPrefix()`, and darwinbg is inherited by
the CLI and every tool command.

Why it is darwinbg: research/2026-07-07-global-background-work-priority-isolation.md chose
"whole-agent-session demotion" because the tmux session command was the one choke point covering
everything an agent runs. The SDK runtime (b54351bd38) carried the prefix over unchanged, onto a
process that now also serves the latency-sensitive command socket. Worktree backends hit the same
starvation (30–95 s) and were fixed by self-promotion (`leaveDarwinBackground`); agents never were.

Second defect seen in the same incident: the timed-out `turn` and its user `retry` (same ledger
`turnId`) were BOTH delivered once the agent woke — the user's message reached the model twice.

Intended outcome: the agent wrapper and the Claude CLI run at normal priority; every command the
CLI spawns (Bash tool, hooks, stdio MCP servers) stays darwinbg exactly as today; a `turn` is
idempotent by `turnId` within an agent process.

## Design

### 1. The agent process is foreground, by its own hand

- `agent-process.ts`: drop `backgroundPrefix()` from the launch command.
- `bin/agent.ts`, first thing at startup: `leaveDarwinBackground()` (spawn-priority core) and log
  the tier (`● scheduling tier: foreground`). Self-promotion, not the launcher's choice, because a
  launcher's tier is not ours to know (a worktree backend is darwinbg until ready; only a self
  write works — spawn-priority/CLAUDE.md). The CLI is spawned after, so it inherits foreground.

### 2. What the CLI launches is demoted through `CLAUDE_CODE_SHELL_PREFIX`

The bundled CLI (2.1.310) supports it — verified in the binary: the Bash tool's command string
becomes `ime(prefix, cmd)` = `'<prefix>' '<cmd>'` (a prefix whose last ` -x` token is split off as
one flag), run by `<shell> -c -l`; hooks and stdio MCP servers go through the same prefix. So the
prefix must be ONE executable taking the whole command string as `$1`.

- New `plugins/packages/plugins/spawn-priority/bin/background-shell` (executable `sh`, the `bin/st`
  precedent): `exec /usr/sbin/taskpolicy -b -- "${CLAUDE_CODE_SHELL:-${SHELL:-/bin/sh}}" -c "$1"`.
  Environment passes through untouched (the CLI's BUN_OPTIONS guard needs it).
- spawn-priority core: `backgroundShellPrefix(): string | null` — the script's absolute path when
  demotion applies (darwin with taskpolicy, `NO_SPAWN_PRIORITY` unset), else null. Same switch as
  `prefixTokens()`. A test pins the script's demotion to `TASKPOLICY` + `DEMOTE_FLAGS`, so the
  two cannot drift (the script cannot import the constant).
- `bin/agent.ts` `spawnClaudeCodeProcess`: `env.CLAUDE_CODE_SHELL_PREFIX = backgroundShellPrefix()`
  when non-null.

Net effect vs today: only the wrapper and the CLI process change tier; everything they spawn is
darwinbg as before (incl. guards and `./equin build`, whose lane logic reads its own darwinbg).
Non-darwin: the agent keeps its launcher's priority (previously `nice 10`) — no supported host
runs there.

### 3. A `turn` is idempotent by `turnId`

`bin/agent.ts` `pushInput`: a `turnId` this process already queued returns the same `promptUuid`
(derived from the id) without queueing again, logged `› duplicate turn <id> ignored`. A turn the
CLI reports `cancelled` is forgotten, so a later retry of it does deliver. Protocol comment on the
`turn` command records the guarantee. Scope is one process: a relaunch replays nothing.

## Files

- `plugins/conversations/plugins/runtime-sdk/bin/agent.ts`
- `plugins/conversations/plugins/runtime-sdk/machine/internal/agent-process.ts`
- `plugins/conversations/plugins/runtime-sdk/core/protocol.ts` (comment)
- `plugins/packages/plugins/spawn-priority/{bin/background-shell, core/internal/background.ts, core/index.ts, CLAUDE.md}` + test

## Verification

- `./equin test plugins/packages/plugins/spawn-priority`; `./equin check`.
- Wrapper by hand: `background-shell 'echo $0; ps -o pid,pri -p $$'` runs in the given shell at
  PRI 4; quoting survives a command with quotes, `&&` and `$VAR`.
- `./equin build`, then launch a conversation on this build and ask it to run a command printing
  its tier: agent.log shows `scheduling tier: foreground`; `ps` shows the wrapper and CLI at
  normal PRI and the Bash child at PRI 4.
