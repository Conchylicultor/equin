# Conversation status from push signals (retire the 1 s `conversations.poller`)

## Context

`plugins/conversations/server/internal/poller.ts` is a 1 s `defineTimer` that runs on every
backend, forever. Each tick it:

- runs `tmux list-panes -a` and takes a `ps` snapshot;
- resolves `~/.claude/sessions/<pid>.json` for every pane (`claude-session.ts`);
- runs `capture-pane` on every live pane, throttled to once per 5 s per pane, to detect the
  AskUserQuestion menu (`pane-menu.ts`);
- reconciles every active conversation row: status, waitingFor, title and session id, orphan
  adoption, hibernate/gone, and the "starting" timeout.

How fresh the status looks is capped by the tick (and by the 5 s probe throttle for questions),
and the cost is paid even when nothing changes. It is the last "real polling" entry on the
`defineTimer` allowlist (`plugins/infra/plugins/background/plugins/timer/lint/index.ts`).

Goal: every state the poller detects today has a push signal. A per-conversation reconcile runs
when one fires. Missed-signal recovery is a boot reconcile plus a slow scheduled sweep. The
timer and its allowlist entry are deleted.

This follows the same shape as `research/2026-10-02-conversations-turn-emitter-push-activation.md`
(event wakes up, the handler re-reads the truth, idempotent, serialized).

**Scope: polling only.** How AskUserQuestion is shown and answered is out of scope. That covers
the Escape flush, auto-open, "Answer here", and possibly answering through the hook's
`updatedInput`. It is filed as follow-up task `task-1790938096179-uol2tx`. Here the question keeps
today's semantics: `waitingFor:"question"` while the menu is on screen, and the same auto-open
behaviour.

### Expected latency (before → after)

| State | Today | After |
|---|---|---|
| working ↔ waiting | 0–1 s tick, plus the tick's own run time (one `ps`, `list-panes`, and every pane's file read and capture), which grows with pane count and load | file write 30–270 ms after the turn ends, about 150 ms debounce, then one batched reconcile |
| question menu | 0.7–5.5 s (measured: the 5 s probe throttle) | `PreToolUse` hook, before the menu is drawn, then one capture |
| agent died | 0–1 s | immediate (tmux hook) |
| pane title | 0–1 s | next transition or sweep (**slower**; task titles are generated independently) |
| stuck "starting" | 30 s | up to about 90 s (**slower**, failure path only) |
| a missed signal | ≤1 s (next tick) | ≤60 s (sweep). **This was the risk.** The shadow audit (Verification 4) found two classes, both fixed, then none in a day; it was removed on 2026-10-08 (research/2026-10-07-conversations-status-shadow-audit-retirement.md). |

Host-wide: the per-second `ps`, `list-panes` and capture-pane work stops on every backend, main
and every worktree.

## Open question resolved: do the signals cover every scraped state?

Checked against CLI 2.1.287 (installed), tmux 3.6a, and the transcripts on disk.

| State the poller derives | Today's source | Push signal |
|---|---|---|
| working / waiting | session file `status` (the authority; the title can only promote) | **Watch `~/.claude/sessions/*.json`.** The CLI rewrites the file on every transition. The file carries `"tmux":"<session>:@win.%pane"`, which names the conversation directly. |
| `waitingFor` (permission prompt, input needed) | session file `waitingFor` | same file write |
| `claudeSessionId` (new session after /clear or resume) | session file `sessionId` | same file write |
| **AskUserQuestion menu** (`waitingFor:"question"`) | capture-pane screen scrape | **A Claude Code `PreToolUse` hook (matcher `AskUserQuestion`) as the wake-up; one capture-pane at reconcile as the verdict.** The transcript **cannot** carry this signal. The CLI buffers the assistant message and writes the `tool_use` only once the tool resolves (`research/2026-06-02-conversations-askuserquestion-web-flush.md`). The 57 "doesn't want to proceed" results on disk are the app's own Escape flushes. The session file is not enough either: depending on the CLI version, an open menu reads as `busy` or as an ordinary wait. See §3 v2. |
| `shell` and a build/push in flight | `isWorktreeOpActive` scan | **Watch one flat op-signal dir** (`~/.singularity/state/worktree-op-signals/<slug>`, owned by `infra/worktree`), touched by `worktree-op.ts` on every marker publish, release and reap. Not the op-marker dirs themselves: watching `~/.singularity/worktrees/` recursively also streams every build output (`web.live.*` / `web.staging.*`, thousands of files per build) to every backend. |
| pane dead / session gone | `list-panes` absence or `pane_dead` | **Global tmux hooks** `session-closed` and `pane-exited` touch `~/.singularity/state/tmux-signals/<session_name>`, a watched dir. This covers a normal exit, SIGKILL, kill-session and a manual close. A normal Claude exit also deletes its session file. |
| orphan adoption (main) | `list-panes` shows an unknown `conv-*` | tmux `session-created` hook, plus the new session file's tmux stamp |
| pane title | `list-panes` title | **No signal** (tmux 3.6a has no title-change hook). The title is re-read on every reconcile, which happens on every status transition. A title that lands mid-turn shows at the next transition or the next sweep. That is acceptable: `tasks/task-title` generates real titles independently. |
| "starting" with no pane after 30 s | tick age check | Scheduled sweep: worst case is the sweep interval plus 30 s instead of 30 s. |
| tmux server died / watcher dropped an event / backend was down | (the next tick) | boot `reconcileAll()`, a scheduled sweep `defineJob` (1 min, the cron floor), and the file watchers' own `reconcileMs` |

**Session-file latency, measured** on 18 live session files, CLI 2.1.280–2.1.287:

- **Turn end.** The file's `statusUpdatedAt` lands 30–270 ms after the turn's last transcript
  entry (worst case 0.81 s).
- **Turn start.** `busy` files were stamped 22–27 s before their latest transcript entry. They had
  flipped to busy at turn start and stayed busy through the work since.
- **Unexplained gaps.** Four idle files were stamped 7–43 minutes after the turn ended. That is
  either a later idle re-stamp or a late write, and this data cannot tell which.

So the file is real-time for working/waiting. The late-write possibility is covered only by the
1-minute sweep. That sweep reads the same file, so it cannot fix a write that has not happened.
Verification step 4 must tell those two cases apart before relying on the file for status.

**Claude Code hooks are used for one thing only: the question.** For working/waiting they would
duplicate the session-file write. The question is the one state that has no file signal.

## Design

### 1. Runtime contract: inspect a set, signal changes (`plugins/conversations/server/internal/runtime.ts`)

Add two methods to `ConversationRuntime`:

- `inspect(ids: string[]): Promise<Map<string, RuntimeInfo>>`. This is the batched form of
  `list()` for a known set. A missing id means no live session. A throw means the state is
  unknown, the same contract as `list()` failing today.
- `subscribe(onSignal: (s: RuntimeSignal) => void): () => void`, where
  `RuntimeSignal = { conversationIds: string[] } | { worktreePath: string } | { all: true }`.

`list()` stays: the sweep, the boot reconcile and orphan adoption use it.

`runtime-api` implements both trivially. It can signal in-process from its own send and exit paths.

### 2. tmux signal sources (`plugins/conversations/plugins/runtime-tmux/server/internal/signals.ts`, new)

All three use `defineFileWatcher` (`plugins/infra/plugins/file-watcher`). That keeps them visible
under File watchers in Background activity.

- **Session files** (`CLAUDE_SESSIONS_DIR`, `.json`, debounce of about 150 ms).
  - For each changed file, read it and take the session name from its `tmux` stamp (`TMUX_STAMP_RE`
    in `claude-session.ts`; export a parser). Emit that conversation id.
  - Keep a `pid → conversationId` map from the last read, so an unlink still yields its id.
  - A record with no stamp emits `{ worktreePath: cwd }`, the existing "local" tier fallback.
  - The pid itself is resolved by the unchanged `resolveSessionState` inside `inspect`. Parked jobs,
    foreign-session vetoes and anomaly reports all stay exactly as they are.
- **tmux events** (`~/.singularity/state/tmux-signals/`, add the path to `infra/paths`).
  - A file name is a session name; emit it as an id.
  - `tmux-hooks.ts` installs `set-hook -g 'session-closed[73]'`, `pane-exited[73]` and
    `session-created[73]`, each as `run-shell -b "touch <dir>/#{hook_session_name}"`.
  - The fixed array index makes a re-install idempotent and leaves other hooks alone.
  - Install at boot, and chain it into every `create()`'s `new-session` (`\; set-hook …`). The tmux
    server exits with its last session and forgets its hooks, so the first `create` on a fresh
    server re-arms them.
  - The sweep job deletes signal files older than a day.
- **Op markers** (the `worktreesDir()` ops subdirs). Emit `{ worktreePath }` for the slug whose
  marker changed. This flips `shell` between working and waiting when a build or push starts or ends.

`list()` and `inspect()` drop the capture-pane probe and `probeCache` entirely. `inspect(ids)` runs
the existing path once per batch: one `list-panes`, one `captureProcessTree()`, then
`resolveSessionState` and `resolvePaneStatus` per pane.

### 3. Question detection (v2: the transcript approach was wrong; the tool_use is buffered)

Rule: **signals wake the reconciler, the pane decides.** The capture-pane classifier stays as the
verdict for the question, but it runs only when a reconcile runs, not on a timer.

- **Wake-ups for the menu opening.**
  - `create()` adds `{"hooks":{"PreToolUse":[{"matcher":"AskUserQuestion","hooks":[{"type":"command","command":"touch \"$HOME/.singularity/state/tmux-signals/$SINGULARITY_CONVERSATION_ID\""}]}]}}`
    to the launch's `--settings`. The JSON must stay free of single quotes. Resume also goes
    through `create`, so it is covered too.
  - The hook fires before the menu is drawn. `PostToolUse` and `PostToolUseFailure` on the same
    matcher, plus `UserPromptSubmit`, touch the same file for the menu closing.
  - The file is the same signal dir as the tmux hooks, so this adds no new route.
  - The session-file write, where a CLI version writes one for the menu, is a second wake-up.
- **Verdict at reconcile.** For every reconciled pane that is not dead, run one fresh
  `classifyPaneMenu`. This is today's override (`working:false, waitingFor:"question"`), minus the
  5 s throttle cache. It runs per transition, not per second.
- **The draw race.** A wake-up can arrive before the menu is painted. So a reconcile woken by the
  `PreToolUse` hook classifies once, and if the pane still reads `idle` it schedules one re-check
  about 500 ms later. That is a single follow-up, not a loop.
- **Escape typed in the terminal.** It closes the menu. Whether `PostToolUseFailure` fires on a
  user rejection is unverified. If it does not, the next session-file transition or the
  `UserPromptSubmit` hook clears the question. The worst case is the sweep.
- **Sessions with no hooks.** Agents launched before this deploy, and adopted or manual sessions,
  get questions detected on any transition and at the sweep. That is degraded, and only for
  sessions that predate the change.

### 4. Reconciler (`poller.ts` → `status-reconciler.ts`)

- **Pure decision.** Split `tick()`'s per-row logic into a pure `planConversationUpdate(row, live |
  absent | unknown, { onMain, now, openQuestion })` → patch | gone | closed | hibernate | adopt |
  noop, unit tested. The orphan, done, gone, closeRequested, hibernate, starting-grace and
  session-id-gate logic moves over unchanged. `acceptsSessionId` stays async in the shell around it.
- **`reconcileIds(ids)`.** Read the rows (a PK read), run `runtime.inspect(ids)` grouped by runtime,
  apply the plan. An id with no row on main is the adoption path.
- **`reconcileAll()`.** Today's `tick()`, built on `list()`.
- **Batching.** Signals accumulate in a pending set that is drained one batch at a time through
  `createSemaphore(1)`. A signal that arrives mid-drain joins the next batch. A burst costs one
  `ps` and one `list-panes`, not N.
- **`{ worktreePath }` signals** map to ids with one DB lookup on that worktree.
- **Recovery.**
  - `reconcileAll()` in `onReady`, failing loudly.
  - `conversationsStatusSweepJob`: a `defineJob` with an every-minute schedule that runs
    `reconcileAll()` and prunes old tmux-signal files. Its description says it is the
    missed-signal backstop.

### 5. Auto-flush no longer races the render

The `PreToolUse` wake-up fires before the menu is painted.
`escapeUntilPromptCleared` currently returns at once on `idle`. Add a bounded "wait for the menu to
appear" phase to `flushInteractivePrompt`: a fresh `classifyPaneMenu` every 100 ms for up to 3 s,
before the existing Escape loop. The question is known to be open, so seeing `idle` first is a
render lag, not clearance. `answerPrompt` gets the same phase. Capture-pane survives only in these
action paths, which is where it belongs.

### 6. Delete

- Delete `conversationsPollerTimer` and `startPoller`. In `plugins/conversations/server/index.ts`,
  register the sweep job and the tracker triggers instead.
- Remove the `poller.ts` line and its comment from the timer allowlist.
- Update `plugins/conversations/plugins/runtime-tmux/CLAUDE.md` (the status-sources section) and
  the comments that cite "the 1 s poll". These sit in `poller.ts` and in
  `waitingFor`-excluded-from-hash notes such as `all-conversations/.../revision-resource.ts`.

Untouched: `session-divergence` and `stall-monitor` (they use `listPanes` and `resolveSessionState`
directly), `decideMissingProcessAction`, the `tasks-core` mutations, the `waitingFor` readers on
the web side.

## Critical files

- `plugins/conversations/server/internal/poller.ts` (→ `status-reconciler.ts`, plus a new pure
  `plan-update.ts` and its `.test.ts`)
- `plugins/conversations/server/internal/runtime.ts`, `plugins/conversations/server/index.ts`
- `plugins/conversations/plugins/runtime-tmux/server/internal/{tmux-runtime.ts,claude-session.ts}`,
  and new `signals.ts` and `tmux-hooks.ts`
- `plugins/conversations/plugins/runtime-api/server/internal/api-runtime.ts`
- `plugins/conversations/plugins/effort-provider` / `tmux-runtime.ts` `create()`: merge the
  question hooks into the launch's `--settings` JSON (one settings object, not two flags)
- `plugins/infra/plugins/paths/core/internal/paths.ts` (`TMUX_SIGNALS_DIR`)
- `plugins/infra/plugins/background/plugins/timer/lint/index.ts`

Reused: `defineFileWatcher`, `defineJob` (schedule plus the `Trigger` contributions),
`createSemaphore`, `resolveSessionState`, `resolvePaneStatus`, `classifyPaneMenu`, `listWorktreeOps`.

## Verification

1. **Unit tests.**
   - `./equin test plugins/conversations`: the new `plan-update.test.ts` covers every arm,
     with cases ported from the poller's comments: done never overwritten, closeRequested → closed,
     starting grace, failed runtime → untouched, hibernate vs gone, question override.
   - A session-stamp parser test.
   - A test that the `--settings` JSON merges the effort settings with the hooks and contains no
     single quotes.
2. **Build:** `./equin build`, then `./equin check` (the timer lint passes without the entry).
3. **Live checks** in the worktree deploy. Start an agent from its UI and watch the row via
   `query_db` and Debug → Background activity: no `conversations.poller` timer, three new file
   watchers and the sweep job.
   - working → waiting within about 200 ms of the turn end.
   - A permission prompt shows `waitingFor` "permission prompt".
   - AskUserQuestion → `question`. Answer from the web → cleared. Escape in the terminal → cleared.
     With auto-answer on, the menu is dismissed exactly once (no rewind menu).
   - `tmux kill-session -t <conv>` → hibernated or gone immediately. `kill -9` on claude → the same.
   - A build in flight on a `shell` pane stays working, then flips when the build ends.
   - `tmux kill-server`, then start a new agent → the hooks are re-armed (`tmux show-hooks -g`).
   - Restart the backend → the boot reconcile corrects a state changed while it was down.
4. **Latency audit, before deleting the timer.** For one day, run the new watchers while the old
   poller keeps running in shadow mode: it writes nothing and only logs. Record every case where the
   poller saw a state change that no signal had delivered within 2 s. That shows whether the
   7–43 min late `statusUpdatedAt` writes are real, and whether the question hooks fire on every
   menu. Delete the timer only when that log is empty or each entry is explained.
   Also **measure** the session-file write rate during a busy turn (the watcher batch log in Background
   activity). It confirms the debounce and batching keep reconciles bounded by transitions, not by
   the CLI's `updatedAt` heartbeat, if it has one.
5. **Hook semantics to confirm empirically** before relying on them. Fall back to the sweep if
   either fails:
   - a `session-closed` global hook fires for a single-pane session whose program exits;
   - `PreToolUse` fires for `AskUserQuestion` before the menu is drawn, and whether
     `PostToolUseFailure` fires when the user presses Escape on it;
   - `#{hook_session_name}` expands in `run-shell`.
