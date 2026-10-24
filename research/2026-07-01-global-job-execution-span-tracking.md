# Job execution span tracking — slow jobs through the slow-ops pipeline

**Date:** 2026-07-01
**Category:** global (infra/runtime-profiler + infra/jobs + debug/slow-ops + debug/op-rate + debug/profiling)

## Context

Today there is **no per-job execution-duration tracking**. The graphile-worker
dispatcher calls `job.run()` directly without a profiler span, and the
runtime-profiler's `SpanKind` union has no `"job"` variant — so jobs are entirely
outside the span-recording chokepoints and the `slow-ops` pipeline. The only
slow-job-adjacent signal is `queue-health`'s `queue-slot-hog` report, a live
"still locked past N minutes" tripwire that never sees a job that ran long but
already finished, and never records historical duration.

**Goal:** give jobs the same treatment HTTP/loader ops already get — record each
`job.run()` as a `"job"` entry span, so that:

- job durations aggregate into the runtime profiler (visible in Debug → Profiling
  → Runtime and via the `get_runtime_profile` MCP tool),
- DB queries issued inside a job attribute to the job as their `parent` (they are
  currently `parent: null`), and gate-waits charge to the job's `waits` map,
- a job whose run exceeds a threshold flows through `slow-ops` → files a deduped
  task (one per job name) with caller attribution, exactly like a slow route.

**Threshold model (per user):** a global default of **3000 ms** (`jobMs`,
live-editable in Settings → Config), plus a **per-job override** — a job expected
to run long declares `defineJob({ slowThresholdMs })` to raise its own bar so it
doesn't file noise. The override resolves at gating time; the global default
applies when a job declares none.

## Approach

### 1. Add the `"job"` SpanKind (runtime-profiler core)

`plugins/infra/plugins/runtime-profiler/core/recorder.ts`:

- Line 33: `export type SpanKind = "http" | "db" | "loader" | "sub" | "push" | "flush" | "job";`
- Extend the explanatory comment (lines 22–32) to describe `job` (a top-level
  background-work entry, analogous to `http` but triggered by the queue).
- Line 109: add `"job"` to `const KINDS`.
- Lines 232–239: add `job: new Map()` to the `aggregates` `Record<SpanKind, …>`
  literal (**tsc error until added**).
- Lines 245–252: add `job: []` to the `slowest` `Record<SpanKind, …>` literal
  (**tsc error until added**).

`getRuntimeProfile()` / `resetRuntimeProfile()` loop over `KINDS` generically — no
change beyond the array entry.

### 2. Wrap `job.run()` in a `"job"` entry span (jobs dispatcher)

`plugins/infra/plugins/jobs/server/internal/worker.ts`, `dispatch()` line ~211,
inside the existing `try` (mirrors the HTTP chokepoint at
`endpoints/core/implement.ts:86-94` byte-for-byte):

```ts
await recordEntrySpan("job", payload.jobName, () =>
  job.run({ input: payload.input, event: payload.event, ctx }),
);
```

Import `recordEntrySpan` from `@plugins/infra/plugins/runtime-profiler/core`.
Label = `payload.jobName` (the resource-key analogue for jobs).

Leave the surrounding `try/catch` untouched. Note the behaviors this preserves:

- **Suspend signal** (`ctx.waitFor`/`ctx.sleep`): the sentinel throws out of
  `recordEntrySpan`, whose `finally` records the span duration **up to the
  suspend point** (real work only, not the wait), then rethrows to the existing
  `isSuspendSignal` catch. A suspended→resumed job records one `job` span per
  active segment — correct, each segment is real work.
- **Errors/retries:** a throwing handler's duration is still captured (recorded
  in `finally`); the error rethrows unchanged, so `reportServerError` /
  `NonRetryableError` / retry handling are unaffected.
- **DB gate:** `database/server/internal/client.ts` gates only
  `currentCallerKind() === "loader"`; a job's kind is `"job"`, so job DB queries
  remain ungated (interactive) exactly as they are today when context-less. No
  behavior change — only attribution improves.

### 3. Per-job threshold override (jobs registry)

`plugins/infra/plugins/jobs/server/internal/registry.ts`:

- `DefineJobSpec` (line ~161): add optional
  `slowThresholdMs?: number;` with a doc comment ("Duration (ms) above which a
  run files a slow-op report. Defaults to the `slow-op` config `jobMs` (3000).
  Raise it for jobs expected to run long — backfills, syncs — to avoid noise.").
- `RegisteredJob` (line ~73): add `slowThresholdMs?: number;`.
- In `defineJob()`, copy `spec.slowThresholdMs` onto the constructed
  `RegisteredJob`.
- Add and export a pure lookup:
  ```ts
  export function getJobSlowThresholdMs(name: string): number | undefined {
    return jobRegistry.get(name)?.slowThresholdMs;
  }
  ```
- Re-export `getJobSlowThresholdMs` from the server barrel
  `plugins/infra/plugins/jobs/server/index.ts` (alongside `defineJob`,
  `UNSAFE_getRegisteredJob`, …).

### 4. Wire the `"job"` threshold into slow-ops

`plugins/debug/plugins/slow-ops/core/config.ts` — add a field to `slowOpConfig`:

```ts
jobMs: intField({
  default: 3000,
  min: 0,
  label: "Job threshold (ms)",
  description:
    "Report a slow-op when a background job run exceeds this duration. A job can override this via defineJob({ slowThresholdMs }).",
}),
```

`plugins/debug/plugins/slow-ops/server/internal/install-slow-span.ts`:

- Change `thresholdFor` to take the whole span (it needs the label for the
  per-job lookup) and add the `job` case:
  ```ts
  function thresholdFor(span: SlowSpan, t: Thresholds): number {
    switch (span.kind) {
      case "http": return t.httpMs;
      case "db": return t.dbMs;
      case "job": return getJobSlowThresholdMs(span.label) ?? t.jobMs;
      case "loader":
      case "sub":
      case "push":
      case "flush":
        return t.loaderMs;
    }
  }
  ```
  (`case "job"` is required for the exhaustive switch to compile.)
- Update the call site: `const threshold = thresholdFor(span, thresholds);`
- Add `thresholds.jobMs` to the `floor = Math.min(...)` pre-filter (line ~43), so
  the profiler's cheap pre-gate never drops a slow job below the config default.
- Import `getJobSlowThresholdMs` from `@plugins/infra/plugins/jobs/server`.

The slow-op row identity is `(operationKind, operation, worktree)` = `("job",
jobName, wt)` — one deduped task per slow job name, fingerprint
`slow-op:job:<jobName>`. No DB migration: `slow_ops.operationKind`/`operation`
are free text; `"job"` and the job name are new values in existing columns.

**Constraint (documented):** the per-job override is intended to *raise* the bar.
The profiler pre-filter floor is `min(config thresholds)` (≈ `dbMs` = 500 ms), so
an override below that floor isn't honored — a non-issue for the "expected-slow
job" use case.

### 5. Keep op-rate compiling (mandatory)

`op-rate`'s `kindThreshold` switch is exhaustive over `SpanKind` (**tsc error**
until a `job` case exists), and its local `KINDS` array would silently skip jobs.

`plugins/debug/plugins/op-rate/core/config.ts` — add to `opRateConfig`:

```ts
jobPerWindow: intField({
  default: 500,
  min: 0,
  label: "Job runs per window",
  description:
    "File an op-rate report when a job label runs more than this many times within one monitor window.",
}),
```

`plugins/debug/plugins/op-rate/server/internal/monitor-job.ts`:

- Line ~24: add `"job"` to the local `KINDS` array.
- Lines ~110–125: add `case "job": return cfg.jobPerWindow;` to `kindThreshold`.

### 6. Surface `"job"` in the runtime-profiler UI / MCP / endpoint

These layers hand-enumerate the kinds (not TS-exhaustive against core `SpanKind`),
so job data is silently dropped until each is extended:

- `plugins/debug/plugins/profiling/plugins/runtime/shared/endpoints.ts` — add
  `"job"` to `spanKindSchema` (`z.enum`) and a `job` key to the `byKind()` object
  shape (else zod strips the `job` aggregate from the response).
- `plugins/debug/plugins/profiling/plugins/runtime/server/internal/mcp-tools.ts`
  — add `"job"` to the local `KINDS` array and the input `z.enum`.
- `plugins/debug/plugins/profiling/plugins/runtime/web/components/runtime-section.tsx`
  — add `"job"` to the `RuntimeKind` union, add `{ value: "job", label: "Job" }`
  to `RUNTIME_FIELDS[0].options`, and add
  `tag("job", toAggRows(data.aggregates.job))` to the `rows` builder.

### 7. Docs

- `plugins/infra/plugins/runtime-profiler/CLAUDE.md` — add the `job` entry point
  (jobs dispatcher chokepoint) to the "Entry points vs leaves" section.
- `plugins/debug/plugins/slow-ops/CLAUDE.md` — document the `job` kind, the
  `jobMs` default (3000), and the `defineJob({ slowThresholdMs })` override.
- `./equin build` regenerates `docs/plugins-details.md` / `plugins-compact.md`
  and the plugin reference blocks; the `plugins-doc-in-sync` check enforces it.

## Critical files

| File | Change |
|---|---|
| `plugins/infra/plugins/runtime-profiler/core/recorder.ts` | `SpanKind` + `KINDS` + `aggregates`/`slowest` records |
| `plugins/infra/plugins/jobs/server/internal/worker.ts` | wrap `job.run()` in `recordEntrySpan("job", …)` |
| `plugins/infra/plugins/jobs/server/internal/registry.ts` | `slowThresholdMs` on spec+registered; `getJobSlowThresholdMs` |
| `plugins/infra/plugins/jobs/server/index.ts` | export `getJobSlowThresholdMs` |
| `plugins/debug/plugins/slow-ops/core/config.ts` | `jobMs` field (default 3000) |
| `plugins/debug/plugins/slow-ops/server/internal/install-slow-span.ts` | `job` case + per-job lookup + floor |
| `plugins/debug/plugins/op-rate/core/config.ts` | `jobPerWindow` field |
| `plugins/debug/plugins/op-rate/server/internal/monitor-job.ts` | `job` in `KINDS` + `kindThreshold` |
| `plugins/debug/plugins/profiling/plugins/runtime/shared/endpoints.ts` | `spanKindSchema` + `byKind` |
| `plugins/debug/plugins/profiling/plugins/runtime/server/internal/mcp-tools.ts` | `KINDS` + `z.enum` |
| `plugins/debug/plugins/profiling/plugins/runtime/web/components/runtime-section.tsx` | `RuntimeKind` + options + rows |

## Reused primitives

- `recordEntrySpan(kind, label, fn)` — `runtime-profiler/core` (same call shape as
  `endpoints/core/implement.ts:86`).
- `onSlowSpan` / `recordSlowOp` / `slowOpKind` — the existing slow-ops pipeline;
  no new report machinery, jobs just become another `operationKind`.
- `intField` / `defineConfig` — config_v2 (no migration; JSONC config).

## Verification

1. `./equin build` — must pass type-check (the two exhaustive switches +
   two `Record<SpanKind,…>` literals fail loudly if any `job` case is missing)
   and all `./equin check` (incl. `plugins-doc-in-sync`, boundaries).
2. **Span recorded:** trigger a job (e.g. enqueue via an existing flow, or a
   scheduled job tick). Then call the `get_runtime_profile` MCP tool for this
   worktree and confirm a `job` aggregate with the job name as label appears; or
   open Debug → Profiling → Runtime and confirm the `Job` kind renders.
2b. **DB attribution:** confirm a DB query issued inside that job now shows the
   job as its `byParent` entry (previously `parent: null`).
3. **Slow-op path (global default):** temporarily set `slow-op` config `jobMs` to
   a tiny value (e.g. 1 ms) in Settings → Config, run a job, and confirm a
   `slow-op:job:<jobName>` task is filed (Debug → Reports / Debug → Slow Ops) with
   the `job` kind and correct duration. Restore `jobMs` to 3000.
4. **Per-job override:** add `slowThresholdMs: 999_999` to a test job's
   `defineJob`, set `jobMs` low again, run it, and confirm **no** slow-op is filed
   (the override raised the bar). Remove the test override.
5. **Query the store directly** (`query_db`):
   `select operation, count, max_ms, threshold_ms from slow_ops where operation_kind = 'job';`
