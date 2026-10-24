# Generic report-kind registry + durable slow-ops store

## Context

Slow-operation auto-reporting (commit `7a33ed8d7`) bolted slow-op-specific behaviour onto the
`reports` plugin: nullable columns on the shared table (`operation_kind`, `operation`,
`duration_ms`, `threshold_ms`), `kind === "slow-op"` branches in `record-report.ts`
(fingerprint dispatch, upsert `set`, `taskDescription`), a `KIND_META["slow-op"]` entry, and a
field-sniffing branch in the debug view. Adding a kind today means editing five places — the
exact "collection leaks into consumers" anti-pattern CLAUDE.md forbids.

Two problems surfaced in review:

1. **No caller attribution.** A slow `db` query is reported as a bare SQL label with no record
   of *which request/loader ran it*. The runtime-profiler already tracks this (`SlowSpan.parent`,
   `Aggregate.byParent`) but the reports path drops it.
2. **One task per slow-op fingerprint, no global overview.** Slow ops are metrics that often hide
   *structural* issues (five slow routes bottlenecked on one query); they need an aggregate,
   ranked surface, not scattered sibling tasks.

This change makes `reports` a **generic kind registry** that knows nothing about crashes or slow
ops, moves slow-op **data** into its own durable store with caller attribution, and gives slow
ops a dedicated ranked debug view. Crash and slow-op both become registered contributions.

**Decisions locked with the user:** durable store (new plugin); reports files a single rollup
task for slow ops; full generic registry (crash migrated to a contribution too); per-kind payload
stored in a generic `data jsonb` column validated by each kind's Zod schema.

## Goals / non-goals

- **Goal:** `reports` core has zero `kind === "..."` branches and zero kind-specific columns.
- **Goal:** durable, restart-surviving slow-op store with per-operation caller breakdown, ranked
  by aggregate impact, in a dedicated Debug pane.
- **Goal:** a single deduped rollup task for slow ops; per-crash tasks unchanged.
- **Non-goal:** multi-level parent chains. `SlowSpan.parent` is one level (`SpanRef | null`); that
  already resolves the main gap (which request ran the slow query). Deeper chains would need
  recorder changes — out of scope.
- **Non-goal:** backfilling existing report rows. Reports are per-worktree debug ephemera; the
  column-drop migration is destructive and that is acceptable.

## Architecture

Mirrors the existing reports topology (`plugins/reports/` engine + `plugins/debug/plugins/reports/`
view):

| Concern | Home |
|---|---|
| Generic report engine + kind registry | `plugins/reports/` (refactored) |
| Crash kind (data + fingerprint + rendering + client wiring) | `plugins/reports/plugins/crash/` (new) |
| Durable slow-op data store + subscriber + resource + slow-op kind | `plugins/slow-ops/` (new, top-level) |
| Slow-op ranked overview | `plugins/debug/plugins/slow-ops/` (new) |
| Old slow-op adapter | `plugins/reports/plugins/slow-ops/` (deleted, redistributed) |

### 1. Generic `ReportKind` registry — `plugins/reports/`

Use `defineServerContribution` (`plugins/framework/plugins/server-core/core/contributions.ts`) —
the same primitive `ReportNoiseRule` already uses inside this plugin.

New `plugins/reports/server/internal/report-kinds.ts`:

```ts
export interface ReportKindSpec<TData = unknown> {
  kind: string;
  schema: z.ZodType<TData>;                 // validates the jsonb payload on ingest
  fingerprint(data: TData): Promise<string> | string;  // dedup strategy
  meta: { tag: string; notif: string; variant: BadgeVariant };
  renderTask(row: ReportRow): { title: string; description: string };
}
export const ReportKind = defineServerContribution<ReportKindSpec>("report-kind",
  { docLabel: (k) => k.kind });
```

`recordReport` becomes fully generic:
`recordReport({ kind, source, data, message?, url?, userAgent? })` →
`const spec = ReportKind.getContributions().find(k => k.kind === kind)` (throw loudly if missing) →
`spec.schema.parse(data)` → `fp = await spec.fingerprint(data)` → upsert by `(fingerprint, worktree)`
storing `data` as jsonb → generic velocity/noise → `ensureTaskForReport` using `spec.renderTask` and
`spec.meta` → `reportsResource.notify()`. No `KIND_META`, no per-kind branches.

**Web side:** a parallel kind-view registry so the debug list delegates per-kind rendering. Add a
`Reports.KindView` web slot (mirror an existing `defineRenderSlot`) carrying
`{ kind, renderSummary(report): ReactNode }`; `debug/reports` looks up by `report.kind` instead of
sniffing `c.errorType` / `c.operationKind`.

Files touched:
- `core/resources.ts` — `ReportSchema`: drop kind-specific fields, add `data: z.unknown()`.
- `shared/endpoints.ts` + `shared/types.ts` — `ReportBody` = `{ kind, source, data, message?, url?, userAgent? }` (clientId/buildId stamped in `web/report.ts`).
- `server/internal/tables.ts` — drop `error_type, stack, component_stack, slot, label, operation_kind, operation, duration_ms, threshold_ms`; add `data jsonb`; rename `crash_loop` → `rate_limited` (it's generic velocity state).
- `server/internal/record-report.ts` — rewrite generic; delete `KIND_META`, `taskDescription` branches, fingerprint dispatch.
- `server/internal/report-kinds.ts` — new (above).
- `server/index.ts` — `export { ReportKind }`.
- `web/report.ts` — generic `report({ kind, source, data })`.
- `web/` — new `Reports.KindView` slot + export.

### 2. Crash as a contribution — `plugins/reports/plugins/crash/`

- `core/` — `CrashPayloadSchema` (`errorType, stack, componentStack, slot, label`) + crash
  fingerprint (sha256 of errorType + top-3 stack frames, moved from `shared/fingerprint.ts`).
- `server/` — `ReportKind({ kind: "crash", schema: CrashPayloadSchema, fingerprint, meta: { tag: "[crash]", … }, renderTask })`. Per-fingerprint dedup (one task per distinct crash, unchanged).
- `web/` — `Reports.KindView({ kind: "crash", renderSummary })` + the browser wiring moved out of
  `reports/web/components/report-collector.tsx`: `window` `error`/`unhandledrejection` listeners and
  `registerBoundaryReporter` (`plugins/primitives/plugins/error-boundary/web/reporter.ts`), now
  calling generic `report({ kind: "crash", source, data: { errorType, stack, … } })`.

### 3. Durable slow-op store — `plugins/slow-ops/` (top-level)

`core/`:
- `SlowOpSchema` + `slowOpsResource = resourceDescriptor<SlowOp[]>("slow-ops", …, [])`.
- `slowOpConfig` (moved from `reports/plugins/slow-ops/shared/config.ts`).

`server/internal/tables.ts` — deduped aggregate (persisted analogue of the profiler's in-memory
`Aggregate` + `byParent`), gated to threshold-exceeding spans:

```ts
slow_ops = pgTable("slow_ops", {
  id, worktree, operationKind, operation,
  count, totalMs (bigint), maxMs, lastMs, thresholdMs,
  callers: jsonb<{ kind; label; count; totalMs; maxMs }[]>(),  // caller attribution
  firstSeenAt, lastSeenAt,
}, unique(operationKind, operation, worktree))
```

`server/internal/record-slow-op.ts` — the single ingest funnel:
`recordSlowOp({ operationKind, operation, durationMs, thresholdMs, parent? })` →
upsert (count+1, totalMs+=dur, maxMs=greatest, lastMs=dur, merge `parent` into `callers`) →
`slowOpsResource.notify()` → fire-and-forget `recordReport({ kind: "slow-op", source, data })` for the
rollup task.

`server/internal/install-slow-span.ts` — moved from `reports/plugins/slow-ops`; subscribes via
`onSlowSpan` (`plugins/infra/plugins/runtime-profiler/core`) and now **forwards `span.parent`** into
`recordSlowOp` (the caller-attribution fix).

`server/internal/handle-client-slow-op.ts` — endpoint for client signals (page-load, element settle)
funnelling into the same `recordSlowOp` (no parent for client kinds).

`server/internal/slow-op-kind.ts` — `ReportKind({ kind: "slow-op", schema, fingerprint: () => "slow-op:rollup", meta, renderTask })`. **Fixed fingerprint → singleton rollup task**; `renderTask`
returns a pointer to Debug → Slow Ops; the latest op is reflected via the upserted `message`.

`web/` — slow-op collector moved from `reports/plugins/slow-ops/web` (rAF page-load timing +
`registerSlowResourceReporter` element settle), now POSTing to the slow-ops endpoint; `slowOpConfig`
registration.

`server` imports `recordReport` + `ReportKind` from `@plugins/reports/server` (edge `slow-ops → reports`, DAG-safe).

### 4. Ranked debug view — `plugins/debug/plugins/slow-ops/`

Follows the `claude-cli-calls` / `debug/profiling/runtime` template: `web/index.ts`
(`Pane.Register` + `DebugApp.Sidebar`), `web/panes.tsx` (`Pane.define`), `web/components/slow-ops-view.tsx`
— `useResource(slowOpsResource)` + `<DataTable>` ranked by `totalMs` (toggle to `count`/`maxMs`),
caller breakdown rendered inline (`↳ kind:label ×count`, like `runtime-section.tsx`'s `CallerBreakdown`).

## File-level change list

**New:** `plugins/reports/server/internal/report-kinds.ts`; `plugins/reports/plugins/crash/{core,server,web}`;
`plugins/slow-ops/{core,server,web}`; `plugins/debug/plugins/slow-ops/web`.

**Modified:** `plugins/reports/{core/resources.ts, shared/endpoints.ts, shared/types.ts, server/index.ts,
server/internal/{tables.ts,record-report.ts}, web/report.ts, web/components/report-collector.tsx}`;
`plugins/debug/plugins/reports/web/components/reports-view.tsx` (delegate to `Reports.KindView`).

**Deleted:** `plugins/reports/plugins/slow-ops/` (redistributed to `plugins/slow-ops/` + crash wiring).

**Reused (do not reinvent):** `defineServerContribution` (pattern: `ReportNoiseRule`);
`resourceDescriptor` + `defineResource` + `.notify()` (pattern: `claude-cli-calls`, `reportsResource`);
`onSlowSpan` / `SlowSpan.parent` (`runtime-profiler/core`); `DataTable` + `CallerBreakdown`
(`runtime-section.tsx`); `Pane.define` + `DebugApp.Sidebar` + `sidebarNavItem` (debug pane template);
`registerSlowResourceReporter` (`live-state/web`).

## Verification

1. `./equin build` — regenerates the destructive reports migration + the new `slow_ops` table; restarts.
2. `./equin check type-check plugin-boundaries migrations-in-sync` — registry must type-check;
   confirm no cross-plugin barrel violations on the new `slow-ops → reports` edge; migrations committed.
3. **Slow-op path:** lower `slowOpConfig` thresholds (Settings → Config), load a page hitting a DB query,
   then open Debug → Slow Ops — confirm the operation appears ranked by total time with a caller row
   (e.g. a `db` op attributed to its `http` route). Confirm `mcp__singularity__query_db` shows one row
   per operation in `slow_ops` and exactly **one** `[slow-op]` rollup task in `reports` (fixed fingerprint),
   not one per operation.
4. **Crash path (regression):** throw in a component / fire a `window` error — confirm a per-crash task is
   still filed and the crash still renders in Debug → Reports via the generic `Reports.KindView`.
5. `bun test plugins/reports` — any fingerprint/record-report unit tests still pass against the generic path.
