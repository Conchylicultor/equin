# Slow-op contention context + cross-worktree view

## Context

Diagnosing the intermittent shared-Postgres contention storm was hard because the
durable slow-op store records **that** an operation exceeded its threshold (kind,
op, max/last ms, caller span) but captures **none of the contention context** at
the moment it fired, and each worktree writes to its **own** forked DB — so one
cluster-wide storm shows up as ~16 disconnected per-worktree rows with no way to
see they were simultaneous.

Three gaps to close:

1. **No system-context snapshot on a slow span.** Capture box load + cluster-wide
   active Postgres backend count at the instant a span trips its threshold, and
   attach it to the aggregate so "edited-files took 13s" becomes "…while the box
   was at load 38 (12 cores) with 47 active Postgres backends cluster-wide."
2. **No global view.** Each worktree's `slow_ops` lives in its own forked DB. Need
   a cross-worktree fan-out that merges every worktree's rows into one cluster
   aggregate + a time-ordered sample timeline so simultaneity is visible.
3. **Profiler peaks are sticky-since-boot.** The in-memory runtime profiler's
   `max`/aggregates only ever ratchet up since server boot (no recency), which
   misleads "is this happening *now*?". Only the durable store's `lastSeenAt`
   (and the profiler's per-slowest `atMs`) disambiguate — surface that distinction.

### Decisions (confirmed with user)

- **Subprocess signal → OS load average, not an in-process counter.** There is no
  central git-spawn chokepoint, and the real contention sources (CLI `build`/`push`,
  agent worktrees) run in *other processes* an in-process backend counter can't
  see. `os.loadavg()` reflects every process on the box (incl. all git
  subprocesses); `pg_stat_activity` (a cluster-global view) reflects all DB
  clients. Those two are the honest cross-process signals.
- **Sample storage → capped jsonb ring on the existing `slow_ops` row**, mirroring
  the existing `callers` pattern exactly. No new table, no prune job; bounded by op
  cardinality.

## Workstream 1 — Contention snapshot primitive

New server-only infra plugin: **`plugins/infra/plugins/contention/`**.

- `core/snapshot.ts` — `ContentionSnapshotSchema` (zod) + `ContentionSnapshot` type:
  ```ts
  { atTime: Date; loadAvg1: number; loadAvg5: number; loadAvg15: number;
    cpuCount: number; pgActiveBackends: number; pgTotalBackends: number;
    pgTopDatabases: { datname: string; backends: number }[] }  // top ~5 by backend count
  ```
- `core/index.ts` — barrel re-exporting the schema + type (web needs the type to
  render the cluster view).
- `server/internal/snapshot.ts` — `getContentionSnapshot(): Promise<ContentionSnapshot>`:
  - `os.loadavg()` + `os.cpus().length` (in-process, free).
  - One admin query for the pg counts (cluster-wide), via `getAdminPool()`:
    ```sql
    SELECT datname, count(*) FILTER (WHERE state = 'active') AS active, count(*) AS total
    FROM pg_stat_activity WHERE datname IS NOT NULL GROUP BY datname
    ```
    Sum for cluster totals; keep top ~5 by `active` for `pgTopDatabases`.
  - **On-demand memo cache (≤1 s).** Re-derive only when the cached snapshot is
    older than ~1000 ms (lazy timestamp gate, *not* a `setInterval` — satisfies the
    no-polling rule). During a storm many slow ops fire; this collapses them onto
    one cached read instead of N `pg_stat_activity` queries (avoids self-amplifying
    the contention). Wrap the pg read in `runWithoutProfiling` so the snapshot's own
    query never re-feeds the slow-op recorder.
- `server/index.ts` — barrel exporting `getContentionSnapshot` + the `ContentionSnapshot`
  type; `default` routeless `ServerPluginDefinition`.

**Reuse (no new code):** `getAdminPool` is internal to `database/admin`. Add a tiny
export — `countActiveConnections` is already exported from the same module; either
export `getAdminPool` from `plugins/database/plugins/admin/server/index.ts`, or add
a purpose-built `clusterBackendCounts()` helper there and export that (preferred —
keeps the raw pool encapsulated). The `pg_stat_activity` precedent is
`countActiveConnections()` in `plugins/database/plugins/admin/server/internal/databases.ts`.

## Workstream 2 — Stamp the snapshot onto slow-ops (capped jsonb ring)

Mirror the existing `callers` merge precedent throughout.

- **`core/resources.ts`** — add a `SlowOpSampleSchema`:
  ```ts
  { atTime: z.coerce.date(); durationMs: z.number(); snapshot: ContentionSnapshotSchema }
  ```
  Import `ContentionSnapshotSchema` from `@plugins/infra/plugins/contention/core`.
  Add `recentSamples: z.array(SlowOpSampleSchema)` to `SlowOpSchema`.
- **`server/internal/tables.ts`** — add
  `recentSamples: jsonb("recent_samples").$type<SlowOpSample[]>().notNull().default([])`
  (mirrors the `callers` column).
- **`server/internal/record-slow-op.ts`**:
  - Before the transaction, `const snapshot = await getContentionSnapshot()` (cached,
    cheap). It already runs inside `runWithoutProfiling`.
  - Add a `mergeSample(samples, snapshot, durationMs)` ring helper next to
    `mergeCaller`: prepend the new sample, `slice(0, 10)` (keep last 10). Write it in
    the same read-modify-write `tx.update` that already merges `callers` (one update
    sets both `callers` and `recentSamples`).
  - The aggregate row thus always carries the **last 10 contention snapshots** for
    that op — enough to show a storm's shape per op without unbounded growth.
- **Migration** — regenerated by `./equin build` (never hand-write). The new
  jsonb column defaults to `[]`, so existing rows are valid.

This applies uniformly to server spans **and** client (`page-load`/`element`)
signals — a client cold-load slowness now carries the server-side box state it
coincided with.

## Workstream 3 — Cross-worktree cluster view

New sub-plugin: **`plugins/debug/plugins/slow-ops/plugins/cluster/`**.

- **`shared/endpoints.ts`** — `getSlowOpsCluster = defineEndpoint({ route: "GET /api/slow-ops/cluster", response })`.
  Response: `{ worktrees: { name, ok, error?, ops: SlowOp[] }[] }` (raw per-worktree
  rows; the web layer derives the cluster aggregate + timeline so the merge logic is
  testable client-side).
- **`server/internal/handle-cluster.ts`** — fan-out (pull, **user-triggered**, never
  live/polled):
  - `listDatabases()` → for each db name, `openShortLivedClient(name)` → raw
    `SELECT ... FROM slow_ops`. Both already exported from
    `@plugins/database/plugins/admin/server`.
  - Per-DB `try/catch`: on error record `{ name, ok: false, error }` and continue —
    surfaced per-row in the UI (loud-but-resilient; one stale/old-schema fork never
    blanks the whole view). Run the fan-out with bounded concurrency.
  - Stamp `worktree` from the row (already a column) so the merge doesn't depend on
    the DB name.
- **`web/components/cluster-view.tsx`** — `useEndpoint(getSlowOpsCluster)` + a manual
  **Refresh** button (`useEndpointMutation`/`invalidates`). Two sections:
  1. **Cluster aggregate** — group rows by `(operationKind, operation)` across
     worktrees: sum `count`/`totalMs`, max `maxMs`, latest `lastSeenAt`, and the set
     of affected worktrees ("slow across 12 worktrees, 340 total hits"). Reuse the
     `DataTable` shape from `slow-ops-view.tsx`.
  2. **Contention timeline** — flatten every row's `recentSamples` across all
     worktrees, sort by `atTime` desc, one line per sample:
     `time · worktree · kind op · durationMs · load1/cpu · pgActiveBackends`.
     A simultaneous storm shows as a dense time cluster with a high common load /
     backend count — the causal link.
- **Pane placement** — convert the existing single-table pane into a 2-tab host using
  the **`tabbed-view`** primitive: **Local** (the current live `SlowOpsView`, reads
  `slowOpsResource`) and **Cluster** (this fan-out). Keeps related views together and
  is extensible. The `cluster` sub-plugin contributes the Cluster tab; the existing
  table becomes the Local tab.

## Workstream 4 — Sticky-peak vs recency distinction (small)

In **`plugins/debug/plugins/profiling/plugins/runtime/web/components/runtime-section.tsx`**:

- Header already returns `data.sinceMs` from `getRuntimeProfile()` — label the
  Runtime section **"peaks since boot · <relative sinceMs>"** so max/avg columns are
  read as sticky-since-boot, not "now".
- The `slowest` ring carries per-span `atMs` (real recency). If/where slowest entries
  are shown, render `atMs` as `RelativeTime`. Add a one-line pointer that **live
  recency lives in Debug → Slow Ops (last seen)** — the durable `lastSeenAt` is the
  "is it happening now?" signal, the profiler max is not.

No data-model change here — recency already exists (`sinceMs`, `atMs`); this only
surfaces it.

## Critical files

| File | Change |
|---|---|
| `plugins/infra/plugins/contention/core/snapshot.ts` + `core/index.ts` | **new** — `ContentionSnapshot` schema/type |
| `plugins/infra/plugins/contention/server/{index.ts,internal/snapshot.ts}` | **new** — `getContentionSnapshot()` (cached, admin pg query) |
| `plugins/database/plugins/admin/server/{index.ts,internal/databases.ts}` | export a `clusterBackendCounts()` helper (encapsulate the pool) |
| `plugins/debug/plugins/slow-ops/core/resources.ts` | `SlowOpSampleSchema` + `recentSamples` on `SlowOpSchema` |
| `plugins/debug/plugins/slow-ops/server/internal/tables.ts` | `recent_samples` jsonb column |
| `plugins/debug/plugins/slow-ops/server/internal/record-slow-op.ts` | capture snapshot + `mergeSample` ring |
| `plugins/debug/plugins/slow-ops/plugins/cluster/**` | **new** sub-plugin — endpoint + cluster view |
| `plugins/debug/plugins/slow-ops/plugins/pane/**` | refactor to `tabbed-view`; Local tab = existing `SlowOpsView` |
| `plugins/debug/plugins/profiling/plugins/runtime/web/components/runtime-section.tsx` | "since boot" labeling + recency pointer |

## Verification

1. `./equin build` (regenerates the `recent_samples` migration + registry; run
   the type-check + boundary checks it triggers).
2. **Snapshot capture** — generate a slow span (e.g. hit a heavy route / loader), then
   in the worktree DB:
   `mcp__singularity__query_db` →
   `SELECT operation, jsonb_array_length(recent_samples) AS n, recent_samples->-1 AS latest FROM slow_ops ORDER BY last_seen_at DESC LIMIT 5;`
   Confirm `latest` carries `loadAvg1`, `cpuCount`, `pgActiveBackends`, and the ring
   length never exceeds 10.
3. **Cluster fan-out** — open Debug → Slow Ops → **Cluster** tab; click Refresh.
   Confirm rows from multiple worktrees merge into one aggregate, the timeline lists
   cross-worktree samples newest-first, and a deliberately-broken/old fork shows as a
   per-row error rather than blanking the view.
4. **Contention correlation** — drive a multi-worktree storm (parallel
   builds/queries), refresh Cluster, confirm the simultaneous slow ops cluster in
   time with a common elevated `load1`/`pgActiveBackends`.
5. **Recency** — Debug → Profiling → Runtime shows the "peaks since boot" label;
   confirm a freshly-tripped op's `lastSeenAt` in Slow Ops updates while the profiler
   `max` stays a sticky peak.
6. Optional unit test (`bun:test`, co-located): `mergeSample` ring cap + ordering;
   the client-side cluster merge (group-by + timeline flatten).
