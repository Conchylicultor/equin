# Unified op status: one event log, one read model, two live surfaces

Page: *Build, check,...* → CLI → Monitoring (`block-f0d24b10-d743-409d-bbc1-844ed27db026`),
todo `block-4af9395c` ("where does lock/monitoring report things?").

## Context

On 2026-09-29 a build in `att-1790593649-s5ol` took 2h03. The conversation banner said
`Build in progress · 1:31:47` the whole time. The op log knew better: 13 waits across 6 requeue
cycles, about 64 min in `host-grant` and 42 min in `duress-valve`.

Today op status lives in two unsynchronised records, and the rich one never reaches a live surface:

| Record | Holds | Read by |
|---|---|---|
| Marker `worktrees/<wt>/ops/<kind>.json` | kind, pid, `waiting-for-lock`/`running` | banner + chip (live, via file watcher) |
| `~/.singularity/logs/op-log/op-log.jsonl` | every wait (`openWait`), outcome, steps | Ops Gantt (endpoint, **not live**), stats/pushes, `await`, build-lock waiter |

The marker flips to `running` at the per-worktree build lock, so every wait after that point
looks like work. Writers are CLI processes and must never depend on the DB (a build may be
building it).

**Outcome:** the op log is the single write path, written as change-only events. Every backend
ingests it into a DB read model. The banner/chip and the Ops view read the same rows, live,
including what an op is waiting on, why, which requeue cycle it is in, and waited vs worked time.

Decisions (user-approved 2026-09-29): pid-level liveness marker; DB table for history;
change-only events; build-progress / check-progress stay out of scope (a later phase folds them in).

Refinements from design review:
- **The terminal event is self-contained** (a summary line). A clipped 8 MB tail still folds a
  full record, and `await` / stats need identity and steps on the terminal.
- **The marker is per op and flock-held** (`ops/<opId>.json`), not per (slug, kind). This is
  safe against pid reuse and exact per op. It replaces the push-holder file and its flock probe.
- **Every serving backend ingests into its own DB,** not only main. A DB fork copies the cursor
  and rows in one snapshot, so a worktree deploy resumes where main was. A main-only ingester
  would leave worktree DBs with stale in-flight rows copied at fork time.
- **The DB side is a new child plugin** `op-log/plugins/op-store`. The CLI imports
  `op-log/server` (profiler, `readOpenWait`), so adding tables there would pull the database
  module into every CLI process.

## Design

### 1. Event schema (`op-log/core/internal/types.ts`)

```ts
type OpLine = OpEvent | RawOpRecord;          // RawOpRecord = legacy snapshot (has `phase`)
interface EventBase { v: 2; opId: string; seq?: number; at: string /*ISO*/; t?: number /*ms since requested, monotonic*/ }
type OpEvent = EventBase & (
  | { e: "requested"; kind: OpKind; opSlug: string|null; branch: string; conversationId: string|null;
      lane: Lane|null; mode: ...; buildId: string|null; pid: number }
  | { e: "wait-start"; wait: WaitKind; reason: string|null; cycle: number }
  | { e: "wait-end"; wait: WaitKind; startMs: number; durationMs: number;
      result: "acquired"|"cleared"|"fail-open"|"aborted" }
  | { e: "requeue"; cycle: number; cause: "duress" }
  | { e: "granted" }
  | { e: "completed"; by: "self"|"reconciler"; summary: OpSummary });   // self-contained
```

- `OpWait` / `OpenWait` gain `reason`, `cycle` and `result`.
- `WAIT_KINDS` is plain data in core, like `OP_KINDS`: a label and a sentence per wait kind, for
  example `duress-valve` → "held: host under duress (loadRatio)".
- Any one op is entirely one format, because a CLI process keeps its code for its life. Legacy
  lines keep folding until Phase 5.

### 2. One reducer shared by the CLI and the server (`op-log/core/internal/fold.ts`)

`applyOpEvent(state, line)`, `foldOpLines(lines)`, `toOpRecord(state, now)`, and
`liveTimes(state, now) → {elapsedMs, waitingMs, workingMs, openWaitMs}`.

Rules:
- A terminal wins, and every event after it is ignored, so duplicate reconciler terminals are harmless.
- A non-terminal event applies only when `seq > lastSeq`, which makes re-ingest idempotent.
- A legacy line folds with today's snapshot semantics.

`readOpRecords`, `readOpenWait`, `await` and `observeBuildHolder` stay on the file through this
reducer. `liveTimes` is the only place waited/worked time is computed, for both web and CLI.

### 3. Writer (`op-log/server/internal/profiler.ts` + call sites)

- The profiler emits deltas with a per-op `seq`, `t` and `pid`. It no longer re-stamps
  snapshots, and the terminal line carries the summary.
- `waitStart(kind, reason?)` and `waitEnd(result?)`.
  - `build/cli/run.ts` (~l.1340): the valve's `onHoldStart(reason)` / `onHoldEnd(outcome)` are
    forwarded to them. Today the reason and fail-open are dropped.
- `profiler.requeue()`. `acquireAndRunHeavySection` in `build/cli/internal/app-artifacts.ts`
  (~l.1040) gets a loop counter and an `onRequeue(cycle)` hook.
- Fast-path grant (`grantHooks().onAcquired(waitMs>0)` with no prior `onWaitStart`) emits one
  self-contained `wait-end`.

### 4. Liveness marker (`infra/worktree/server/internal/worktree-op.ts`)

- The file is `worktrees/<slug>/ops/<opId>.json` = `{v:2, kind, opId, pid, startedAt}`.
- It is written to a temp file, `flockTry`'d (`packages/flock`), then renamed into place, and held
  for the op's life. The kernel releases the lock on death, including SIGKILL.
- `markWorktreeOpStart(slug, kind, opId)` returns a release handle.
- `listWorktreeOps` / `isWorktreeOpActive` keep their shape, minus `phase` and `runningAt`.
  Liveness is the flock probe, and dead files are reaped on list.
- CLI ordering in `direct-op.ts`, build (~l.712/745) and push (~l.420):
  1. publish the locked marker;
  2. append `requested`;
  3. on exit, append `completed` **before** unlinking the marker.

  `direct-op`'s `onExit` currently has these in the opposite order.
- Deleted: `setWorktreeOpPhase`, `WorktreeOpPhase`, `resolveActiveWorktreeOps`, `derivePushPhases`,
  the push-holder file, `pushLockHeld`.
- Unchanged callers: `await` (kind, opId, pid), runtime-tmux, stop-guard.

### 5. op-store plugin (`plugins/debug/plugins/profiling/plugins/op-log/plugins/op-store/`)

**Tables** (`server/internal/tables.ts`)

`op_log_ops` has one row per `op_id`:
- identity: `kind, op_slug, branch, conversation_id, lane, mode, build_id, pid`;
- timing: `requested_at` (not null), `granted_at`, `completed_at`;
- result: `outcome, interrupted, closed_by`;
- waits: `waits` jsonb (closed waits), `open_wait` jsonb, `cycle`, `closed_wait_ms`;
- `hold_ms, total_ms, steps` jsonb, `last_seq, updated_at`.

Indexes: `(requested_at desc)`, `(op_slug, requested_at)`, `(kind, requested_at)`, and a partial
index `(requested_at) WHERE completed_at IS NULL`. Waiting ms is not stored, because it changes
with `now`.

`op_log_ingest_cursor(source pk, inode, offset, gap_at, updated_at)`.

Retention: `defineRetention({column: "requestedAt", ttlDays: 30, perWorktree: true})`. `build_runs`
stays separate: it is the build lock/ledger, per namespace.

**Ingester** (`server/internal/ingest.ts`, started from `onReady` on every serving backend)
- Wake: `createFileWatcher` on `dirname(OP_LOG_FILE)`, filtered to `op-log.jsonl*`, plus
  `onReconcile` (30 s) as a missed-event backstop.
- Drain: serialized with the draining/rerun pair from `reports/outbox/.../watcher.ts` and
  `runTracked`.
  1. `fstat` (bigint) gives inode and size.
  2. Same inode as the cursor: read from the offset.
  3. Inode changed: find the cursor's inode among `.1..3`, finish that file, then read each newer
     rotation, then the live file from 0.
  4. Inode not found: set `gap_at` and start the live file at 0.
  
  Always open the file, then verify its inode by fd. Read in about 1 MB chunks with a
  StringDecoder (the `supervised-job/.../tail.ts` pattern), and advance only past the last `\n`.
- Per batch, one transaction under `pg_try_advisory_xact_lock`: SELECT the touched rows, apply
  `applyOpEvent`, upsert, advance the cursor.
- First boot with no cursor: seed from the last 16 MB of the live file, then set the cursor to EOF.
- Boot order: drain, then reconcile, then start the watchers.

**Reconciler** (`server/internal/reconcile.ts`)
- Candidates: in-flight rows. An op is dead when its marker is absent or unlocked. During the
  transition, a legacy marker counts as live only when it matches `opId` and its pid is alive.
- **Main only** appends `{e:"completed", by:"reconciler", summary:{interrupted:true, outcome:"error"}}`
  to the file, so every DB and `await` learn it the same way.
- Non-main, only after a gap: close dead rows locally with `closed_by: "ingest-gap"`.
- Runs after each drain, on marker-directory events, and on the reconcile tick. A SIGKILL leaves
  no filesystem event, so the tick is what catches it, within about 30 s, as today.
- Deletes `finalizeOrphanedOps` and its `onReady` in `ops/server/index.ts`, including its
  slug-level coarseness.

**Live collections** (`core/`)
- `opsInFlight = liveCollection("op-store.in-flight", {id: "opId", filterable: {opSlug, kind},
  default: {orderBy: requestedAt asc, limit: 200}, maxLimit: 500, preload: "boot"})`, served
  with `where: isNull(completedAt)`. It is one default-tuple subscription; consumers filter by
  slug on the client.
- `opsHistory` covers the same table with no base filter:
  - filterable: `opSlug, kind, outcome, requestedAt: liveInstant(), completedAt: liveInstant()`;
  - default `requestedAt desc`, limit 500, maxLimit 2000.

### 6. Surfaces

**Banner** (`op-status/web/components/op-status-banner.tsx`, reading `opsInFlight`)

For this worktree's ops, pick one by `OP_RANK` and show the rest as "+N".

- Waiting: `Build — held: host under duress (loadRatio) · requeue #6 · 12:03`.
- Working: `Build — Building`.
- Right side: total elapsed, plus `waited 1h22 · worked 9m` from `liveTimes`.
- The warning tone applies whenever `openWait != null`, not only before the lock.

The expanded list shows:
1. The push queue: #1 is the push with `granted_at` and no terminal; then the `push-mutex`
   waiters, by `openWait.startedAt`.
2. Every other op, by `requestedAt`, each with the same state line.

**Chip:** an hourglass whenever `openWait != null`; the tooltip is the summary line.

`op-status/server/*` and `shared/schemas.ts worktreeOps` are deleted.

**Ops Gantt / detail** (`debug/profiling/ops`)
- `useLive(opsHistory, {where: requestedAt >= quantizedCutoff})`. Quantize the cutoff to 5 min so
  the subscription is stable.
- Worktree mode is two reads: that slug's ops, then the window from their min/max ± 20 min.
- Offsets are computed on the client; open waits grow with `useNow`.
- Detail = `useLiveRow(opsHistory, opId)`.
- Worktree titles: reuse the banner's `useTitleBySlug` lookup.
- `handle-op-profiling.ts`, `handle-op-detail.ts` and their endpoints are deleted.

**stats/pushes:** `read-pushes.ts` and the throughput / wait-time / step-breakdown handlers become
SQL over `op_log_ops` (`jsonb_array_elements` for waits and steps).

## Phases (each one builds and works on its own)

0. **Reducer.** New types, `applyOpEvent`/`foldOpLines`/`toOpRecord`/`liveTimes`, `WAIT_KINDS`.
   `readOpRecords`/`readOpenWait` move onto them. No behaviour change.
1. **Writer.** Delta events, reason / fail-open / requeue plumbing, summary terminal. Every
   existing reader keeps working through the file fold.
2. **op-store.** Tables, cursor, ingester, reconciler (pid fallback), collections, retention.
   No UI consumer yet.
3. **UI switch.** Banner and chip, Gantt and detail, stats/pushes onto the DB. Delete the old
   value and endpoints.
4. **Marker shrink.** Per-op flocked markers, the CLI ordering fix, delete the push holder and
   the phase API; the reconciler moves to flock liveness.
5. **Cleanup (about 2 weeks later).** Remove legacy snapshot folding, legacy marker names and the
   slug fallback.

## Risks

- **N-backend ingest** means N change-feed fan-outs per event. That is under 1 event/s host-wide,
  but measure it under duress.
- **Boot race:** the boot-preloaded in-flight rows may be stale until the first drain. The drain
  runs first in `onReady`.
- **Orphan closure depends on main.** While main is down, worktree banners keep dead ops.
- **CLI ↔ browser clock skew:** clamp live durations at 0.
- **Mid-rollout**, old CLI processes still write legacy lines and markers, so every reader
  accepts both until Phase 5.
- **Boundary:** the op-store server barrel must never be reachable from CLI imports.

## Verification

- **Unit tests** (`./equin test plugins/debug/plugins/profiling/plugins/op-log`):
  - reducer: legacy fixtures, seq idempotency, terminal wins, events after the terminal, headless
    op, requeue/fail-open, `liveTimes`;
  - profiler event sequence;
  - pure `planSegments(cursor, stats[])` for rotation, gap and truncation;
  - ingest on a temp-dir sink: rotation between drains, a partial last line, re-drain idempotency;
  - reconciler with injected liveness;
  - marker: flock held and released on process exit.
- **Real run:** start a `./equin check` while a build is queued, then `query_db` on
  `op_log_ops` shows `open_wait` / `cycle` updating, and the row closes on completion.
- **E2E** (`op-status/e2e/op-status-waits.ts`):
  1. Hold a flocked marker for a synthetic opId (branch `e2e-synthetic`).
  2. Append `requested` and `wait-start duress-valve reason=loadRatio cycle=2`; assert the banner
     text and the chip hourglass.
  3. Append `wait-end` and `granted`; assert "Building".
  4. Append `completed`; assert the banner is gone and the row is in `opsHistory`.
  5. Kill variant: release the flock without a terminal; assert an interrupted close within 35 s.
- `./equin check` passes: boundaries, migrations-in-sync, plugins-doc-in-sync.
