# Rename `crashes` → generic `reports` event-reporting system

## Context

Today the `crashes` plugin owns a complete, well-factored ingestion pipeline:
fingerprint-based dedup, occurrence `count`, a `noise` classification slot,
auto task-filing under a meta-task, persistent notifications, a JSONL crash
buffer for process-death safety, and a debug pane. That machinery is generic —
"a crash" is just one *kind* of thing worth recording, deduping, and surfacing
as a task.

The user wants to record **non-crash events** too — starting with slow
operations (slow page load >2s, elements appearing >1s, slow DB queries, slow
server loaders/HTTP). Rather than build a parallel system, we generalize the
existing one into a `reports` plugin where **a crash is the first `kind` of
report**, so future kinds plug into the same dedup/count/noise/task/notification
machinery with zero structural change.

**Scope of THIS task is the rename + generalization ONLY.** No new report
kinds are implemented. The actual slow-operation detection is filed as a
follow-up task (spec at the end of this doc).

Intended outcome: a `reports` plugin, byte-for-byte behaviourally identical for
crashes, with a `kind` discriminator column (`'crash'` for every existing row)
and generically-named public API, ready for a `slow-op` kind to be added later
with no edits to the core pipeline.

## Approach

Pure rename + one additive column. Crash-specific columns
(`errorType`, `stack`, `componentStack`, `slot`, `label`, `crashLoop`,
`lastClientId`, `lastBuildId`) **stay as typed nullable columns** on the unified
`reports` table — a future `slow-op` kind simply leaves them NULL and (in the
follow-up) adds its own columns. This is the minimal change that leaves room for
the next kind; a JSONB payload column is explicitly *not* introduced now (it
would force schema-per-kind plumbing and break the hand-written `ReportSchema`
the debug pane reads).

The registry is fully codegen'd (no hand-edited `plugins.ts`), so renaming the
two plugin directories + fixing `@plugins/crashes/*` imports + `./equin
build` regenerates `server.generated.ts`, `web.generated.ts`, all `CLAUDE.md`,
and `docs/plugins-*.md` automatically.

### Symbol mapping (old → new)

| Old | New |
|---|---|
| `plugins/crashes/` (dir) | `plugins/reports/` |
| `plugins/debug/plugins/crashes/` (dir) | `plugins/debug/plugins/reports/` |
| `@plugins/crashes/*` imports | `@plugins/reports/*` |
| `@singularity/plugin-crashes[-*]`, `@singularity/plugin-debug-crashes` (pkg names) | `@singularity/plugin-reports[-*]`, `@singularity/plugin-debug-reports` |
| `_crashes` / pgTable `"crashes"` | `_reports` / `"reports"` |
| index `crashes_fingerprint_worktree_idx`, `crashes_task_id_idx` | `reports_fingerprint_worktree_idx`, `reports_task_id_idx` |
| `CrashSchema`, `Crash` | `ReportSchema`, `Report` |
| `crashesResource`, resource key `"crashes"` | `reportsResource`, `"reports"` |
| `SERVER_CRASH_SOURCES`, `CLIENT_CRASH_SOURCES`, `CrashSource` | `SERVER_REPORT_SOURCES`, `CLIENT_REPORT_SOURCES`, `ReportSource` |
| `CrashReportBodySchema`, `CrashReportBody` | `ReportBodySchema`, `ReportBody` |
| `CrashReport` (server input type) | `ReportInput` |
| `CrashReportResultSchema`, `CrashReportResult` | `ReportResultSchema`, `ReportResult` |
| `ClientCrashReport` | `ClientReportBody` |
| endpoint `reportCrash`, route `POST /api/crashes` | `submitReport`, `POST /api/reports` |
| `CrashContext` | `ReportContext` |
| `CrashNoiseInput`, `CrashNoiseRuleSpec`, `CrashNoiseRule`, slot `"crash-noise-rule"`, `isNoiseCrash` | `ReportNoiseInput`, `ReportNoiseRuleSpec`, `ReportNoiseRule`, `"report-noise-rule"`, `isNoiseReport` |
| `CRASHES_META_TASK_ID = "task-meta-crashes"`, `ensureCrashesMetaTask`, folder `"Crashes"` | `REPORTS_META_TASK_ID = "task-meta-reports"`, `ensureReportsMetaTask`, `"Reports"` |
| `recordCrash`, `RecordCrashResult`, `ensureTaskForCrash` | `recordReport`, `RecordReportResult`, `ensureTaskForReport` |
| `appendCrashSync`, `BufferedCrash`, `flushBufferedCrashes` | `appendReportSync`, `BufferedReport`, `flushBufferedReports` |
| `CrashReporter` (web component) | `ReportCollector` |
| `crashesPane`, `CrashesView`, `CrashRow`, `CrashesBody` (debug) | `reportsPane`, `ReportsView`, `ReportRow`, `ReportsBody` |
| `CRASHES_DIR` (= `<SINGULARITY_DIR>/crashes`) | `REPORTS_DIR` (= `<SINGULARITY_DIR>/reports`) |
| notification `type: "crash"`, author `"crashes-plugin"`, task prefix `[crash]`, metadata key `crashId` | `type: "report"`, `"reports-plugin"`, `[crash]` kept in title (see note), metadata key `reportId` |

**Kept generic / unchanged:** `report()` web fn, `fingerprint()`,
`backfillNoiseClassification`, `readAndClearBuffer`, `recordNotification` API.

**Notes / small decisions:**
- `crashLoop` column keeps its name (rename-only; renaming it is unnecessary churn — it's only read/written inside the plugin and stays meaningful for the crash kind).
- Task **title** prefix: keep `[crash]` for crash-kind rows (it's derived per-kind; the follow-up will make `recordReport` choose the prefix by `kind`). For now `recordReport` only ever runs the crash branch.
- Add `kind` to `ReportBodySchema` as `z.string().optional()`; `recordReport` defaults it to `"crash"`. All existing in-process callers pass no `kind`, so they keep filing crashes with zero changes.

### Files to change

**Within renamed `plugins/reports/`** (apply symbol map):
- `package.json`, `core/resources.ts`, `core/index.ts`
- `shared/types.ts` (+ add `kind`), `shared/endpoints.ts`, `shared/fingerprint.ts` (comment only)
- `server/internal/tables.ts` (+ `kind: text("kind").notNull().default("crash")`), `schema.ts`, `resources.ts`
- `server/internal/record-crash.ts` → `record-report.ts`, `meta-crashes.ts` → `meta-reports.ts`, `noise-rules.ts`, `buffer.ts`, `process-hooks.ts`, `backfill-noise.ts`, `handle-report.ts`, `velocity.ts` (comment)
- `server/index.ts` (re-exports + httpRoute key)
- `web/report.ts`, `web/components/crash-reporter.tsx` → `report-collector.tsx`, `web/index.ts`
- Sub-plugins `plugins/{noise-rules,endpoint-errors,launch-fix,mutation-errors}/` — `package.json` names + `@plugins/crashes/*` import paths (`noise-rules/server` uses `ReportNoiseRule`; `endpoint-errors` & `health` use `report`; `launch-fix` uses `ReportContext`)

**Within renamed `plugins/debug/plugins/reports/`:**
- `package.json`; `web/components/crashes-view.tsx` → `reports-view.tsx` (+ render a `kind` badge next to `source`, forward-compat); `web/panes.tsx` (pane id/segment `crashes`→`reports`); `web/index.ts` (sidebar id/title, openPane)

**External consumers:**
- `plugins/conversations/server/internal/poller.ts`, `.../handle-create.ts` — `recordCrash`→`recordReport`, import path
- `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts` — same
- `plugins/conversations/plugins/model-provider/web/components/corruption-reporter.tsx` — `report` import path
- `plugins/infra/plugins/health/web/components/wedge-watchdog.tsx` — `report` import path
- `plugins/infra/plugins/paths/core/internal/paths.ts` (+ `core/index.ts`, `server/index.ts`) — `CRASHES_DIR`→`REPORTS_DIR`, value `crashes`→`reports`

**Auto-regenerated by build (never hand-edit):** `server.generated.ts`,
`web.generated.ts`, every `CLAUDE.md`, `docs/plugins-compact.md`,
`docs/plugins-details.md`.

### Migration

The table rename + new column auto-generates via `./equin build` (never
run `drizzle-kit` manually). Non-interactive drizzle-kit emits this as a
DROP + CREATE of the `crashes`/`reports` table rather than a rename — **this is
acceptable**: `reports` is a pure diagnostics table, no FK points into it
(`taskId` is a soft reference), and crash rows re-accrue within minutes. Commit
the generated SQL so `migrations-in-sync` passes. Stale buffered
`~/.singularity/crashes/*.jsonl` files are abandoned (same acceptable loss).

## Verification

1. `./equin build` — generates migration, regenerates registry+docs, restarts server.
2. `./equin check` — `migrations-in-sync`, `plugins-doc-in-sync`, `plugin-boundaries`, `type-check` all green.
3. App loads at `http://att-1781336193-cxj2.localhost:9000`. Open Debug → **Reports** pane (formerly Crashes); confirm it renders and shows a `kind` badge.
4. Trigger a crash through the real client path (e.g. a ResizeObserver loop) and confirm: a `reports` row appears with `kind='crash'`, `count` increments on repeat, a task is filed under the **Reports** meta-task, and the noise rule still mutes ResizeObserver. Use `query_db` on `reports` to confirm columns.
5. Confirm server-side reporters still work: `recordReport` calls from the conversations poller and tmux-runtime file rows (inspect via `query_db`).

## Follow-up task (file via `add_task` after this lands)

**Title:** Auto-report slow operations as `slow-op` reports

Build on the generalized `reports` pipeline. Add a `slow-op` report `kind`
that records and (per policy) files tasks for slow operations. Signals to
capture (all four):

- **Client page load >2s** — new client instrumentation (Performance API /
  `PerformanceObserver` for FCP/LCP; nothing exists today). Report time from
  navigation to first meaningful content.
- **Client element appearance >1s** — hook the live-state `useResource` path
  (`plugins/primitives/plugins/live-state/web/use-resource.ts`): measure
  mount→`pending===false`; report resources that take >1s to settle.
- **Server loaders & HTTP >2s** — already timed by `runtime-profiler`
  (`recordEntrySpan("loader"|"http", …)`). Add a threshold *callback* hook in
  `runtime-profiler/core` (e.g. `onSlowSpan(cb)`) that the `reports` server
  plugin registers against — do NOT poll `getRuntimeProfile()` (no-polling
  rule), and keep `runtime-profiler` dependency-free (collection-consumer
  separation: profiler owns the generic hook, reports consumes it).
- **Slow DB queries** — same `onSlowSpan` hook, `kind === "db"`.

Design notes for the follow-up:
- Add `slow-op` columns (durationMs, threshold, operationKind, operation label)
  to the `reports` table, or a side payload — decide then.
- Dedup by operation label so a recurring slow query collapses to one row with a
  `count`, like crashes.
- **Cold-start slowness IS a real report, not noise.** A slow first/cold load
  is bad UX and must be surfaced — do *not* add a noise rule that suppresses
  first-occurrence or cold-cache spikes.
