# Subagents wait for their own ops — `./equin await`

## Context

A subagent that starts a long op in the background is never woken when it
finishes, so it sits idle forever and its parent waits on a report that can
never come. Measured, in `conv-1789736383-4i30` (worktree `att-1789736383-7uwn`):

- **01:28:59** teammate `curriculum-web` backgrounds `./equin check
  type-check`, says "I'll report once it lands", ends its turn.
- **01:29:46** teammate `curriculum-core` backgrounds `./equin test
  plugins/apps/plugins/chord`, same.
- **01:29:52** the main session writes "Rebuilding once they report" and ends
  its turn.
- **01:31:12 / 01:31:14** both commands finish, **exit 0**.
- Nothing happens for **9 hours**, until the user types.

The harness *did* build both notifications — and filed them under the **parent
session's** queue:

```json
{"type":"queue-operation","operation":"enqueue","timestamp":"2026-09-20T01:31:12.377Z",
 "sessionId":"fe07b1e6-…  (the MAIN session)",
 "content":"<task-notification><task-id>b7ne9lly1</task-id>…completed (exit code 0)"}
```

Neither was ever dequeued; both were still parked nine hours later, and the
user's own 10:34 message did not flush them. The asymmetry holds across the
whole session: **every** background command owned by the main session was
delivered within seconds, and **every** one owned by a subagent was parked until
some unrelated event gave that subagent a turn. One case is unmistakable —
`curriculum-web` backgrounded a type-check at 00:29, the notification was
written at 00:33, and the agent did not see it until **01:26**, when the team
lead happened to message it about something else.

This is upstream and unfixed: `anthropics/claude-code` **#88423** (*in-process
subagents are never re-invoked when their own run_in_background task
completes*), **#87689**, **#85534**, **#92410**, **#86963**, **#91503** — all
open.

Our own guard walks agents into it. `background-ops` forces every `./equin
build|push|check|test|release` to `run_in_background: true` and tells the caller
to *"END YOUR TURN […] you will be re-invoked with the output when it
finishes"* — true in a main session, false in a subagent. Both stalled teammates
were doing exactly what the guard told them to.

**Intended outcome:** a subagent can still build and test, and its wake-up stops
depending on the broken notification path. The wake becomes the result of its
own tool call.

## The idea

Don't hand the op to someone else, and don't wait to be notified: **block on it**.

The op keeps running as a harness background task (that half works — the process
is detached, untimed, and survives; only the notification is lost). The subagent
then makes one more foreground call that blocks until the op ends:

```bash
./equin build          # run_in_background: true — unchanged
./equin await build    # foreground; returns when the build ends
```

Two calls, not one fused command, for a concrete reason: `defineCliCommand`'s
**orphan guard** (`plugins/framework/plugins/cli/core/internal/command.ts:87-99`)
kills a CLI op when its invoking shell dies, and `build` deliberately does not
declare `detachable`. A fused `--await` would have to spawn the op itself, and
then the 600 s foreground cap would kill the awaiting shell *and the build with
it*. It would also need `detached: true`, which
`plugins/infra/plugins/spawn/lint/index.ts:57-65` reserves for one file. Keeping
the op harness-owned and the wait disposable avoids both.

Ruled out, checked against the hooks and CLI docs: **no hook fires when a
`run_in_background` task completes** (`Stop`/`SubagentStop` only get a
`background_tasks` snapshot at stop time), and **no supported way exists for an
external process to wake a running session**, let alone address one in-process
subagent — the only documented channel is feeding stdin to a headless `claude
-p` you yourself spawned. So nothing can deliver the wake from outside; the
agent has to hold the turn open itself. Making `await` a **command** rather than
a `--await` flag also keeps the e2e case reachable: `run` declares
`passthroughArgs: true`, so everything after the script name belongs to the
script and a flag there is unspellable.

## What `await` blocks on — all of it already exists

| question | record | where |
|---|---|---|
| is an op live in this worktree? | the op marker `~/.singularity/worktrees/<slug>/ops/<op>.json` (`{op,pid,startedAt,phase}`), read via `resolveActiveWorktreeOps()` which already reaps dead-pid markers | `plugins/infra/plugins/worktree/server/internal/worktree-op.ts:253,273,506` |
| what did it end as? | the op-log terminal record, `phase:"completed"` + `outcome` — **the only artifact covering all five op kinds** | `plugins/debug/plugins/profiling/plugins/op-log/` (`readOpRecords()`) |
| what is it blocked on right now? | `readOpenWait(opId)` — the same feed build's lock-waiter prints from | same plugin (`internal/read.ts:48`) |
| did a build deploy? | the deploy receipt `build-status.json` | `op-runtime/core` (`resolveBuildReceipt`) |
| did a test run pass? | `test-status.json` (`{opId,pid,status,runners[],failures[]}`) | `cli/plugins/test/core/internal/test-status.ts` |
| did it die without a verdict? | the marker's `pid` | same marker |

The marker is written before the op takes its lock and removed in a `finally`
plus an `onExit` handler; the same handler writes the terminal op-log record on
**every** graceful exit, including a `process.exit(1)` inside the body, landing
as `"error"` when nothing stamped an outcome
(`plugins/framework/plugins/cli/plugins/op-runtime/cli/direct-op.ts:228-243`).
`OutcomeByKind` already covers build, push, check, test and e2e. `push` and the
e2e branch of `run` persist nothing else, so the op-log is what `await` reports
for them; `build` and `test` add their richer receipt on top.

`readOpRecords` / `readOpenWait` are **already imported by CLI-runtime code**
(`op-runtime/cli/direct-op.ts`, `build/cli/internal/app-artifacts.ts`), so this
introduces no new plugin-boundary edge.

So `await` invents no record. It needs one field added: **`opId` on the marker**,
so a live marker maps to its op-log record exactly instead of by timestamp
proximity — and so a second `check` in the same worktree, which overwrites the
single `ops/check.json`, cannot make `await` report on the wrong run. `opId` is
already in scope at every `markWorktreeOpStart` call site.

## Plan

### 1. `opId` on the op marker

`plugins/infra/plugins/worktree/server/internal/worktree-op.ts` — carry `opId`
through `markWorktreeOpStart` and `WorktreeOpInfo`; pass it at the two call
sites (`op-runtime/cli/direct-op.ts`, `cli/plugins/build/cli/run.ts`, and the
push equivalent). Existing readers ignore the extra field.

### 2. `./equin await [op…]` — a new CLI command

`plugins/framework/plugins/cli/plugins/await/` (declared with
`defineCliCommand`, **not** `detachable`, so it dies with its shell — which is
correct: killing the wait must kill nothing).

Behaviour:

- **Arm.** Read the markers for this worktree (`basename(getWorktreeRoot())`).
  With no argument, await every live op; with `build` / `check` / … await those
  kinds. If none is live yet, wait up to ~60 s for one to appear (the op writes
  its marker within a second or two of spawn, but the two tool calls race).
- **Block.** Watch the ops directory with `@plugins/infra/plugins/file-watcher`
  — push-based, no polling — until the marker for each captured `opId` is gone.
  That primitive has no CLI-runtime precedent (every consumer today is a
  long-lived backend), so the command must keep the event loop alive only until
  the marker changes and then close the watcher explicitly. Prior art for the
  shape of the wait, if watching proves awkward, is the build lock's own
  `observeHolder` loop (`cli/plugins/bootstrap/cli/checkout-lock.ts`).
- **Report.** Read the op-log record for that `opId` and print the outcome; for
  a build also the receipt (`buildId`, deployed URL) — the authority CLAUDE.md
  already names — and for a test the failing files from `test-status.json`.
  Exit non-zero on a failing outcome, so the agent cannot misread success.
- **Say what it is doing while it waits.** Print a line on each state change
  from `readOpenWait(opId)` + the build/check progress logs, the way the build
  lock's `observeBuildHolder` already does ("waiting on host-grant", "step:
  type-check"). A wait that prints nothing for eight minutes reads as a hang.
- **Cap.** Return at **~8 minutes** (below the 600 s foreground limit) with
  `still running after 8m — run './equin await build' again`, and a
  non-terminal exit code distinct from failure. A p90 build (36.8 min) is about
  five calls, each a genuine block on a filesystem event.
- **Fail loudly.** Marker present but its `pid` is dead and no terminal record
  exists → say the op died without a verdict, naming the op and the pid. Never
  hang on a corpse, never report a stale success. Nothing is inferred from a
  log file's mtime.

### 3. Teach the guard who is asking

`plugins/framework/plugins/tooling/plugins/guards/`:

- `core/runner.ts` — add `agent_id?` / `agent_type?` to `HookInput` and pass
  them to `createContext`. These are **documented common hook fields**, present
  on every event when the hook fires inside a subagent
  ([hooks reference](https://code.claude.com/docs/en/hooks)), and they already
  arrive: `bin/guard.ts` casts the payload rather than schema-parsing it, so
  nothing strips them today. Confirmed live by logging real payloads — a
  subagent's `PreToolUse` carries both; a main-session one carries neither, and
  both report the *parent's* `session_id` and `transcript_path`.
- `core/types.ts` + `core/context.ts` — expose it once as `ctx.fromSubagent`,
  rather than every guard re-deriving it. Add it as a trailing parameter or an
  options bag; `createContext("/tmp")` is called positionally in several tests.
- `core/guards/background-ops.ts` — in a subagent, the `run_in_background: true`
  branch (today a silent allow) returns an **`inform`**: *your completion
  notification will not be delivered — your next call must be `./equin
  await <op>`; do not end your turn.* The foreground branch keeps denying, with
  the subagent hint naming both steps. The guard's existing "END YOUR TURN"
  wording stays for main sessions only, where it is true.
- The same branch **records ownership**: `<agent_id> started <op>` into a
  session-scoped state file, exactly the pattern `poll-loop` already uses
  (`tmpdir()/guard-poll-loop-<sessionId>.json`). That file is what makes step 4
  precise — without it a stop hook cannot tell whose op is running, and would
  block a subagent because its *parent* has a build in flight.

Not needed, confirmed: **no poll-loop exemption.** `singularity` is in
`MUTATORS` (`core/poll-detect.ts:124`), so every `./equin …` call
classifies as `mutate` and *resets* the poll window — repeated `await` calls
cannot trip it.

### 4. Enforcement: don't let a subagent end its turn on a live op

Confirmed supported. A stop hook may refuse the stop with
`{"decision":"block","reason":"…"}` (or exit 2, whose stderr becomes the
reason), and the reason is delivered to the agent as why it must continue.
`stop_hook_active` marks a stop already being continued by a previous block, and
Claude Code hard-overrides after **8** consecutive blocks — so this can slow a
runaway down but can never wedge a session.

**Two events, not one**, and the incident needs the second:

- `SubagentStop` — a plain Agent-tool subagent finishing. Input carries
  `agent_id`, `agent_type`, `agent_transcript_path` (the subagent's own, under
  `subagents/`), and a `background_tasks` snapshot of what is in flight.
- `TeammateIdle` — a **named teammate** about to go idle after its turn. This is
  the event that fires for the agents that stalled (`curriculum-web`,
  `curriculum-core` were named teammates, not one-shot subagents), and it has
  its own input (`teammate_name`, `team_name`) and its own decision contract —
  read it off the same page at implementation time rather than assuming it
  matches `SubagentStop`.

The hook: a second entry point beside `bin/guard.ts` (say `bin/stop-guard.ts`),
registered in `.claude/settings.json` for both events. It blocks when the
stopping agent owns an op that has not reached a terminal op-log record —
ownership from step 3's state file, liveness from the op marker — with the
reason *"`<op>` is still running. Run `./equin await <op>` and report what
it says."* Nothing else blocks a stop: an agent with no op of its own is never
delayed.

This is what makes the failure structural rather than advisory. It catches the
case whatever command started the op, including a background command this
plan's guard never sees.

(The guards plugin is described today as "Claude Code **PreToolUse** guards" —
its name, barrel and `CLAUDE.md` widen to cover stop events.)

### 5. Docs

`CLAUDE.md` — the agent-workflow section says "use `run_in_background: true` and
end your turn". Add the subagent clause: a subagent awaits its own op instead.
`plugins/framework/plugins/tooling/plugins/guards/CLAUDE.md` and the new
command's `CLAUDE.md` record why the two-call shape exists (orphan guard +
`detached` policy), so nobody fuses them later.

## Not in this plan

A **stall detector** — a conversation at `status = working` with no transcript
write and no live op for N minutes becomes a report + bell. It is the backstop
for every silent hang, not just this one; filed as its own task.

Also worth doing once this lands: add our evidence to #88423 / #87689. Those
reports do not have the `queue-operation` line showing the notification built
and filed under the parent's `sessionId`, nor the `agent_id` payload showing the
harness knows which agent made the call.

## Verification

1. `./equin test plugins/framework/plugins/tooling/plugins/guards` — the
   new `background-ops` subagent branch (assert an `inform` with a subagent
   context, and that a main-session context is unchanged), plus marker tests.
2. `./equin run plugins/framework/plugins/tooling/plugins/guards/e2e/replay-transcripts.ts --guards`
   — `backgroundOpsGuard` is in `PURE_GUARDS`; confirm its denial count over
   recorded transcripts does not move (the new branch only fires on a payload
   that recorded transcripts never carry).
3. **The real thing, end to end.** In this worktree: `./equin build`
   backgrounded, then `./equin await build` in the foreground — it must
   return within a second or two of the build ending, print the receipt's
   `buildId`, and exit 0. Then repeat with a deliberately broken build and
   confirm a non-zero exit and a named failure.
4. **The cap.** Await a build and confirm the ~8-minute return prints the
   run-again line and that a second `await` re-attaches to the same op.
5. **The stall itself, both shapes.** Spawn (a) a plain subagent and (b) a
   *named teammate* whose prompt is "run `./equin check type-check` and
   report the result". Each must come back with the verdict instead of going
   idle. Confirm in its transcript
   (`~/.claude/projects/<project>/<session>/subagents/*.jsonl`) that the turn
   never ends on an unanswered background task, and that a teammate which tries
   to stop early is sent back by the `TeammateIdle` block.
   The live reproduction to compare against is in this plan's Context: three
   explorer agents in the session that wrote it went idle without delivering
   their reports, and each only responded once messaged.
6. `./equin check` for the repo-wide checks, then `./equin build`.
