# Prompt orphan-build reconcile via boot-adopted artifact watch

## Context

An auto-build restarts the very backend that spawned `./equin build`. The
detached CLI child survives the restart and runs to completion, but the backend
that would have stamped `build_runs.finished_at` is dead. The row is left
`finished_at IS NULL` and is only closed later by the next `reconcileOrphanBuilds`
trigger — which today fires **only** on the next backend boot or the next build
claim. There is **no** independent sweep in between.

Observed: `build-1784330644279-k9y5zp` finished ~23:29 UTC but its row stayed open
until 23:39 UTC (~10 min). Historically the gap is unbounded — rows have sat open
for hours (e.g. `build-1783612667301`: finished ~15:57, closed ~18:41). Throughout
that window any UI reading live state shows a build that appears to still be
running, and the `build_runs_inflight_uniq` lock is held.

The reporting side is already correct (`resolveOrphanTerminal` recovers the true
exit code + finish instant from the CLI's log artifact). This change closes the
**liveness gap**: the row must close *promptly* when the build actually finishes,
not whenever the next unrelated reconcile happens to run.

### Root cause (precise)

1. Backend A spawns the detached `./equin build`; the row's `pid` is swapped
   to the child (`run-build.ts:208`).
2. The build hot-restarts the backend → A dies mid-`await proc.exited`; new backend
   B boots.
3. B's `onReady` runs `reconcileOrphanBuilds()` — but the CLI child is **still
   alive** (it goes on to probe health + finalize), so the row is correctly left
   open.
4. The CLI writes `build-logs-<id>.json` and exits. **Nobody is watching.** The row
   stays open until B reboots or the next build claim.

### Key facts found

- `writeBuildLogs` (`plugins/framework/plugins/cli/bin/build-logs-writer.ts:53`) is
  called **only at the 3 terminal finalize points** in
  `plugins/framework/plugins/cli/bin/commands/build.ts` (lines 1414, 1574, 1648),
  never mid-build, and writes **atomically** (tmp + rename) always carrying
  `finishedAt`. ⇒ **artifact present ⟺ build finished** is a race-free push signal.
- The CLI writes the artifact *after* the gateway confirms backend B is ready
  (`probeHealth`), so B is alive and able to observe the write.
- `file-watcher` primitive: `createFileWatcher({ dirs, onChange, onReconcile?,
  reconcileMs, extensions })` → `{ stop() }`
  (`plugins/infra/plugins/file-watcher/server`). Watches directories; has a built-in
  periodic `reconcileMs` safety timer.
- Build lock = partial unique index `build_runs_inflight_uniq WHERE finished_at IS
  NULL` (`plugins/build/server/internal/tables.ts:37`). Row closed normally at
  `run-build.ts:274-277`; orphan path closed by `reconcileOrphanBuilds`
  (`run-build.ts:113-128`).
- `reconcileOrphanBuilds` currently closes **only** rows whose `pid` is dead. When
  the artifact appears, the CLI pid may still be alive for a moment → a naive
  re-run would miss it.

## Approach — adopt-and-watch on boot (push)

When a backend boots and finds a live in-flight build it does **not** own (the build
that just restarted it), it **adopts** responsibility for closing that row: it arms
a short-lived file-watcher on the build-logs artifact directory. The instant the CLI
writes `build-logs-<id>.json`, reconcile closes the row (<1s), and the watcher
self-disposes. No standalone poller; the existing boot + pre-claim reconciles remain
as backstops.

Two pieces:

### 1. Broaden the reconcile close condition (terminal artifact OR dead pid)

File: `plugins/build/server/internal/run-build.ts`

- Factor a `readBuildTerminal(buildId): { exitCode, finishedAt } | null` out of
  `resolveOrphanTerminal` — returns the recovered terminal record when the artifact
  exists, is parseable, and has a `finishedAt`; else `null`. (`resolveOrphanTerminal`
  keeps its `-1 / now` fallback by calling `readBuildTerminal` and defaulting when
  `null`.)
- In `reconcileOrphanBuilds`, close a row when **`readBuildTerminal(id) != null`
  (build reached terminal, artifact written) OR `!isPidAlive(pid)`** — using the
  artifact's terminal record in the first case, `{-1, now}` for the pid-dead-without-
  artifact hard-kill case. This is safe because the artifact is written exactly once
  at terminal (never mid-build), so "artifact present" can never false-positive a
  still-running build. It also makes the pre-claim reconcile strictly more robust
  (closes an already-finished orphan even if its pid hasn't yet reaped).
- Have `reconcileOrphanBuilds` return whether any in-flight (unclosed, live-pid) row
  remains, so the watcher knows when to stop. (Or expose a small
  `hasLiveInflightBuild()` helper reusing the `isAnyBuildAlive` query with the row id.)

### 2. Arm a boot-adopted watch on the in-flight build

New file: `plugins/build/server/internal/watch-inflight-build.ts`

- `watchInflightBuild(): Promise<void>` —
  1. Query the unfinished row for `currentWorktreeName()` whose `pid` is alive. If
     none, return (nothing to adopt — the initial reconcile already closed it, or
     none exists).
  2. `createFileWatcher({ dirs: [worktreeDataDir(name)], extensions: [".json"],
     reconcileMs: <safety, e.g. 60_000>, onChange, onReconcile })`. Both callbacks
     run `reconcileOrphanBuilds()`, then `await watcher.stop()` once no live in-flight
     build remains. Keep a module-level singleton guard so a second boot-path call is
     a no-op while a watch is live.
  3. **Close the subscription race:** immediately after `createFileWatcher` resolves,
     run `reconcileOrphanBuilds()` once more — the artifact may have appeared during
     `parcel.subscribe` setup (which only reports events *after* subscribing). If that
     closes the row, stop the watcher right away.
- The watcher's built-in `reconcileMs` is the bounded safety net for the rare
  artifact-less hard-kill (build SIGKILLed before finalize): it only ticks while a
  build is genuinely in-flight and stops the moment the row closes — not a global
  poller.

File: `plugins/build/server/index.ts` — in `onReady`, after the existing
`await reconcileOrphanBuilds();` (line 31), add `await watchInflightBuild();` (before
the `isMain()` auto-build re-enqueue block). Runs in **every** worktree backend
(per-namespace state), same scope as the existing reconcile — not `isMain`-gated.

## Critical files

- `plugins/build/server/internal/run-build.ts` — refactor `resolveOrphanTerminal` →
  `readBuildTerminal`; broaden `reconcileOrphanBuilds` close condition + return
  remaining-in-flight signal.
- `plugins/build/server/internal/watch-inflight-build.ts` — **new**; the boot-adopted
  watch.
- `plugins/build/server/index.ts` — call `watchInflightBuild()` in `onReady`.
- Reuse: `createFileWatcher` (`@plugins/infra/plugins/file-watcher/server`),
  `worktreeDataDir` / `worktreeArtifacts.buildLogs` (`@plugins/infra/plugins/paths/server`),
  `isPidAlive` / `_buildRuns` (existing).

## Why not the alternatives

- **Scheduled cron sweep** — the "scheduled pass" the task explicitly wants to avoid;
  leans on polling (against the no-polling rule) and lags up to the interval.
- **CLI self-closes the row** — couples the DB-free CLI to the worktree DB (drizzle +
  tables), reversing the deliberate "pid + artifact are the source of truth" design,
  and still needs a reconciler backstop for hard-kills.

## Verification

1. `./equin build` to deploy.
2. **Repro the orphan + prompt close:** trigger an auto-build (push to `main`, or the
   manual Build button) so the backend restarts mid-build. After the build finishes,
   watch the row close within ~1s of the CLI's terminal artifact write, not minutes
   later:
   ```sql
   SELECT id, started_at, finished_at, exit_code, pid
   FROM build_runs WHERE finished_at IS NULL;   -- via query_db MCP
   ```
   Confirm it's empty shortly after the build's real finish, and that a successful
   build lands `exit_code = 0` with `finished_at` ≈ the build's true finish (not the
   reconcile instant). Compare `finished_at` against `build-logs-<id>.json`'s
   `finishedAt`.
3. **Watcher self-disposes:** confirm no lingering `watch:*` span keeps ticking once
   the row is closed (Debug → Slow Events / profiler), i.e. `watcher.stop()` ran.
4. **Backstops intact:** the boot reconcile (`onReady`) and pre-claim reconcile
   (`doRunBuild`) still close a dead-owner row (kill a build mid-flight without an
   artifact → next boot/claim closes it with `exit_code = -1`).
5. Unit test (`bun test plugins/build/server/internal/`) for `readBuildTerminal` /
   broadened `reconcileOrphanBuilds`: artifact-present-but-pid-alive ⇒ closes from
   artifact; no-artifact-pid-dead ⇒ closes with `{-1, now}`; running build (no
   artifact, pid alive) ⇒ left open.
