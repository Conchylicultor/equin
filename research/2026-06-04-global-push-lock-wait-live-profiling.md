# Live "waiting for push lock" in push profiling

## Context

The push lock (`~/.singularity/push.lock`, an `flock`) serializes the critical
section of `./equin push` across all concurrent agents. When two agents
push at once, one blocks on `ffi.flock(fd, LOCK_EX)` until the other finishes.

The push profiler **already** records lock-wait time (`waitMs =
lockAcquiredAt − lockRequestedAt`) and the Gantt **already** renders it as a
yellow "lock wait" bar. The problem: the profiler writes its **single record
only when the push completes** (`profiler.write()` runs at the very end). So a
push that is *currently blocked on the lock* has **no record at all** — you
cannot open Debug > Profiling > Push and see "agent X has been waiting 40s for
the lock right now." Waiting is only ever visible retrospectively.

**Goal:** make an in-flight waiter observable the moment it starts waiting, so
one can monitor how much agents are contending on the lock live.

**Approach:** mirror the build-log precedent (commit `f0865912c`), which solved
the identical "in-flight visibility" problem by writing phased `started` /
`completed` records plus an orphan reconciler. Push gets **three** phases —
`lock_requested`, `lock_acquired`, `completed` — so the reader can distinguish
*waiting for the lock* from *acquired, now running*.

## Design

Records are appended to `~/.singularity/push-contention.jsonl` (unchanged file).
Today: one terminal record per push. New: up to three phased records per push,
merged by `pushId` at read time. Legacy records (no `phase`) are treated as
terminal, so old data renders unchanged.

| Phase | Written when | Carries |
|-------|--------------|---------|
| `lock_requested` | `markLockRequested()` (just before `flock`) | full identity + `opSlug` + `startedAt` + `lockRequestedAt` |
| `lock_acquired` | `markLockAcquired()` (lock granted) | `pushId` + `lockAcquiredAt` |
| `completed` (terminal) | `write()` (success / failure / error) | everything (today's record) + `phase` + `opSlug` |

At read time, per `pushId`:
- **terminal present** → use it as-is (today's behavior, exact).
- **`lock_requested` only** → synthesize `outcome: "waiting"`,
  `waitMs = now − lockRequestedAt` (grows on every refresh), `holdMs = 0`.
- **`lock_requested` + `lock_acquired`** → synthesize `outcome: "running"`,
  `waitMs = acquired − requested` (fixed), `holdMs = now − acquired` (grows).

`now = Date.now()` in the server reader makes the bars grow live across the
existing manual `refreshKey` re-fetch — **no polling/interval added** (complies
with the no-polling rule; auto-refresh is explicitly out of scope).

**Why `opSlug` (new field):** the orphan reconciler checks liveness via
`isWorktreeOpActive(slug)`, which is keyed on `basename(worktree root)` (the
op-marker slug). The existing `worktree` field is `env SINGULARITY_WORKTREE`,
which may **not** equal the op slug. So the op slug must be carried explicitly.

## Files to change

### 1. `plugins/framework/plugins/cli/bin/push-profiler.ts` (core)
- Add `phase?: "lock_requested" | "lock_acquired" | "completed"`, `opSlug: string | null`, and `interrupted` (for reconciled orphans) to `PushContentionRecord`. Widen `outcome` with `"waiting" | "running"`.
- Add `opSlug` param to `createPushProfiler(pushId, branch, mode, opSlug)` — pass it in, do **not** compute git inside the profiler.
- Add a private `appendRecord(partial: Partial<PushContentionRecord>)` doing `mkdirSync` + `appendFileSync`.
- `markLockRequested()` → set `lockRequestedAt`, then append a `lock_requested` record (full identity + `opSlug` + `startedAt` + `lockRequestedAt`).
- `markLockAcquired()` → set `lockAcquiredAt`, then append a minimal `lock_acquired` record (`pushId` + `lockAcquiredAt`).
- `write()` → unchanged fields, but tag `phase: "completed"` and include `opSlug`.

### 2. `plugins/framework/plugins/cli/bin/commands/push.ts`
- Compute `const opSlug = basename(root0)` (already done at line ~282) and pass it into `createPushProfiler(...)` at line ~271. No other logic change — both `withPushLock` call sites already route through `profiler.markLockRequested` / `onLockAcquired`.
- **Preserve** existing behavior: a failure *before* `withPushLock` (bad branch, dirty tree without `-m`) writes no record — fine, it never contended.

### 3. `plugins/debug/plugins/profiling/plugins/push/server/internal/read-contention.ts`
- Add `RawPushRecord` (optional `phase`, optional numerics, `opSlug`, `interrupted?`); add `interrupted: boolean` and `"waiting"|"running"` to the public `PushContentionRecord`.
- Rewrite `readContentionRecords()` to group raw records by `pushId` and fold into one synthesized record using the merge rules above (terminal wins; else synthesize waiting/running with `Date.now()`).
- Add `finalizeOrphanedPushes(isActive)` mirroring `finalizeOrphanedBuilds`: for each `pushId` whose latest state is non-terminal and whose `opSlug` is **not** active, append a terminal `{ phase: "completed", outcome: "error", interrupted: true, completedAt: null, ... }` record. Append-only, never rewrite.

### 4. `plugins/debug/plugins/profiling/plugins/push/server/index.ts`
- In `onReady` (keep the `isMain()` gate), call `finalizeOrphanedPushes(isWorktreeOpActive)` next to the existing `finalizeOrphanedBuilds(...)`. Update the comment to mention pushes.

### 5. `plugins/debug/plugins/profiling/plugins/push/server/internal/handle-push-profiling.ts`
- Add `interrupted` to the local `PushEntry` and pass `record.interrupted` through (line ~144). `outcome` passes through unchanged (now may be `waiting`/`running`). `originMs`/`totalMs` already use `waitMs`/`holdMs` — works for synthesized records with no change.

### 6. `plugins/debug/plugins/profiling/plugins/push/plugins/push-gantt/web/components/push-gantt.tsx`
- Add `interrupted: boolean` to the exported `PushEntry`.
- Add `OUTCOME_STYLES` entries: `waiting` (`bg-warning`, zero-width hold bar so only the growing yellow wait bar shows) and `running` (`bg-info`, fixed wait bar + growing hold bar).
- When `push.interrupted`, render a fixed-width marker at `push.startMs` (reuse the existing `INTERRUPTED_MARKER_PX` / `BUILD_INTERRUPTED_COLOR` pattern already used for builds) instead of the wait/hold bars.
- `push-section.tsx` needs no change (consumes `PushData` from the gantt barrel).

## Verification (end-to-end)

1. **Hold the lock**: start a real long push in worktree A (or a throwaway `bun -e` that opens `~/.singularity/push.lock` and `flock(LOCK_EX)` then sleeps) so the lock is held.
2. **Contend**: in worktree B run `./equin push -m "y"`. It prints "Another push is in progress — waiting for lock..." and blocks. A `lock_requested` record is now on disk.
3. **See it live**: open Debug > Profiling > Push, hit refresh — worktree B shows a yellow "lock wait" bar (`waiting`). Refresh again a few seconds later: the bar has **grown**.
4. **Acquire**: release A. B acquires → `lock_acquired` appended. Refresh: row flips to `running` (fixed wait bar + growing hold bar).
5. **Complete**: B finishes → terminal `completed` record; row renders the real outcome and final durations.
6. **Orphan**: start a waiting push, `kill -9` it. On the next main-backend `onReady`, `finalizeOrphanedPushes` sees the dead pid (`isWorktreeOpActive` self-heals to false) and stamps a terminal `interrupted` record → row renders as a fixed interrupted marker.

Run `./equin build` to deploy, then verify in the worktree app. Use
`bun plugins/framework/plugins/cli/bin/index.ts check` (tsc + boundaries + lint)
during development.

## Risks / edge cases
- **`opSlug` vs `worktree` divergence** — reconciler keys liveness on `opSlug` only. Null `opSlug` → treated inactive (closes the orphan), acceptable.
- **Interleaved concurrent writers** — grouping by `pushId` is interleave-safe; partial final lines tolerated by the existing `JSON.parse` try/catch; append-only + `isMain()`-gated reconciler avoids rewrite races.
- **Legacy no-`phase` records** — treated as terminal; render exactly as before, no migration.
- **`Date.now()` in reader** — intended; it is what makes the bar grow. Normal server runtime (not a workflow script), so allowed.
