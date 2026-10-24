# Auto-report slow operations as a `slow-op` report kind

## Context

The app sometimes feels slow with no record of it: page loads can take >2s before
anything displays, individual elements can take >1s to appear, and some DB
queries / server operations are slow. None of this is surfaced or tracked today,
so slowness goes uninvestigated.

The `reports` plugin (formerly `crashes`) was just generalized to carry a `kind`
discriminator and reuse one dedup / count / noise / task-filing / notification /
debug-pane pipeline — a crash is just `kind='crash'`
(see [research/2026-06-13-global-rename-crashes-to-reports.md](2026-06-13-global-rename-crashes-to-reports.md)).
This is the planned follow-up: add a **`slow-op`** report kind that flows through
the exact same machinery and shows up in **Debug → Reports** and as filed tasks.

Four signals, all four in scope:

| Signal | Where it's detected | Threshold (default) |
|---|---|---|
| Client page load | custom first-paint marker | 2000 ms |
| Client element appearance | live-state `useResource` settle | 1000 ms |
| Server loader / HTTP | `runtime-profiler` spans | 2000 ms |
| Slow DB query | `runtime-profiler` db spans | 500 ms |

**All thresholds live in `config_v2`, not hardcoded.** **Cold-start slowness IS a
real report, not noise** — no first-occurrence / cold-cache suppression rule.
Dedup is by operation (a recurring slow query collapses to one row with a growing
`count`, exactly like crashes dedup by fingerprint).

## Design overview

Three structurally-identical "the owner exposes a generic push hook, `reports`
consumes it" seams (collection-consumer separation) — mirroring the existing
`error-boundary` → `registerBoundaryReporter` → `ReportCollector` pattern:

1. **`runtime-profiler/core`** gains `onSlowSpan(handler, { thresholdMs })` — the
   first push mechanism in that plugin (today it is pull-only via
   `getRuntimeProfile`). Stays dependency-free. Covers loader / http / db.
2. **`live-state/web`** gains `registerSlowResourceReporter(fn)` +
   `reportSlowResource(info)` (module-level setter, same shape as
   `error-boundary/web/reporter.ts`). `use-resource.ts` measures mount→settle and
   fires it. Stays dependency-free of `reports` / `config`.
3. **Page load** is measured directly in the new slow-ops web component (nobody
   else owns navigation timing) — `performance.now()` captured in a post-paint
   `requestAnimationFrame` inside the component's mount effect. Because the
   component mounts as a `Core.Root` contribution (part of the app's first real
   render after boot tasks + `setState`), that timestamp ≈ navigation→first-content.

All four paths funnel into the **single existing entry point**
`recordReport({ kind: "slow-op", … })` — no new ingestion infra. The `reports`
core pipeline (schema, fingerprint, title/notification, conflict-set) gets a few
small **`kind`-aware** branches. New code lives in a new sub-plugin
`plugins/reports/plugins/slow-ops/`, mirroring `endpoint-errors` / `mutation-errors`.

### Storage decision

Per the precedent set by the rename doc — crash-specific columns are nullable and
a new kind "simply leaves them NULL and adds its own columns" — add **four
nullable columns** to the existing `reports` table (no JSONB, no side table; the
debug pane reads the hand-written `ReportSchema` and a side table / blob would
break that):

- `operation_kind text` — slow-op subtype: `"page-load" | "element" | "loader" | "http" | "db"`
- `operation text` — stable operation identity (drives the fingerprint)
- `duration_ms integer` — last observed duration
- `threshold_ms integer` — the threshold that was exceeded

Crash columns (`error_type`, `stack`, `component_stack`, `slot`, `label`) stay
NULL for slow-op rows; these four stay NULL for crash rows.

### Fingerprint / dedup

Current `fingerprint(errorType, stack)` is useless for slow-ops (no stack). Add
`fingerprintSlowOp(operationKind, operation)` to `shared/fingerprint.ts` reusing
the existing `sha256Hex` helper: `sha256Hex("slow-op|" + operationKind + "|" + operation).slice(0,16)`.
`recordReport` branches on `kind` to pick the strategy. The fingerprint excludes
`durationMs`, so the same slow operation always lands on the same row → `count`
grows, one task, one bell row. (A third kind later → promote the branch to a
per-kind strategy map; two kinds = a branch, as the rename doc anticipated.)

Per-operation operation identities (stable, no literals):
- **page-load** → `location.pathname` (query stripped)
- **element** → `${resource.key} ${JSON.stringify(params)}` (same key the hook uses)
- **loader / http / db** → the span `label` (resource key / route / parameterized SQL — all already `$1`-placeholdered and capped at 500 chars by the profiler)

## Files to change

### 1. `runtime-profiler` — add the push hook

**`plugins/infra/plugins/runtime-profiler/core/recorder.ts`**
- Add `export type SlowSpanHandler = (span: SlowSpan) => void;`
- Module-level `const slowSpanSubs: { thresholdMs: number; handler: SlowSpanHandler }[] = [];`
- `export function onSlowSpan(handler, opts: { thresholdMs: number }): { dispose(): void }` — push a sub, return a disposer that splices it out.
- In `record()`, after the `slowest` ring push, build the `SlowSpan` once and `for (const sub of slowSpanSubs) if (durationMs >= sub.thresholdMs) sub.handler(span);`. **No try/catch** (fail loudly) — the consumer's handler is a non-throwing fire-and-forget scheduler (see §4). `thresholdMs` is a static floor (perf guard so fast spans never call back); the consumer re-registers on config change (§4) so the floor tracks the lowest configured threshold, and does final per-kind gating in the handler.
- **`core/index.ts`** — export `onSlowSpan` and `SlowSpanHandler`.

### 2. `live-state` — add the slow-resource seam

**`plugins/primitives/plugins/live-state/web/slow-resource-reporter.ts`** (new) — copy the shape of `plugins/primitives/plugins/error-boundary/web/reporter.ts`:
```ts
export interface SlowResourceInfo { key: string; params: unknown; durationMs: number; }
type Reporter = (info: SlowResourceInfo) => void;
let reporter: Reporter | null = null;
export function registerSlowResourceReporter(fn: Reporter | null): void { reporter = fn; }
export function reportSlowResource(info: SlowResourceInfo): void { reporter?.(info); }
```

**`plugins/primitives/plugins/live-state/web/use-resource.ts`**
- `const startRef = useRef(performance.now());` and `const reportedRef = useRef(false);` near the top.
- A `useEffect` watching `pending`: when it flips `true → false` and `!reportedRef.current`, set the flag and `reportSlowResource({ key, params: p, durationMs: performance.now() - startRef.current })`. (Pre-hydrated resources settle at ~0 ms → never slow, correctly ignored. live-state stays threshold-agnostic — the consumer gates.)

**`plugins/primitives/plugins/live-state/web/index.ts`** — export `registerSlowResourceReporter` + `SlowResourceInfo`.

### 3. `reports` core — make the pipeline `kind`-aware

**`plugins/reports/server/internal/tables.ts`** — add the four nullable columns (`operationKind`, `operation`, `durationMs`, `thresholdMs`). They flow into the insert automatically via the existing `...verbatim` spread in `recordReport`.

**`plugins/reports/core/resources.ts`** — add the four fields to `ReportSchema` (`operationKind/operation: z.string().nullable()`, `durationMs/thresholdMs: z.number().int().nullable()`) so the resource payload + debug pane carry them. (`server/internal/resources.ts` already does `db.select().from(_reports)` — picks them up with no change.)

**`plugins/reports/shared/types.ts`** — add `"server-slow-op"` to `SERVER_REPORT_SOURCES`, `"client-slow-op"` to `CLIENT_REPORT_SOURCES`; add `operationKind`, `operation`, `durationMs`, `thresholdMs` (all `.nullable().optional()`) to `ReportBodySchema`. `ReportBody` / `ReportInput` / `ClientReportBody` derive automatically.

**`plugins/reports/shared/fingerprint.ts`** — add `fingerprintSlowOp(operationKind, operation)` (reuse existing `sha256Hex`).

**`plugins/reports/server/internal/record-report.ts`** — minimal `kind`-aware branches:
- Fingerprint: `const fp = kind === "slow-op" ? await fingerprintSlowOp(input.operationKind ?? "", input.operation ?? "") : await fingerprintOf(input.errorType, input.stack);`
- `onConflictDoUpdate` set: for slow-op also refresh `durationMs`/`thresholdMs` to the latest values (build the `set` object then conditionally add these when `kind === "slow-op"`, so crash rows keep them NULL).
- `taskTitle` / notification: replace hardcoded `[crash]` / `"Crash recorded"` / `variant:"error"` with a small `KIND` map: `crash → { tag:"[crash]", notif:"Crash recorded", variant:"error" }`, `"slow-op" → { tag:"[slow-op]", notif:"Slow operation recorded", variant:"warning" }`. Slow-op rows have `errorType=null`, so the title is `[slow-op] <message>`.
- `taskDescription`: when `kind === "slow-op"`, emit an **Operation** block (operationKind, operation, `durationMs` ms vs `thresholdMs` ms threshold, count, first/last seen, url) instead of the Error/stack code-fence.
- Leave `bumpWindowAndCheck` (crash-loop / storm guard) as-is — it operates on the generic fingerprint and harmlessly throttles a slow op firing >20×/min (the row `count` still grows).

### 4. New sub-plugin `plugins/reports/plugins/slow-ops/`

**`shared/config.ts`** — `defineConfig({ name: "slow-op", fields: { pageLoadMs, elementMs, loaderMs, httpMs, dbMs } })` using `intField` from `@plugins/fields/plugins/int/plugins/config/core`, defaults `2000 / 1000 / 2000 / 2000 / 500`. (Mirror `plugins/backup/shared/config.ts`.) The Settings → Config UI renders all five for free.

**`server/index.ts`** — `contributions: [ConfigV2.Register({ descriptor: slowOpConfig })]`; in `onReady`, `watchConfig(slowOpConfig, (t) => reinstall(t))`. `reinstall` disposes the prior `onSlowSpan` sub and registers a new one with `thresholdMs: Math.min(t.loaderMs, t.httpMs, t.dbMs)` (the floor). Handler maps `span.kind` (`http|db|loader`) → the matching config threshold, returns if `span.durationMs < threshold`, else schedules:
```ts
void recordReport({
  kind: "slow-op", source: "server-slow-op",
  operationKind: span.kind, operation: span.label,
  durationMs: Math.round(span.durationMs), thresholdMs: threshold,
  message: `${span.kind} ${span.label} took ${Math.round(span.durationMs)}ms (threshold ${threshold}ms)`,
}).catch((e) => { /* rethrow non-Error per no-bare-catch; reports failure must not corrupt the request */ });
```
(The synchronous part only schedules — never throws into the profiler hot path.)

**`web/index.ts`** — `contributions: [ConfigV2.WebRegister({ descriptor: slowOpConfig }), Core.Root → <SlowOpCollector/>]`.

**`web/components/slow-op-collector.tsx`** — a `Core.Root` component (like `ReportCollector`):
- `const cfg = useConfig(slowOpConfig);` kept in a ref so the reporter closures read live values.
- `useEffect([])`: `requestAnimationFrame(() => { const ms = performance.now(); if (ms > cfgRef.current.pageLoadMs) report({ kind:"slow-op", source:"client-slow-op", operationKind:"page-load", operation: location.pathname, durationMs: Math.round(ms), thresholdMs: cfgRef.current.pageLoadMs, message: \`page load \${Math.round(ms)}ms (threshold …)\`, url: location.href }); })`.
- `useEffect([])`: `registerSlowResourceReporter((info) => { const t = cfgRef.current.elementMs; if (info.durationMs <= t) return; report({ kind:"slow-op", source:"client-slow-op", operationKind:"element", operation: \`\${info.key} \${JSON.stringify(info.params)}\`, durationMs: Math.round(info.durationMs), thresholdMs: t, message: … }); })`; cleanup `registerSlowResourceReporter(null)`.

**`package.json`** — `@singularity/plugin-reports-slow-ops`, depending on the barrels it imports (`reports/web`, `reports/server`, `primitives/live-state/web`, `infra/runtime-profiler/core`, `config_v2/{core,web,server}`, `fields/.../int/.../config/core`).

### 5. Debug pane (optional, small)

**`plugins/debug/plugins/reports/web/components/reports-view.tsx`** — when `c.operationKind` is set, show a duration chip (e.g. `2.3s`) next to the existing `kind` badge. The `kind="slow-op"` badge already renders for free. No structural change needed.

## Boundaries / cycles

- `reports/slow-ops` imports parent barrels `@plugins/reports/{web,server}` (sub-plugin → parent is legal) and the three primitive cores. No back-edge: `reports` core/web/server never import `slow-ops`, `runtime-profiler` and `live-state` never import `reports`. DAG preserved.
- `runtime-profiler/core` stays zero-dependency (only adds an internal callback array). `live-state/web` gains only a module-level setter — no new imports.

## Verification

1. `./equin build` — generates the additive column migration + `slow-op.origin.jsonc`, regenerates registry/docs, restarts. Commit the generated SQL so `migrations-in-sync` passes.
2. `./equin check` — `migrations-in-sync`, `plugin-boundaries`, `plugins-doc-in-sync`, `type-check` green.
3. App loads at `http://att-1781341189-mov4.localhost:9000`. Open **Debug → Reports**; confirm it still renders crashes.
4. **Server span:** temporarily lower `dbMs`/`loaderMs` to ~1 ms via Settings → Config (or the JSONC), exercise a page, and confirm `query_db` on `reports` shows rows with `kind='slow-op'`, `operation_kind in ('db','loader','http')`, populated `duration_ms`/`threshold_ms`, crash columns NULL; a task is filed under the **Reports** meta-task; repeat hits grow `count` on one row. Restore thresholds.
5. **Element:** lower `elementMs` to ~1 ms, reload; confirm `operation_kind='element'` rows keyed by resource key, deduped per resource.
6. **Page load:** lower `pageLoadMs` to ~1 ms, reload; confirm one `operation_kind='page-load'` row keyed by pathname.
7. Confirm **cold start is reported, not suppressed** — the first (cold) load produces a row; no noise rule mutes it.
8. Confirm reactivity: changing a threshold in Settings → Config takes effect without a server restart (server `watchConfig` re-installs the hook; client `useConfig` re-renders).
