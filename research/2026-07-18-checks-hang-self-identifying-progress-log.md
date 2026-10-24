# Make a hung check run name itself

## Context

Twice now a `check --scope tree` subprocess spawned by `push` has hung indefinitely
while holding the push mutex, freezing every build and push on the host (2026-07-18
~05:04–12:55, ~8h; and again ~17:52–18:15, killed manually). The hang is
**intermittent** — killing and retrying usually lets the push land.

**We still do not know which check hangs.** Two investigations have only been able
to eliminate candidates, because the check runner is structurally incapable of
reporting its own progress:

- `runner.ts:165` runs all checks under one `Promise.all`, and the print loop
  (`runner.ts:311`) only executes **after it fully resolves**. One hung check
  suppresses the output of all 71 — both incidents printed literally nothing
  despite ~55 checks having succeeded.
- The only surviving evidence was `~/.singularity/check-cache` mtimes, which
  record **completions only**. Completion order under `Promise.all` is just
  fast-checks-first, so it is identical in any run that gets that far — including
  successful ones. It cannot identify a hang.

Reconstructing from cache mtimes narrowed it to 15 candidates and no further:
`conversation-trailer`, `data-view:configs-authored`,
`imperative-create-table-allowlisted`, `migration-hashes-unique`,
`no-hand-built-link-to`, `no-hardcoded-colors`, `no-raw-event-source`,
`no-raw-sse`, `no-raw-websocket`, `no-use-resource-cast`, `orphaned-db-tables`,
`plugin-boundaries`, `reorder:configs-authored`, `type-check`,
`web-artifacts:map-in-sync`.

**Goal of this plan: make the next occurrence name the culprit, with certainty.**
Nothing else. Guardrails (watchdog, starvation reporting) and the fix itself are
deliberately out of scope.

### What the live capture established

`sample` on the wedged process (PID 63550, 98% CPU, state `R`, no children,
816MB footprint / 1.4GB peak) showed the main thread **71% inside the `kevent64`
branch and ~22% in JS execution**. That is not a process blocked in one long
synchronous loop — it is the event loop turning over repeatedly, running short
bits of JS each time.

Consequence: **timers still fire in the wedged process**, so in-process
instrumentation runs and can report on itself while hung. No native debugging,
no symbol recovery, no attaching to a frozen runtime.

The design below does **not** rely on that deduction being correct — see
"Two independent mechanisms".

## Design

One new module plus instrumentation at three points in the runner.

### Durable record file

`~/.singularity/check-progress.jsonl`, one JSON object per line, written with
`appendFileSync` (synchronous and unbuffered, so records survive `SIGKILL` —
both incidents ended in a hard kill).

Path built exactly as its neighbour does today, no new paths plumbing:

```ts
// mirrors checks/core/cache.ts:18
const PROGRESS_FILE = join(SINGULARITY_DIR, "check-progress.jsonl");
```

A plain JSONL is the right channel, not a `defineLogSink` log channel:
`op-log.jsonl` and `paging-probe-<variant>.jsonl` are the established precedent
for offline-read diagnostic files, and staying off `defineLogSink` keeps this
outside `durable-signals-accounted` (which governs log channels only).

Not stdout: `push` pipes the check subprocess through `tail -35`, so incremental
console output would be swallowed anyway — and a file is readable from another
shell *while the process is still wedged*, which is exactly the moment we need it.

Record shapes:

```jsonc
{ "t": "...", "phase": "run",   "runId": "...", "pid": 63550, "worktree": "att-…", "treeHash": "522e50b7…", "scope": "tree", "selected": ["…", …] }
{ "t": "...", "phase": "start", "runId": "...", "checkId": "type-check" }
{ "t": "...", "phase": "end",   "runId": "...", "checkId": "type-check", "durationMs": 1234, "ok": true, "cached": false }
{ "t": "...", "phase": "pending","runId": "...", "elapsedMs": 660000, "pending": ["type-check"] }
{ "t": "...", "phase": "done",  "runId": "...", "elapsedMs": 700000, "allOk": true }
```

`runId` + `pid` + `worktree` on every line because several worktrees write this
file concurrently. Single `O_APPEND` writes under ~4KB are atomic on macOS, so
interleaved runs stay parseable.

### Two independent mechanisms

This is the point of the design, given the hang's nature is still uncertain and
one earlier deduction has already proved wrong:

1. **`start`/`end` records — timer-free.** Written inline, synchronously, as each
   check begins and settles. The culprit is the set difference
   `started − ended`. This works **even if the event loop were fully blocked**,
   because the `start` records are already on disk before the hang begins.
2. **`pending` heartbeat — needs the loop alive.** A `setInterval` (~30s,
   `.unref()`ed so it never holds the process open, cleared in a `finally`)
   appends the currently-unsettled set. This adds a time dimension (how long each
   check has been outstanding) and independently confirms the loop is live.

If the event-loop-alive deduction is right, both fire and corroborate. If it is
wrong, mechanism 1 still names the culprit. Either way we get an answer.

### Runner instrumentation

`plugins/framework/plugins/tooling/plugins/checks/core/runner.ts`:

- **Before the `Promise.all` (~line 165)** — mint `runId`, write the `run` record
  with the selected check ids, start the heartbeat interval.
- **Inside the map callback** — write `start` before the check body runs; write
  `end` in a `finally` so a throwing check still records. This is the essential
  change: recording must happen *as each check settles*, not in the post-`Promise.all`
  loop where the existing `options?.onCheckDone?.()` hook lives (`runner.ts:311`) —
  that hook is exactly what a hang prevents from ever running. Leave it untouched.
- **After the `Promise.all`** — clear the interval, write `done`.

Write failures should throw rather than be swallowed, per the repo's fail-loudly
rule. Tradeoff accepted: a full disk fails check runs loudly instead of silently
losing the diagnostic we are building.

### Reading it

`readCheckProgress()` in the same module: parse the file, group by `runId`, and
for each run return `started − ended`. Surface as `./equin check --status`,
printing the newest run's outstanding set and how long each has been running —
so the answer during an incident is one command, not a Python one-liner over
4,000 cache files (what today's investigation required).

### Retention

Lazy prune on open, mirroring the pattern the `closure-cache` age sweep uses:
if the file exceeds ~5MB, keep the most recent ~2,000 lines. A full run writes
~145 lines, so that is dozens of runs retained at negligible cost.

## Files

| File | Change |
|---|---|
| `plugins/framework/plugins/tooling/plugins/checks/core/progress-log.ts` | **new** — `PROGRESS_FILE`, `writeRecord`, `startHeartbeat`, `readCheckProgress`, lazy prune |
| `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts` | instrument at the three points above (~165, map callback, post-`Promise.all`) |
| `plugins/framework/plugins/cli/bin/commands/check.ts` | `--status` flag → `readCheckProgress()` |

Reuse, do not reinvent: `SINGULARITY_DIR` import and `join` pattern from
`checks/core/cache.ts:18`; the existing `CheckContext`/`options` plumbing in
`runner.ts` for wiring.

## Verification

1. **Happy path** — `./equin check --scope tree` in this worktree, then
   confirm `check-progress.jsonl` holds one `run`, 71 `start`, 71 `end`, and a
   `done`, and that `started − ended` is empty.
2. **Synthetic hang** — temporarily patch one check body to
   `await new Promise(() => {})` (local edit, reverted after). Run again, and from
   a *second shell* while it hangs:
   - `./equin check --status` names that check and nothing else;
   - `pending` heartbeat lines are appended every ~30s naming it — this is the
     direct test of the event-loop-alive deduction;
   - the file is readable and correct while the process is still wedged.
   Then `kill` it and confirm the records written before the kill survived.
3. **Concurrency** — run two checks in different worktrees simultaneously;
   confirm both runs' lines interleave without corruption and `--status` separates
   them by `runId`.
4. **Real confirmation** — the genuine wedge is intermittent, so the true test is
   the next real occurrence. That is the point: at that moment this turns an
   elimination round into a name.

Note the synthetic hang (an idle pending promise) does **not** reproduce the real
wedge's busy-spin, so it validates the mechanism, not the diagnosis. Mechanism 1
is what makes that acceptable.

## Non-goals

- The watchdog / heartbeat-kill, the push-mutex scope reduction, and the
  host-admission starvation report kind — all deferred.
- The reproduction harness (running `check --scope tree` in a loop outside the
  push mutex until it hangs). This plan is a prerequisite for it: with progress
  records in place, that loop yields a name instead of another mtime archaeology
  session.
- Fixing the hang itself, which is unknown until the above lands and fires.
