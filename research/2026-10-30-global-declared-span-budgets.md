# Declared span budgets: the span carries its own bar

Task: task-1793316430-dqjpnh (part of the 2026-10-29 slow-op notifications audit, task-1793313534-w54p8d).

## Context

A budget declared where work is written never reaches the monitors that judge it:

- **Warm-ups.** `WarmupSpec.budgetMs` (`infra/warmup/server/internal/registry.ts:39`) is
  documented as "Read by the boot-budget monitor", but nobody reads it. `boot-budget`'s
  `budgetForSpan` (`debug/boot-budget/server/internal/monitor-job.ts:91`) returns the global
  `warmupBudgetMs` (2000) for every `warmup:*` span. The executor also wraps each warm-up in
  `runTracked("warmup:<name>")`, a `bg` span that slow-ops judges on `loaderMs` (2000)
  (`debug/slow-ops/server/internal/resolve-threshold.ts`, case `"bg"`).
  `plugin-tree.trees` declares 15 000 ms and runs about 5.9 s. That produced 333 boot-budget
  reports and 250 `bg` slow-op reports, all against a budget it never claimed.
- **Background spans have no latency class.** `runTracked(label, fn)` has no way to say how
  long the work is expected to take. `task-title:generate`
  (`tasks/plugins/task-title/machine/internal/generate-title.ts:130,152`) wraps a Haiku call
  with a 30 s `timeoutMs` (`:77`). It takes 2.6–30 s and is judged on the 2 s loader bar: 42
  reports. Jobs already declare their class (`defineJob({ hold })`, whose ceiling is the
  slow-op bar). Routes declare their bar too (`defineEndpoint({ slowThresholdMs })`).
  Background spans are the only kind that can't.

Root cause: in both monitors the bar is looked up from **the span kind plus global config**.
It is never taken from what the call site declared. The fix makes the declaration part of the
span itself, so a monitor reading the span cannot miss it.

## Design

### 1. A span carries an optional declared `budgetMs`

- **Runtime profiler** (`infra/runtime-profiler/core/recorder.ts`):
  - `runTracked(label, fn, opts?: { budgetMs?: number })`.
  - `recordEntrySpan` takes the same option, stores it on the `EntryContext`, and stamps it
    on the `SlowSpan` built in `record()`.
  - New field: `SlowSpan.budgetMs?: number`, documented as "the bar the call site declared;
    a monitor that judges this span uses it in place of its kind default".
  - Keep it **out of `SpanDetail`**. That holds variant and measures, which are merged into
    rows. A budget is a judgement input, not a fact about the run.
- **Server-core hooks facade** (`framework/server-core/core/profiler-hooks.ts`): thread the
  same option through `ProfilerHooks.runTracked` / `recordEntrySpan` and the exported
  wrappers.
- **Boot profiler** (`framework/server-core/core/profiler.ts`):
  - `profilerStart(id, phase, label, plugin?, opts?: { budgetMs?: number })`.
  - New field `Span.budgetMs?: number`, with the same meaning.

### 2. Monitors prefer the span's declared bar

- **slow-ops** (`resolve-threshold.ts`): `resolveSlowThreshold` returns `span.budgetMs`
  first, for every kind, ahead of the per-kind switch. The kind defaults stay as the
  fallback.
  - `perfFloorMs` is unchanged. A declared budget below the floor is not honored, the same
    caveat that already applies to `slowThresholdMs`. Note this in the code comment and in
    the slow-ops CLAUDE.md.
  - The quantity compared (`slowSpanMs`) is unchanged. Whether `bg` spans should be judged
    on work time rather than wall time belongs to the sibling task task-1793316419-rup28z
    (waits judged as slowness). Mention it there; don't change it here.
- **boot-budget** (`monitor-job.ts`): `budgetForSpan` returns
  `span.budgetMs ?? cfg.warmupBudgetMs` for `warmup:*` spans.
  - Record `budgetSource: "declared" | "config"` in the report data, as an optional field in
    `core/kinds.ts`.
  - The kind view and summary show "declared by the warm-up" next to the budget, so a reader
    knows which bar fired.
  - The config field's description says it is the default for warm-ups that declare no
    `budgetMs`.

### 3. Call sites declare once

- **Warm-up executor** (`infra/warmup/server/internal/executor.ts`): pass `w.budgetMs` to
  both `profilerStart(...)` and `runTracked(...)`. That gives one source, two spans. Fix the
  `WarmupSpec.budgetMs` doc to name both readers.
- **Task title**: `runTracked("task-title:generate", fn, { budgetMs: <timeout> })`.
  - Hoist the `30_000` `timeoutMs` into a named constant that both the model call and the
    span read, so the budget is derived from the bound and cannot drift from it.
  - With this budget, a report fires only if the work overruns its own timeout, which is the
    actual defect for a `seconds`-shaped call.
- **Audit the other `runTracked` call sites** (about 60) for ones that wrap a model call,
  subprocess or network fetch with a known bound, and give each its bound the same way. Use
  `rg 'runTracked\(' -g '!*.test.ts'`, and cross-check against `bg` rows in the `slow_ops`
  table on main (`query_db`, `operation_kind = 'bg'`, ordered by count). Leave short
  in-process work on the default.

### Not in scope / follow-ups

- **Routes and jobs on the same field.** `getRouteSlowThresholdMs` and
  `getJobSlowThresholdMs`/`getJobHold` are label-keyed registries. They could stamp
  `budgetMs` on their entry span instead, which would delete both maps. File as a follow-up.
- **Making the declaration required.** A required `budgetMs`/class on `runTracked` would be
  the type-error rung, but it churns every call site for work that is fine on the default. It
  isn't needed to fix the reported noise, so it is a judgement call for the user, not part of
  this change.
- **Wait vs work for `bg`**: see the sibling task task-1793316419-rup28z.

## Files

- `plugins/infra/plugins/runtime-profiler/core/recorder.ts`: option, `SlowSpan.budgetMs`
- `plugins/framework/plugins/server-core/core/profiler-hooks.ts`, `.../core/profiler.ts`:
  facade option, `Span.budgetMs`
- `plugins/debug/plugins/slow-ops/server/internal/resolve-threshold.ts` (+ `CLAUDE.md`
  § thresholds)
- `plugins/debug/plugins/boot-budget/server/internal/monitor-job.ts`, `core/kinds.ts`,
  `core/config.ts` (description), `server/internal/boot-budget-kind.ts`,
  `web/components/boot-budget-summary.tsx`
- `plugins/infra/plugins/warmup/server/internal/executor.ts`, `registry.ts` (doc)
- `plugins/tasks/plugins/task-title/machine/internal/generate-title.ts`
- Any other `runTracked` site found by the audit

## Verification

- **Unit tests:**
  - `resolve-threshold`: a span with `budgetMs` uses it for `bg`, `loader` and `job`, and
    without it falls back to the kind default.
  - `recorder.test.ts`: `runTracked(..., { budgetMs })` surfaces `budgetMs` on the `SlowSpan`
    passed to `onSlowSpan`.
  - boot-budget `budgetForSpan`: declared vs config, extracted to a pure function if needed.
  - `drain.test.ts`: the executor passes `w.budgetMs` to both spans.
- Run `./equin test plugins/debug/plugins/slow-ops plugins/debug/plugins/boot-budget plugins/infra/plugins/runtime-profiler plugins/infra/plugins/warmup`, then `./equin check`.
- `./equin build`. In the worktree, check `slow_ops` with `query_db`: no new `bg warmup:*`
  or `bg task-title:generate` rows under their budget. Confirm the boot-budget monitor files
  nothing for `warmup:plugin-tree.trees`. It is host-scoped, so on a worktree it is skipped;
  the change can only be confirmed on main after the push, by watching the report count stop
  growing.
