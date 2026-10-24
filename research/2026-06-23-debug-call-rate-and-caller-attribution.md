# Call-rate report kind + slow_ops caller attribution

**Date:** 2026-06-23
**Status:** Plan — awaiting approval

## Context

Two structural observability gaps were exposed by the recent `plugin-changes`
pathology (an endpoint hammered ~1870×):

1. **No call-rate / call-count signal.** `slow_ops` only fires on per-call
   latency > threshold (`onSlowSpan`). A fast-but-hammered op — or one whose call
   count balloons — is invisible. The runtime profiler already tracks a per-op
   `count` (cumulative since boot), so a scheduled job can diff snapshots and file
   a report when an op's calls-per-window crosses a threshold. This points at the
   **cause** (the hot op) instead of only the **blast radius** (collateral slow
   spans). The pathology was noticed only because the calls were *also* slow.

2. **`slow_ops.callers` is never populated for client signals.** The jsonb column,
   `mergeCaller`, and the UI (`CallerBreakdownLines`) are all wired, but client
   signals (`page-load`, `element`) pass `parent: null`, so `callers` stays `[]`
   forever. Capturing client-side attribution (the route that issued the request)
   is what turns "investigate who triggers these N calls" from guesswork into a
   direct answer.

Both are modeled byte-for-byte on existing precedent: gap 1 mirrors
`debug/queue-health` (durable signal → `ReportKind` → deduped task via a cheap
per-worktree scheduled `defineJob`); gap 2 reuses the already-built `mergeCaller`
merge path in `record-slow-op.ts`.

---

## Part A — Populate `slow_ops.callers` for client signals

**Goal:** client `element` (and optionally `page-load`) signals carry the route
that issued them, so `callers` shows e.g. `↳ route:/agents/c/123 ×42`.

The whole merge path already exists; only the *source* of the caller is missing.
The one type obstacle: `RecordSlowOpInput.parent` is typed `SpanRef | null`, and
`SpanRef.kind` is the narrow `SpanKind` union (`http|db|loader|…`). A client
"route" caller is not a span kind. **Generalize the caller to a loose
`{ kind: string; label: string }` ref** — a `SpanRef` is structurally assignable
to it, so the server path is unaffected, and the client can pass `kind: "route"`.

### Changes

1. **`plugins/debug/plugins/slow-ops/core/resources.ts`**
   Add a `CallerRefSchema` (the identity subset of `CallerBreakdown`):
   ```ts
   export const CallerRefSchema = z.object({ kind: z.string(), label: z.string() });
   export type CallerRef = z.infer<typeof CallerRefSchema>;
   ```

2. **`plugins/debug/plugins/slow-ops/shared/endpoints.ts`**
   Add optional `caller` to the client body:
   ```ts
   caller: CallerRefSchema.optional(),
   ```
   (import `CallerRefSchema` from `../core`). Update the header comment that
   currently says client signals have "no caller attribution".

3. **`plugins/debug/plugins/slow-ops/web/components/slow-op-collector.tsx`**
   On the **element** signal, add `caller: { kind: "route", label: location.pathname }`
   to the body. The element settle happens under a route; the route is the cheap,
   reliable "who mounted this resource" attribution. (Resource key + params are
   already in `operation`.) **page-load** keeps no caller — its `operation` *is*
   `location.pathname`, so a route caller would be redundant.

4. **`plugins/debug/plugins/slow-ops/server/internal/record-slow-op.ts`**
   - Rename `RecordSlowOpInput.parent?: SpanRef | null` →
     `caller?: CallerRef | null` (clarity: client callers are not span parents).
     Widen the type from `SpanRef` to `CallerRef`.
   - `mergeCaller(callers, caller, durationMs)` already takes `{ kind, label }` —
     no change to its body; just the param name/type.
   - The merge gate `const callers = caller ? mergeCaller(...) : row.callers;`
     unchanged in logic.

5. **`plugins/debug/plugins/slow-ops/server/internal/install-slow-span.ts`**
   Update the call site: `recordSlowOp({ …, caller: span.parent, waits: span.waits })`
   (was `parent: span.parent`). `span.parent` (a `SpanRef`) is assignable to
   `CallerRef`.

6. **`plugins/debug/plugins/slow-ops/server/internal/handle-client-slow-op.ts`**
   Forward `caller: body.caller ?? null` (was `parent: null`).

7. **`plugins/debug/plugins/slow-ops/CLAUDE.md`** — note that client `element`
   signals now attribute to their route.

> No DB migration: the `callers` column and `CallerBreakdown` shape are unchanged.
> The pane UI (`CallerBreakdownLines`) already renders any non-empty `callers`.

---

## Part B — Call-rate report kind (new `op-rate` plugin)

**Goal:** a cheap per-worktree scheduled job samples `getRuntimeProfile()`, diffs
each op's `count` against the previous tick, and files **one task per hot op**
when its calls-in-window cross a per-kind threshold.

New sibling plugin to `slow-ops` (latency-specific; call-rate is orthogonal),
under `plugins/debug/plugins/op-rate/`. Modeled byte-for-byte on `queue-health`.

### Why a pull-diff job (not a recorder hook)

The recorder (`runtime-profiler/core/recorder.ts`) is load-bearing, zero-dep, and
isomorphic — it must not gain a back-edge to a monitor. It already accumulates
`count` cumulatively. The job and the recorder live in the **same worktree
process**, so the job imports `getRuntimeProfile()` directly and diffs successive
snapshots in module-level state. Recorder stays pure. (Same separation as
live-state-churn's accumulator + scheduled job.)

### Windowing & counter-reset handling

- Module-level `Map<string, number>` (`${kind}:${label}` → last `count`) plus a
  last-sample timestamp, per process.
- Each tick: `delta = count - prev`. If `count < prev` (the profile was reset via
  `resetRuntimeProfile()`, or the label is new), treat `prev` as 0.
- **First observation of a label seeds the baseline and fires nothing** — avoids a
  false spike from the full since-boot count on the first tick.
- `delta` is "calls in this window"; window = the cron interval.

### Span kinds & thresholds (all kinds, per-kind threshold)

User chose **all kinds**. Because `db` (every query) and `flush` (internal cycle)
are inherently high-count, a single threshold would drown the signal — so mirror
`slowOpConfig`'s per-kind thresholds. Config (`config_v2`, read live via
`getConfig`):

```ts
opRateConfig = defineConfig({ name: "op-rate", fields: {
  enabled:      boolField({ default: true }),
  httpPerWindow:   intField({ default: 500 }),
  loaderPerWindow: intField({ default: 500 }),
  subPerWindow:    intField({ default: 500 }),
  pushPerWindow:   intField({ default: 500 }),
  flushPerWindow:  intField({ default: 1000 }),
  dbPerWindow:     intField({ default: 5000 }),   // db is leaf-level, naturally high
}});
```

A `kindThreshold(kind, cfg)` helper maps each `SpanKind` to its field (same shape
as slow-ops' `thresholdFor`).

### Task shape: one per hot op (capped)

- Fingerprint `op-rate:${kind}:${label}` → each hot op gets its own task pointing
  directly at the cause.
- **Cap at top-N (20) over-threshold ops per tick**, ranked by delta desc, to
  bound task creation. If more than N trip, `log()` the dropped count (no silent
  truncation, per repo policy).
- `notifCooldownMs ≈ 600_000` so a persistent hot op re-alerts the bell at most
  once / 10 min.

### Files (mirror queue-health structure)

```
plugins/debug/plugins/op-rate/
  core/config.ts        — opRateConfig (enabled + 6 per-kind thresholds)
  core/kinds.ts         — OpRatePayloadSchema = { kind, label, callsInWindow, windowMs, threshold }
  core/index.ts         — re-export config + schema/types
  server/internal/op-rate-kind.ts   — ReportKind({ kind:"op-rate", fingerprint: d => `op-rate:${d.kind}:${d.label}`, meta:{ tag:"[op-rate]", variant:"warning", notifCooldownMs:600_000 }, renderTask })
  server/internal/monitor-job.ts    — defineJob({ name:"debug.op-rate-monitor", dedup:"singleton", schedule:{ cron:"*/5 * * * *", perWorktree:true }, maxAttempts:3, run })
  server/index.ts       — { register:[opRateMonitorJob], contributions:[ConfigV2.Register({descriptor:opRateConfig}), opRateKind] }
  web/components/op-rate-summary.tsx — function OpRateSummary({report}): parse data, render `kind:label ×callsInWindow`
  web/index.ts          — { contributions:[ConfigV2.WebRegister({descriptor:opRateConfig}), Reports.KindView({match:"op-rate", component:OpRateSummary})] }
  CLAUDE.md
```

### monitor-job.ts sketch

```ts
import { getRuntimeProfile } from "@plugins/infra/plugins/runtime-profiler/core";
const lastCount = new Map<string, number>();   // module-level, per process

run: async () => {
  const cfg = getConfig(opRateConfig);
  if (!cfg.enabled) return;
  const { aggregates } = getRuntimeProfile();
  const hot: { kind, label, delta, threshold }[] = [];
  for (const kind of KINDS) {
    const threshold = kindThreshold(kind, cfg);
    for (const agg of aggregates[kind]) {
      const key = `${kind}:${agg.label}`;
      const prev = lastCount.get(key);
      lastCount.set(key, agg.count);
      if (prev === undefined) continue;                 // seed baseline, no fire
      const delta = agg.count >= prev ? agg.count - prev : agg.count;  // reset-safe
      if (delta > threshold) hot.push({ kind, label: agg.label, delta, threshold });
    }
  }
  hot.sort((a, b) => b.delta - a.delta);
  const top = hot.slice(0, 20);
  if (hot.length > top.length) log(`op-rate: ${hot.length - top.length} over-threshold ops not reported (top-20 cap)`);
  for (const h of top) {
    await recordReport({
      kind: "op-rate",
      source: "server-op-rate-monitor",   // add to SERVER_REPORT_SOURCES
      data: { kind: h.kind, label: h.label, callsInWindow: h.delta, windowMs: WINDOW_MS, threshold: h.threshold },
      message: `${h.kind} ${h.label} — ${h.delta} calls/window (threshold ${h.threshold})`,
    });
  }
};
```

> `WINDOW_MS` is informational (5 min, matching the cron); the trip decision is on
> raw `delta` vs the per-kind threshold, so cron skew doesn't change correctness.

### One cross-plugin touch

`recordReport` validates `source` against `SERVER_REPORT_SOURCES` in
`plugins/reports/shared/types.ts` — add `"server-op-rate-monitor"` there.

---

## Critical files

**Part A (edit):**
- `plugins/debug/plugins/slow-ops/core/resources.ts` (add `CallerRefSchema`)
- `plugins/debug/plugins/slow-ops/shared/endpoints.ts` (optional `caller`)
- `plugins/debug/plugins/slow-ops/web/components/slow-op-collector.tsx` (route caller on element)
- `plugins/debug/plugins/slow-ops/server/internal/record-slow-op.ts` (`parent`→`caller`, widen type)
- `plugins/debug/plugins/slow-ops/server/internal/install-slow-span.ts` (call site)
- `plugins/debug/plugins/slow-ops/server/internal/handle-client-slow-op.ts` (forward `body.caller`)

**Part B (new plugin):** `plugins/debug/plugins/op-rate/**` (8 files above)
**Part B (one edit):** `plugins/reports/shared/types.ts` (`SERVER_REPORT_SOURCES`)

**Reused as-is (no change):** `mergeCaller` + the second-update merge in
`record-slow-op.ts`; `CallerBreakdownLines` pane UI; the reports engine
(`recordReport`, `ReportKind`, `Reports.KindView`); `defineJob`/`getConfig`/
`defineConfig`; `getRuntimeProfile`.

---

## Verification

1. `./equin build` (regenerates the registry for the new plugin + applies any
   docs/checks). Then `./equin check` (boundaries, plugins-registry-in-sync,
   plugins-doc-in-sync, type-check).

2. **Part A (caller attribution) — end to end:**
   - Open `http://<worktree>.localhost:9000` on a route with a slow-settling
     live-state resource (or temporarily lower `elementMs` in Settings → Config so
     a normal resource trips).
   - `query_db`: `SELECT operation, callers FROM slow_ops WHERE operation_kind = 'element';`
     → `callers` is non-empty and contains `{ kind: "route", label: "<pathname>" }`.
   - Debug → Slow Ops pane: the element row shows `↳ route:/… ×N`.

3. **Part B (call-rate) — end to end:**
   - Lower a threshold (e.g. `httpPerWindow`) to a small value in Settings → Config,
     or use the live-state churn emitter (`window.__liveStateEmit`) / repeated
     navigation to hammer an op.
   - Wait one monitor tick (≤5 min) — or temporarily set cron to `* * * * *` for a
     faster loop while testing.
   - `query_db` against `reports`: a row with `kind = 'op-rate'` and
     `fingerprint = 'op-rate:<kind>:<label>'`; Debug → Reports shows the
     `OpRateSummary` line and a linked task under the Reports container.
   - Confirm a *single* tick does not fire on the first observation (baseline seed),
     and that the per-kind threshold keeps idle `db` ops from firing.

4. Optional `bun test` for a pure helper (`kindThreshold`, reset-safe delta) if
   extracted into a testable function.
