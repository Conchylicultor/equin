# Push Contention Tracking

## Context

Multiple agents work in isolated git worktrees. When they push (`./equin push`), a system-wide `flock(2)` lock at `~/.singularity/push.lock` serializes all pushes. Currently there is zero observability into this — just two `console.log` lines. We need to instrument the push flow, record timing data, and surface it in:

1. **Debug > Profiling** — Gantt timeline showing recent pushes with wait/step breakdown
2. **Stats** — Aggregate charts (wait time distribution, throughput, step breakdown)

## Data Storage: Append-only JSONL

**File:** `~/.singularity/push-contention.jsonl`

Global (not per-worktree) since all pushes contend on the same lock. CLI appends one JSON line per push attempt. Server reads the file for API endpoints.

Why JSONL over DB:
- Push command currently makes zero HTTP calls — no server dependency
- Server might not be running when push happens
- Follows the `build-profile.json` pattern (CLI writes, server reads)
- Push volume is low (dozens/day), reading entire file is fine
- Concurrent writes are serialized by the flock, so no write races

### Record Schema

```ts
interface PushContentionRecord {
  pushId: string;
  branch: string;
  conversationId: string | null;
  worktree: string | null;
  mode: "worktree" | "from-main";

  // Wall-clock ISO 8601 timestamps
  startedAt: string;
  lockRequestedAt: string;
  lockAcquiredAt: string;
  completedAt: string;

  // Derived durations (ms)
  preLockMs: number;    // lockRequestedAt - startedAt
  waitMs: number;       // lockAcquiredAt - lockRequestedAt (0 = no contention)
  holdMs: number;       // completedAt - lockAcquiredAt
  totalMs: number;      // completedAt - startedAt

  outcome: "success" | "failed_rebase" | "failed_checks" | "failed_push" | "error";

  steps: Array<{
    name: string;       // "fetch", "rebase", "bun-install", "normalize", "checks", "push-branch", "ff-merge", "push-main"
    startMs: number;    // offset from lockAcquiredAt
    durationMs: number;
  }>;
}
```

## Implementation

### 1. Push Profiler Utility

**New file:** `plugins/framework/plugins/cli/bin/push-profiler.ts`

Alongside existing `profiler.ts`. Self-contained, no server dependency.

```ts
createPushProfiler(pushId, branch, mode) → {
  markLockRequested(),    // captures ISO timestamp
  markLockAcquired(),     // captures ISO timestamp
  stepStart(name),        // records wall-clock start
  stepEnd(name),          // computes duration, pushes to steps[]
  complete(outcome),      // captures ISO timestamp
  write(),                // appends JSON line to push-contention.jsonl
}
```

`conversationId` from `process.env.SINGULARITY_CONVERSATION_ID`, `worktree` from `process.env.SINGULARITY_WORKTREE`. `startedAt` captured at construction.

### 2. Instrument `push.ts`

**Modify:** `plugins/framework/plugins/cli/bin/commands/push.ts`

Add `onLockRequested` and `onLockAcquired` callback params to `withPushLock`:

```ts
async function withPushLock<T>(
  fn: () => Promise<T>,
  onLockRequested?: () => void,
  onLockAcquired?: () => void,
): Promise<T>
```

Call `onLockRequested?.()` before the first `ffi.flock`, `onLockAcquired?.()` after lock acquisition.

In the action handler:
- Instantiate profiler after `pushId` is generated
- Pass `profiler.markLockRequested` / `profiler.markLockAcquired` to `withPushLock`
- Wrap each step inside the lock with `profiler.stepStart(name)` / `profiler.stepEnd(name)`
- On rebase failure → `profiler.complete("failed_rebase"); profiler.write()` before `process.exit(1)`
- On checks failure → `profiler.complete("failed_checks"); profiler.write()` before `process.exit(1)`
- On success → `profiler.complete("success"); profiler.write()` before the final log
- Wrap the full `withPushLock` in try/catch for unexpected errors → `profiler.complete("error"); profiler.write()`

Step names — worktree path: `fetch`, `ff-main`, `rebase`, `bun-install`, `normalize`, `checks`, `push-branch`, `ff-merge`, `push-main`.

Step names — from-main path: `fetch`, `rebase`, `bun-install`, `normalize`, `checks`, `push-main`.

### 3. Debug Profiling Sub-Plugin (Push Gantt)

**New plugin:** `plugins/debug/plugins/profiling/plugins/push/`

Follows the exact pattern of sibling `build/`, `boot/`, `stats/` plugins.

```
shared/
  endpoints.ts       GET /api/debug/profiling/push
  index.ts
server/
  index.ts           ServerPluginDefinition (id: "debug-profiling-push")
  internal/
    handle-push-profiling.ts
    read-contention.ts    shared JSONL reader
web/
  index.ts           contributes Profiling.Section({ id: "push", order: 3 })
  components/
    push-section.tsx
package.json
CLAUDE.md
```

**Gantt mapping** — each push becomes a "phase" (row), steps become spans within it:

- `phaseOrder`: pushIds sorted by `startedAt` (most recent last)
- `phaseConfig`: built dynamically from response — label = `"branch (outcome)"`, color by outcome:
  - success → green (`bg-emerald-500`)
  - failed_rebase → red (`bg-red-500`)
  - failed_checks → orange (`bg-orange-500`)
  - error → gray (`bg-gray-500`)
- Special "wait" span (gray) added when `waitMs > 0`
- Timeline origin = earliest `lockRequestedAt` in the window
- Each push's spans offset by `(push.lockRequestedAt - origin)` in ms

Server response adds a `phases` array so the client can build `phaseOrder`/`phaseConfig`:
```ts
{ spans: Span[], totalMs: number, phases: Array<{ id: string; label: string; outcome: string }> }
```

### 4. Stats Sub-Plugin (Push Charts)

**New plugin:** `plugins/stats/plugins/pushes/`

```
shared/
  endpoints.ts       3 endpoints: wait-time, throughput, step-breakdown
  index.ts
server/
  index.ts           ServerPluginDefinition (id: "stats-pushes")
  internal/
    read-contention.ts    (import from profiling plugin? or duplicate — see note)
    handle-wait-time.ts
    handle-throughput.ts
    handle-step-breakdown.ts
web/
  index.ts           contributes 3 Stats.Chart entries
  components/
    wait-time-chart.tsx
    throughput-chart.tsx
    step-breakdown-chart.tsx
package.json
CLAUDE.md
```

**Charts:**

1. **Push wait time** (`BarChart`) — avg + max wait time per bucket. Bucket selector (Day/Week/Month). Shows how long agents wait for the lock.
2. **Push throughput** (`BarChart`, stacked) — pushes per bucket, stacked by outcome (success=green, failed=red). Shows push volume and failure rate.
3. **Push step breakdown** (`BarChart`, stacked) — avg step duration per bucket. Shows which step dominates push time (checks? rebase?).

Import chart primitives from `@plugins/stats-commits/web` (`useFetchJson`, `ChartState`, `fillGaps`, `axisProps`, etc.).

**Note on shared JSONL reader:** Both the profiling and stats plugins need to read `push-contention.jsonl`. Options:
- (A) Duplicate the reader (it's ~15 lines) — simpler, no cross-plugin dependency
- (B) Put the reader in a shared plugin under `plugins/infra/`
- (C) The profiling plugin exports it from its server barrel

Option A is cleanest — the reader is trivial and keeping it duplicated avoids a cross-plugin coupling for a utility function.

### 5. Plugin Registration

No manual registry edits needed. The `generatePluginRegistry` codegen auto-discovers plugins by scanning for `<runtime>/index.ts` files with `export default`. Running `./equin build` handles it.

## Verification

1. `./equin build` — deploys with the new plugins
2. Run 2-3 pushes from different worktrees to populate the JSONL file
3. Verify `~/.singularity/push-contention.jsonl` has correct records
4. Open Debug > Profiling — verify "Push" Gantt section appears with push rows and step breakdown
5. Open Stats — verify push charts appear with data
6. Cause a push failure (e.g. check failure) — verify recorded with correct outcome and visible in both views
