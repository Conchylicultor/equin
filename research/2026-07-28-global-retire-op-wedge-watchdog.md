# Retire the op-wedge watchdog and the CLI `--inspect` re-exec

**Status:** planned, 2026-07-28. Pure removal — no replacement detector (user decision).

## Context

`debug/op-wedge-watchdog` was built 2026-07-20 to catch a `./equin {build,check,push}`
that wedged for 8-17h holding host cpu-slots and the global push mutex. It sweeps the op
markers every minute, and for any op past a 15-minute budget it runs capture-then-reap:
`sample`, `lsof`, a recursive process tree, a 60s inspector-attached JSC profiler, then
SIGTERM→SIGKILL of the whole tree. To make the profiler attachable, every CLI op re-execs
itself under `bun --inspect` (`cli/bin/inspect.ts`).

**It no longer detects anything real, and it is actively harmful.**

### Every report it files is a false positive

All 11 `cli-op-wedge` reports filed 2026-07-28 were healthy builds. This includes all three
carrying the `cpu spinning` verdict — its highest-confidence signal. Their specimens:

```
76709  %cpu=123.1  Δratio=0.770  etime=05:53   type-check/shared/worker.ts …web-core-62932.json
90540  %cpu=92.0   Δratio=0.948  etime=01:37   type-check/shared/worker.ts …test-53066.json
30923  %cpu=48.7   Δratio=0.580  etime=04:15   type-check/shared/worker.ts …web-core-6513.json
```

Type-check workers, spawned one to six minutes before capture, doing their job. The
`cpu idle` captures are the same picture: pid 34048's tree held four workers at `etime=01:59`
in state R plus eight retired zombies — a build midway through type-check, killed.

Two independent structural defects, either sufficient:

1. **The trip quantity is not a wedge signal.** `genuineWorkMs = wall − declared admission
   waits`. CPU starvation is not a declared wait, so under host duress a healthy build
   crosses 900s routinely: ~3.5-6 min in the pre-valve phase (48b8's first wait opened at
   `+358337ms`) plus 10+ min in the heavy section. Duress was continuous 13:45→14:52
   (`decompressionsPerSec`, then `loadRatio`). The config's own claim — *"15 min is well past
   any legitimate build on this box"* — was calibrated on a calm box and is now false.
2. **Specimen selection reliably fingers the healthiest process.** It picks the max-CPU member
   of marker∪descendants, which in a build tree is by construction a type-check worker. The
   evidence-based targeting added for the 2026-07-22 m0gj lesson now guarantees a wrong answer.

Two lesser bugs, recorded as further evidence rather than fixed: `isPidAlive` (signal 0) returns
true for a zombie and descendants are signalled before the parent, so any build with `<defunct>`
children reports `some-survived`; and the module-level dedupe `Set` is lost on every main restart,
so `nn1x` pid 28409 was captured twice (14:39:20 and 14:44:32).

### The bug it was built for was fixed structurally

bun 1.3.13's piped-stdio exit-during-stream-pull race, mitigated by `infra/spawn` (temp-file
fds — no stream, no pull promise, nothing to wedge) plus the `no-raw-bun-spawn` chokepoint lint
rule. [`2026-07-22-global-spawn-plugin-wedge-mitigation.md`](./2026-07-22-global-spawn-plugin-wedge-mitigation.md)
states every field wedge observed is this bug. The watchdog is a detector for a defect that has
been designed out of the CLI paths.

### The harm

- **It kills healthy builds.** Three reaped builds recorded `outcome: "failed"` in the op-log.
  A killed build means an undeployed worktree and an agent that rebuilds — more load, into
  duress, producing more over-budget builds. Self-feeding, and it fires hardest exactly when
  the box can least absorb it.
- **The capture is itself a load source, and is duress-exempt.** ~90s per trip (`sample` 10s,
  `lsof` on a 1.4 GB-footprint process, a 60s inspector-attached JSC profiler), five times in
  30 minutes on a swap-thrashing box, deliberately shielded from the shed gate. One probe
  already timed out (`stash-jsc TIMEOUT 10000ms`) — paid the cost, returned nothing.
- **The `--inspect` re-exec doubles the process count for every op.** Measured with five
  concurrent ops: five wrapper processes at 27-34 MB each (~160 MB) whose only job is mirroring
  an exit code, each polling ppid every 2s; nested ops double up (a push spawning a check makes
  a second pair). `inspect.ts`'s *"costs nothing"* was verified as duration on an idle box —
  never footprint under fleet load.

## What we lose, plainly

No automatic wedge detection and no automatic unblocking. If the bun bug (or a new one)
resurfaces, a wedged op again holds its cpu-slots and the push mutex until a human notices and
kills it — the situation before 2026-07-17. Accepted because a detector that is 100% false
positives has negative value: auto-reaping a healthy build costs more than a delayed manual
reap of a real one.

**Diagnosing a suspected wedge by hand afterwards** — the signals that remain, all free:

- `~/.singularity/build-progress.jsonl` and `~/.singularity/check-progress.jsonl` each carry an
  unref'd 30s heartbeat (`phase: "pending"`, gated on in-flight work), so `rg '"phase":"pending"'
  … | tail` shows whether an op's event loop is still running. A wedged loop cannot emit one.
- `./equin check --status` prints the outstanding check unit.
- `~/.singularity/op-log.jsonl` records every op's in-flight state and wait list.
- `~/.singularity/worktrees/<slug>/ops/*.json` names the live pid.

An op-log-based detector was considered and rejected during design: the op-log appends only on
wait open/close and completion (`steps[]` is buffered until terminal), so during a 10-minute
heavy section a healthy build writes nothing — indistinguishable from a wedged one. That is the
same defect being deleted. The progress-log heartbeat is the signal a future detector should use.

## Scope

### 1. Delete the plugin

`plugins/debug/plugins/op-wedge-watchdog/` in full — `core/{config,index,kinds}.ts`,
`server/internal/{capture,monitor-job,op-wedge-kind,probe,read-fleet,reap}.ts` + their tests,
`web/components/op-wedge-summary.tsx`, `scripts/{capture-wedge.sh,inspector-client.ts,
inspector-rpc.ts,js-interrogate.ts}`, `package.json`, `CLAUDE.md`. Then `bun install`
(bun.lock:1734,5885 carry the workspace package).

Deleting `capture.ts` removes its `defineFileSink` from `getGrowthBounds()` automatically —
that registry is merged live from `getFileSinks()`, so there is no accounting to edit. The
on-disk `~/.singularity/op-wedge-captures.log{,.1,.2,.3}` become orphaned (~13 MB, nothing
appends, nothing sweeps); delete them by hand.

### 2. Delete the `--inspect` re-exec

- Delete `plugins/framework/plugins/cli/bin/inspect.ts`.
- **Move `isOpCommand` + `INSPECTED_COMMANDS` into `orphan-guard.ts`** (rename the set
  `OP_COMMANDS`). Its sole surviving caller is the orphan-guard gate, so co-locating deletes the
  file cleanly rather than leaving a one-function module.
- `cli/bin/index.ts`: drop the `./inspect` import (line 2), delete the re-exec block
  (lines 16-21), re-point `isOpCommand` at `./orphan-guard`, and rewrite the lines 23-26 comment
  — there is no wrapper/worker split any more.
- **`installOrphanGuard` at index.ts:27-29 is unchanged and remains correct as the sole guard.**
  It polls `ppid === 1` and makes no assumption about *who* the parent is, so collapsing two
  processes into one leaves it valid; the op process now observes its own orphaning directly.
  The wrapper's SIGTERM→5s→SIGKILL escalation and signal forwarding are pure two-process
  machinery with nothing to preserve.

### 3. Remove the op marker's `inspect` field

`plugins/infra/plugins/worktree/server/internal/worktree-op.ts` — `WorktreeOpInfo.inspect`
(~:65), the `process.execArgv` read and JSON write in `markWorktreeOpStart` (~:106-112, :120),
`MarkerJson.inspect` (~:185) and its coercion (~:203). Verified zero consumers outside the
watchdog. Backward-compatible both directions: `markerInfoFromParsed` already treats an absent
key as `null`, and a stale `inspect` string on a marker already on disk is simply ignored.

`worktree-op.test.ts` — delete the test at :295-320, the assertion at :333, and `inspect: null`
from the `makePush`/`makeBuild`/`makeCheck` fixtures (:35,:38,:41).

### 4. Remove the remaining references

- `plugins/reports/core/sources.ts:18` — drop `"server-op-wedge-watchdog"` from
  `SERVER_REPORT_SOURCES`. Type-level only; the column is not validated on read, so existing
  rows are unaffected. This is the union's first-ever removal.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/no-raw-websocket/check/index.ts:11-15`
  — drop the `op-wedge-watchdog/scripts/` allowlist entry **and its justification comment**.
- `config/debug/op-wedge-watchdog/op-wedge-watchdog.origin.jsonc` and its directory.
- Prose that names the retired instrument (hand-written, not regenerated):
  `plugins/infra/plugins/spawn/core/internal/types.ts:44` (drop the watchdog from the
  "SIGTERM'd by anyone" example — nothing kills ops now) and `plugins/infra/plugins/spawn/CLAUDE.md:76`
  (*"the ceiling stays the fleet's: op-wedge-watchdog's job, not a local timer's"* — now no
  ceiling exists; say so).

### 5. Rewrite the spawn Stage-2 gate

`plugins/infra/plugins/spawn/lint/index.ts:17-20` defers the ~65 server-side spawn sites *"until
Stage 1 demonstrably stops the field `cli-op-wedge` reports"* — an exit criterion that no longer
has an instrument. Replace the clause (and the matching passage at `spawn/CLAUDE.md:98`) with the
honest criterion:

```
   * - Plugin server trees: Stage 2 — the server-side migration (~65 sites) is
   *   deferred until Stage 1 is confirmed to have stopped field wedges. The
   *   automated instrument that was to confirm it (the `cli-op-wedge` report) was
   *   retired 2026-07-28 — every row it ever filed was a false positive; see
   *   research/2026-07-28-global-retire-op-wedge-watchdog.md. The criterion is now
   *   the absence of an observed field wedge (an op that never returns / a
   *   gridlocked fleet), diagnosed by hand off the progress-log heartbeat.
   *   Tracked by the Stage-2 follow-up task. TEMPORARY: each batch shrinks this glob.
```

The `ignores` array itself is unchanged.

### 6. Delete the stale report rows

73 `cli-op-wedge` rows on main, oldest 2026-07-21, **1 with a linked `task_id`**. With the kind
unregistered they still render (the list has an explicit `report-summary-fallback` → `report.message`),
but `investigate.ts:69-78` throws for an unregistered kind, so "File task" 500s. Un-investigated
rows self-sweep after 7 days; investigated ones persist forever.

Delete them rather than carry a tombstone kind — but **not all 73**. Two findings during
implementation narrowed this:

1. `reports/server/internal/retention.ts` already sweeps at `ttlDays: 7` scoped
   `where: isNull(_reports.taskId)`, and its comment names that scope a *safety* scope:
   *"Deleting a report row with a non-null `taskId`"* breaks the link an investigation task
   depends on. So the 72 un-investigated rows **self-sweep within 7 days with no action**, and
   the 1 investigated row (`report-1784891236989-it15vn` → task `[cli-op-wedge]
   att-1784889377-l5m3 build wedged 24m`) should be **kept** — deleting it would strip the
   evidence out from under a live task, against the engine's own documented policy.
2. The `query_db` MCP tool is read-only by design (mutations rejected at the DB level), so no
   agent can execute this; it needs a human at `psql`.

**Resolution: do nothing.** Retention clears the noise on its own, the investigated row is
correctly preserved, and no destructive DB write is needed. Should a manual purge ever be wanted,
it must exclude the investigated row:

```sql
DELETE FROM reports WHERE kind = 'cli-op-wedge' AND task_id IS NULL;
```

Likewise the orphaned `~/.singularity/op-wedge-captures.log{,.1,.2,.3}` (13.8 MB) are **kept**:
they are the forensic evidence behind this retirement, they are bounded (nothing appends now),
and deleting them alongside the rows would erase the entire evidence trail.

## Ordering

One reviewed change; nothing here has a broken intermediate as long as §1 and §4's `sources.ts`
edit land together (removing the source string alone breaks the plugin's tsc; deleting the plugin
alone leaves a dangling union member). Sequence within it:

1. Delete the watchdog plugin + `sources.ts` + the `no-raw-websocket` exemption + the config origin.
2. Delete `inspect.ts`, move `isOpCommand`, rewire `index.ts`.
3. Strip `inspect` from `worktree-op.ts` + its tests.
4. Rewrite the Stage-2 gate and the spawn prose.
5. `bun install`, then `./equin build`.
6. Delete the stale rows and the orphaned capture logs.

**Immediate mitigation, before any of this deploys:** set `reap: false` and `capture: false` in
Settings → Config → `op-wedge-watchdog`. The job reads config live each tick, so this stops the
reaping and the ~90s captures within a minute, with no build.

`./equin build` regenerates (never hand-edit): `server.generated.ts`, `web.generated.ts`,
`docs/plugins-{details,compact}.md`, and the `## Plugin reference` block in every affected
`CLAUDE.md` (`plugins/debug/`, `plugins/reports/`, `infra/plugins/worktree/`, `infra/plugins/spawn/`, …).

## Verification

1. **`./equin check`** — the real gate. `type-check` catches the `sources.ts` union removal
   and every dangling `inspect` reference; `plugin-boundaries`, `plugins-registry-in-sync` and
   `plugins-doc-in-sync` catch an incomplete deletion or stale codegen.
2. **`bun test plugins/infra/plugins/worktree/server/internal/worktree-op.test.ts`** — the marker
   suite still passes with the `inspect` assertions removed.
3. **One process per op.** Run `./equin build` in a scratch worktree and confirm the wrapper
   is gone:
   ```bash
   ps -axo pid=,ppid=,rss=,command= | grep 'cli/bin/index.ts' | grep -v grep
   ```
   Expect exactly one row per op (was two), with no `--inspect=` in the command line.
4. **Ctrl-C still works, and orphaning still terminates.** `./equin build`, then `^C` —
   it must exit gracefully and release the build lock (`~/.singularity/worktrees/<slug>/ops/build.json`
   cleared). Then start a build from a subshell, kill the parent shell, and confirm the op exits
   via the surviving `installOrphanGuard` (`ORPHAN_EXIT_CODE`) rather than lingering.
5. **The op marker is still well-formed** — after a build starts, `cat ~/.singularity/worktrees/<slug>/ops/build.json`
   has `pid`/`phase`/`startedAt` and no `inspect` key; the conversation op-status pane (the other
   `WorktreeOpInfo` consumer) still renders.
6. **No new reports** — `SELECT count(*) FROM reports WHERE kind = 'cli-op-wedge'` stays 0 after
   a full build cycle.
