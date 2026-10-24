# Unified slow-event tracing: durable traces, Slow Events Gantt, generic perf-event API

**Date:** 2026-07-08 · **Category:** global (debug, infra, reports)

## Context

When a server span crosses its slow threshold today, the system produces **seven artifacts** for one incident: the profiler aggregate + ring (fine — substrate), a `slow_ops` row, a `slow-op-markers.jsonl` line, a `_reports` row, a bell notification, a `flight-recorder.jsonl` snapshot, and ambient `health.jsonl` samples. The richest artifact — the flight-recorder snapshot, which captures the entire coherent instant (open spans, completed spans, gate occupancy, contention) — is a **dead-end JSONL nobody reads**: no UI, no linkage, no retention policy beyond trim-half rotation. Meanwhile the trip identity is persisted 3×, contention 3×, wait breakdowns 3×, and two near-identical `onSlowSpan` installers live in `slow-ops` and `flight-recorder`.

This plan:

1. Persists flight snapshots **durably** (DB, 7-day TTL) as *traces*.
2. Adds a **Debug → Slow Events pane**: list of recent slow events; clicking one opens a **unified Gantt** (trip + concurrent/preceding spans, wait/work split, gates, contention).
3. **Unifies** the duplicated slow-reporting machinery: one `onSlowSpan` installer, one fan-out (aggregate + trace + report), flight-recorder deleted.
4. Introduces a **generic, open contribution API for perf-event classes** — future agents adding any perf signal (CPU profiles, heap sampling, GC pressure, domain events) are forced through one registry, and anything registered automatically appears in the trace snapshot and the Gantt.
5. Fixes the **count×cost blind spot**: the op-rate monitor gains an aggregate-time trip-wire (per-op Σms/window + per-kind rollup).

Reports stays the **alert funnel** (bell, dedupe, tasks-on-demand); the trace engine is the **evidence store**; a report links to its trace.

---

## 1. Architecture

### Plugin tree

New umbrella `plugins/debug/plugins/trace/` (mirrors the `search`/`history` umbrella-with-engine pattern and reports' engine+kind pattern):

```
plugins/debug/plugins/trace/
├── package.json                 # umbrella, description only
├── plugins/
│   ├── engine/                  # THE generic engine — registry, storage, admission, endpoints, sweep
│   │   ├── core/                # TraceTrigger/TraceSnapshot types + zod, traceFields, routes, trace config
│   │   ├── server/              # traces table, TraceEventClass registry, captureTrace(), rate-limit,
│   │   │                        #   list/get endpoints, sweep job, test-trigger endpoint
│   │   └── web/                 # Trace.Lane + Trace.TriggerSummary dispatch slots, generic fallback lane,
│   │                            #   trace config web registration
│   ├── spans/                   # built-in event class: server spans (captureFlightWindow) + span lanes
│   ├── gates/                   # built-in event class: gate gauges (readGateGauges) + occupancy strip
│   ├── contention/              # built-in event class: contention snapshot (async enrich) + footer card
│   └── pane/                    # Debug → Slow Events: list pane + detail Gantt pane
```

Why `debug/` and not `infra/`: every producer and consumer is debug-domain (slow-ops, op-rate, the pane); `infra/` is for primitives feature plugins build *on*. The engine's contract to non-debug plugins is one function (`captureTrace`) and one contribution token — a barrel import, no framework coupling.

Why `spans`/`gates`/`contention` are **sub-plugins, not engine internals**: the collection-consumer rule. The engine owns the registry and generic interfaces and must never name a contributor; the pane consumes only the generic snapshot sections + dispatch slot. Making the built-ins real contributors proves the registry (exactly how `reports` never names `crash`). It also matches the recorded preference for sub-plugin modularity even when mandatory.

### The generic perf-event API (the hard requirement)

**Server contract** (`trace/plugins/engine/server`), mirroring `ReportKindSpec` (`plugins/reports/server/internal/report-kinds.ts:20`) + `defineServerContribution`:

```ts
// What one event class contributes. The engine never names a class; the pane
// never names a class. Adding a class = one new plugin, zero engine edits.
export interface TraceEventClassSpec<T = unknown> {
  /** Stable lane/section id, e.g. "spans", "gates", "contention", "heap". */
  id: string;
  /** Validates this class's snapshot section. Persisted under snapshot.events[id]. */
  schema: z.ZodType<T>;
  /**
   * Phase 1 — runs SYNCHRONOUSLY at the trip instant, in the profiler hot
   * path. Must be cheap (no IO, no heavy allocation) and never throw; this is
   * what makes the snapshot a coherent instant. Return undefined to skip.
   */
  captureAtTrip?(ctx: TripContext): unknown;
  /**
   * Phase 2 — async enrichment, run by the engine under runWithoutProfiling.
   * Receives phase-1 output + this class's ring slice (see `ring`). The
   * returned value is schema-validated and persisted.
   */
  enrich?(ctx: TripContext, atTrip: unknown, ringSlice: RingEvent[]): Promise<T> | T;
  /**
   * Ambient ring: the engine keeps a bounded in-memory ring of events this
   * class emits continuously (samples, markers). At trip, events overlapping
   * [windowStartMs, atMs] are handed to enrich (or persisted directly when no
   * enrich). This is how a future RAM/GC sampler gets a Gantt lane for free.
   */
  ring?: { max: number };
}

export interface TripContext {
  id: string;            // trace id (uuid, minted synchronously for linkage)
  atMs: number;          // profiler clock (performance.now domain)
  wallTime: string;      // ISO — wall-clock anchor
  windowStartMs: number; // atMs − max(trigger.durationMs, cfg.windowMs)
  trigger: TraceTrigger;
}

export interface RingEvent { tMs: number; data: unknown }

// Factory + registration, mirroring defineJob's idiom: the factory returns a
// handle; the plugin lists it. `emit` exists only when `ring` is declared.
export function defineTraceEventClass<T>(spec: TraceEventClassSpec<T>):
  { contribution: ServerContribution; emit(event: RingEvent): void };

export const TraceEventClass = defineServerContribution<TraceEventClassSpec>("trace-event-class");

// THE generic entry point for capturing a trace. Any plugin may trigger:
// slow spans, client signals, op-time budget trips, a future GC-pause
// detector. Admission (cooldown + global cap + enabled) runs first; the sync
// capture phase runs inline (hot-path safe); enrich + persist detach under
// runWithoutProfiling. Returns the minted id (for report/row linkage) or null
// when rate-limited/disabled.
export function captureTrace(trigger: TraceTrigger): { id: string } | null;
```

```ts
// trace/plugins/engine/core — plain shared data (closed, enumerable → core/,
// per the server-core CLAUDE.md rule; the OPEN set is the class registry above).
export interface TraceTrigger {
  kind: string;          // "loader" | "http" | … | "client-element" | "op-time" — open vocabulary
  label: string;
  durationMs: number;
  thresholdMs: number;
  detail?: unknown;      // trigger-specific extras (SpanRef parent, waits, selfMs…)
}
export interface TraceSnapshot {
  v: 2;                  // flight-recorder snapshots were v1
  id: string;
  atMs: number;
  wallTime: string;
  worktree: string;
  windowStartMs: number;
  trigger: TraceTrigger;
  events: Record<string, unknown>;  // classId → schema-validated payload
}
export const traceListRoute  = defineRoute({ id: "traces", segment: "traces" });
export const traceDetailRoute = defineRoute({ id: "trace-detail", segment: "x/:id" /* under traces */ });
// routes live in core so server renderTask + other plugins' web KindViews can
// deep-link — byte-for-byte the reports/core/routes.ts precedent.
```

**Web contract** (`trace/plugins/engine/web`):

```ts
export const Trace = {
  // One Gantt lane group per snapshot section, dispatched by classId.
  // Rendered inside GanttContainer; components use useGanttContainerContext()
  // for px mapping. Fallback = GenericEventLane (point events / JSON detail),
  // so an event class with no web presence still shows up — loudly, not silently.
  Lane: defineDispatchSlot<TraceLaneProps, string>("trace.lane", {
    key: (p) => p.classId,
    fallback: GenericEventLane,
  }),
  // Optional richer summary block in the detail header, dispatched by trigger kind.
  TriggerSummary: defineDispatchSlot<{ trace: TraceSnapshot }, string>("trace.trigger-summary", {
    key: (p) => p.trace.trigger.kind,
    fallback: GenericTriggerSummary,
  }),
};
export interface TraceLaneProps {
  classId: string;
  payload: unknown;          // the class's schema-validated section (class's web side narrows it)
  trace: TraceSnapshot;      // trigger + clock anchors for normalization
}
```

No web↔server codegen bridge is needed: the snapshot is self-describing (`events` keys), and the dispatch fallback covers unregistered classes. That keeps the open set slot-shaped on each runtime independently, without a `*-in-sync` check.

### How existing + future classes map

| Class | plugin | captureAtTrip | enrich | ring | web lane |
|---|---|---|---|---|---|
| `spans` | `trace/spans` | `captureFlightWindow({windowStartMs})` (`runtime-profiler/core/recorder.ts:571`) | identity | — | 7 SpanKind lane groups, multi-span rows, wait/work segments |
| `gates` | `trace/gates` | `readGateGauges()` (`recorder.ts:533`) | identity | — | occupancy strip (active/queued/max per layer) |
| `contention` | `trace/contention` | — | `getContentionSnapshot()` | — | footer card (loadAvg, pg backends, top DBs) |
| client signals | (future) | — | slice passthrough | ✓ | markers on the timeline |
| heap/GC/CPU samplers | (future) | — | slice passthrough | ✓ | sampled-series lane via GenericEventLane or custom |

### Trigger sources (who calls `captureTrace`)

1. **The unified slow-span pipeline** in slow-ops (see §3) — replaces both today's installers.
2. **The client slow-op endpoint** (`slow-ops/server/internal/handle-client-slow-op.ts`) — a slow page-load/element now also captures the server-side instant (the settle is ~all transport/server wait, so the server window is exactly the evidence needed).
3. **The op-time trip-wire** (§5) — a budget breach captures "what is in flight right now while this op burns time".
4. **`POST /api/debug/trace/test-trigger`** — the test endpoint (moved from flight-recorder's `handle-test-slow-op.ts`), for verification.

### Reports integration

Reports stays the funnel, untouched structurally. Linkage is one field: callers that captured a trace put `traceId` in the report's `data` jsonb (no migration — same trick as `transportColdStart` in `record-slow-op.ts:224-228`). KindViews render a "View trace" `LinkChip` via `traceDetailRoute.link(...)`; `renderTask` descriptions include the trace URL so filed tasks carry the evidence pointer.

---

## 2. Data model

### `traces` table — `trace/plugins/engine/server/internal/tables.ts`

Byte-for-byte the boot-profile storage trio (`boot-profile/server/internal/tables.ts`, `handlers.ts`, `cleanup-job.ts`), which is the established TTL'd-snapshot precedent:

```ts
const traces = defineEntity("traces", traceFields, {
  primaryKey: "id",
  columns: { id: { default: defaultRandom() }, createdAt: { default: defaultNow() } },
  indexes: (t) => [index("traces_created_at_idx").on(t.createdAt)],
});
export const _traces = traces.table;   // drizzle-kit glob discovery
```

`traceFields` (in `core/`, so the wire schema derives from the same record — `defineEntity` makes drift unrepresentable):

| column | type | purpose |
|---|---|---|
| `id` | uuid | pk; minted synchronously by `captureTrace` so linkage precedes persistence |
| `createdAt` | timestamptz + index | list order + sweep range delete |
| `worktree` | text | mirrors `boot_traces`; keeps cross-worktree fan-out possible later |
| `triggerKind` | text | flat list metadata — the list endpoint never reads the blob |
| `triggerLabel` | text | " |
| `durationMs` | float | " |
| `thresholdMs` | float | " |
| `snapshot` | jsonb | the full `TraceSnapshot`, zod-pinned |

**jsonb, not normalized.** A snapshot is written once, read whole by one pane, never queried per-span, and its `events` sections are class-owned open shapes — exactly `boot_traces.snapshot`. Normalizing spans would freeze the class payloads into SQL and defeat the open registry.

**`ExcludeFromChangeFeed` — yes.** Trace writes happen *exactly when the system is slow*; change-feed → live-state recompute → push on every write would add load at the worst moment and can self-amplify (the same recorded reason `slow_ops` is excluded). The list pane hydrates on open via `GET /api/traces` (metadata only, newest first, LIMIT 200) with a Refresh button — mirroring the boot-profile list pane exactly. Detail: `GET /api/traces/:id` with the UUID-guard → 404 pattern from `boot-profile/server/internal/handlers.ts`.

**TTL sweep:** `debug.trace-cleanup` — `defineJob`, `dedup: "singleton"`, `schedule: { cron: "0 3 * * *", perWorktree: true }`, `maxAttempts: 3`, `RETENTION_MS = 7 days` — a copy of `bootTraceCleanupJob` with the constant changed. Retention is a code constant (precedent), not config.

**Clock normalization.** Snapshot stores both clocks: `atMs`/`windowStartMs`/span `t0`/`t1` on the profiler clock, `wallTime` as the single wall anchor. The web normalizer converts to window-relative ms (`t − windowStartMs`) for the Gantt and to wall-clock for display (`wallTime + (t − atMs)`). Ring events use `performance.now()` (same domain — documented on `RingEvent.tMs`).

**Fate of the old sinks:**
- `flight-recorder.jsonl` — no longer written (plugin deleted). Existing files rot harmlessly.
- `slow-op-markers.jsonl` — **kept**: health-monitor reads it for spike lines (`readSlowOpMarkers`), and it's per-slow-op (uncapped) while traces are rate-limited — not equivalent granularity. Not duplicated machinery.
- `slow_ops` table — kept as the deduped aggregate store (no TTL; bounded by op cardinality). Its `recentSamples` ring gains an optional `traceId` per sample so the aggregate view can deep-link the freshest evidence. Its standalone pane, however, **merges into the Slow Events pane as a tab** (§4) — one sidebar entry for all slowness.
- `stall-profiles.jsonl` — out of scope; noted as a natural future ring-class migration.

---

## 3. Capture consolidation

### The single installer

`slow-ops/server/internal/install-slow-span.ts` becomes THE one `onSlowSpan` subscriber (flight-recorder's `install-hook.ts` is deleted — they are already near-identical twins with the same floor math and the same `resolveSlowThreshold`):

```ts
disposer = onSlowSpan((span: SlowSpan) => {
  const threshold = resolveSlowThreshold(span, thresholds);
  if (span.durationMs < threshold) return;
  // 1. Evidence — sync phase inline (admission first: one Map lookup per slow
  //    span in a storm), enrich+persist detached under runWithoutProfiling.
  const trace = captureTrace({
    kind: span.kind, label: span.label,
    durationMs: span.durationMs, thresholdMs: threshold,
    detail: { parent: span.parent, waits: span.waits,
              waitMs: span.waitMs, childMs: span.childMs, selfMs: span.selfMs },
  });
  // 2. Aggregate + 3. Report — the existing funnel, now stamped with the link.
  void recordSlowOp({ operationKind: span.kind, operation: span.label,
    durationMs: span.durationMs, thresholdMs: threshold,
    source: "server-slow-op", caller: span.parent, waits: span.waits,
    traceId: trace?.id });
}, { thresholdMs: floor });
```

`recordSlowOp` (`record-slow-op.ts:115`) gains `traceId?: string`, stamps it into the newest `recentSamples` entry and into the report `data`. Everything already runs under `runWithoutProfiling` — unchanged. The engine's async phase (contention query, insert) also runs under `runWithoutProfiling`, exactly as flight-recorder's `trip.ts:39` does today.

`onSlowSpan` subscriber count goes 2 → 1. The config-watch reinstall pattern stays (thresholds only); the engine reads its own admission config internally at trip time via `getConfig` (in-memory, cheap), so the installer no longer threads a second config.

### Ownership moves

| symbol | today | after |
|---|---|---|
| the `onSlowSpan` installer | slow-ops **and** flight-recorder | slow-ops only (calls `captureTrace`) |
| `resolveSlowThreshold` / `Thresholds` | slow-ops server barrel export (imported by flight-recorder) | **internalized** in slow-ops (sole consumer is its own pipeline) |
| rate-limit (cooldown + per-minute cap) + its bun:test | `flight-recorder/server/internal/rate-limit.ts` | moved to `trace/engine/server/internal/rate-limit.ts` (file + test move) |
| snapshot assembly | `flight-recorder/server/internal/build-snapshot.ts` | engine assembles the envelope; spans/gates/contention sections come from the class registry |
| test-slow-op endpoint | `POST /api/debug/flight-recorder/test-slow-op` | `POST /api/debug/trace/test-trigger` in the engine |
| `flight-recorder` config (enabled/cooldownMs/maxPerMin/windowMs) | flight-recorder core | `trace` config in engine core, same four fields |
| `getContentionSnapshot` | imported by slow-ops + flight-recorder | imported by slow-ops + `trace/contention` (stays in `infra/contention`) |
| `readSlowOpMarkers`, `loadSeverity` | slow-ops exports | unchanged (health-monitor / cluster still consume) |

### Deleted plugin

`plugins/debug/plugins/flight-recorder/` — entirely (core config, web config registration, server: install-hook, trip, build-snapshot, persist, rate-limit [moved], handle-test-slow-op [moved], CLAUDE.md). See §6 for the full inventory.

---

## 4. The pane (Debug → Slow Events)

`trace/plugins/pane` — two panes + sidebar entry, standard conventions (`Pane.define` + `PaneChrome` + `DebugApp.Sidebar` + `sidebarNavItem`, detail via the core `defineRoute`s so reports can link — the reports-pane pattern).

### One pane for all slowness (Slow Ops merges in)

The root pane is a **tabbed slot host** (`defineTabbedView`, byte-for-byte the pattern `slow-ops/plugins/pane` uses today for its Local/Cluster tabs): `trace/pane` owns a `SlowEvents.View` tab slot and contributes the **Events** tab (the trace list below) itself. The existing Slow Ops surfaces re-target their tab contributions into this slot:

- **Aggregates** tab — `slow-ops/plugins/pane` keeps its `SlowOpsView` DataView but contributes it as a tab instead of owning a pane; its own `Pane.Register` + `DebugApp.Sidebar` entry and the `SlowOps.View` slot are deleted.
- **Cluster** tab — `slow-ops/plugins/cluster` re-targets its existing tab contribution to `SlowEvents.View`.

Import direction stays acyclic: slow-ops (server) → trace/engine (`captureTrace`), slow-ops pane/cluster (web) → trace/pane (slot token); nothing in `trace/` imports slow-ops. The Debug sidebar ends with ONE "Slow Events" entry where today there are two surfaces (Slow Ops + nothing-for-flight-recorder).

### List — the Events tab (`/debug/traces`)

DataView (list view), hydrate-on-open via `useEndpoint(listTraces)` + Refresh button (boot-profile list precedent; no live resource — justified in §2). Columns:

- **When** — `RelativeTime(createdAt)`
- **Trigger** — kind `Badge` (colored per kind; reuse `attempt-status`-style metadata map in pane internals)
- **Operation** — `triggerLabel`, truncating
- **Duration** — `durationMs`, monospace
- **Over budget** — `durationMs / thresholdMs` as `×N.N` (the scent of severity)

Row activate → detail pane (`openPane(..., { mode: "push" })`, `selectedRowId` via `detailPane.useRouteEntry()` — the reports/tasks list pattern).

### Detail — `/debug/traces/x/:id`

`GET /api/traces/:id` (404 → graceful not-found, boot-profile pattern). Layout:

1. **Header**: `Trace.TriggerSummary.Dispatch` — trigger kind/label, duration vs threshold, wall time, worktree; the spans-class contribution renders the trip's wait/child/self decomposition + per-layer waits as chips.
2. **Gantt**: one `GanttContainer` (from `debug/profiling` — reused as-is: TimeAxis, drag-zoom `useGanttZoom`, dbl-click reset, `GanttContainerContext`), `totalMs = atMs − windowStartMs`. Inside, for each `snapshot.events` key **in registry order**: `<Trace.Lane.Dispatch classId={id} payload={…} trace={…}/>`. The pane names no class.
   - **Trip row pinned first** (rendered by the pane from `trigger` — generic).
   - **spans lanes**: grouped by SpanKind (7 phase groups via `PhaseGroup`); within a group, one row per label with **multiple absolute bars per row** (the push-gantt pattern, now generic — see below). Open spans render to the window edge with the pulse treatment; bar fill = kind color, treatment = status (push-gantt's fill=what/treatment=state convention). Completed spans with `waitMs > 0` originally rendered a lighter leading *wait* segment sized `waitMs/durationMs` (WaitWorkRow convention) — an approximation, since waits were then stored as union totals, not intervals. Superseded by positioned wait bands (`research/2026-07-09-global-positioned-wait-bands.md`): the recorder now retains a bounded per-`(entry,layer)` band list, so waits paint at their true offsets and the detail strip reports any unplaced remainder as `unpositioned`.
   - **gates lane**: an occupancy strip at the trip instant — one chip per layer `active/max (+queued)`, saturated gates highlighted. Point-in-time by nature; rendered as a strip, not time bars.
   - **contention**: footer card (loadAvg/cpuCount, pg backends, top databases).
   - **Unknown classes**: `GenericEventLane` — ring events as point markers, payload as expandable JSON. New classes are visible by default.
3. **Bottom detail strip**: click a bar → `SpanDetail` (existing component; no per-bar tooltips — repo-wide convention). Shows label, kind, t0/t1 (wall + relative), duration, parent (chain for open spans), per-layer waits, wait/child/self. Bar clicks coexist with drag-zoom via `onPointerDown` stopPropagation (push-gantt precedent).

### New/promoted Gantt primitives (in `debug/profiling`'s web barrel)

`debug/profiling` is the Gantt home (already imported by boot-profile, build-profiling, and the profiling sub-plugins), so the generic pieces go there — not a new primitives plugin:

- **`MultiSpanLane`** (new, `profiling/web/components/multi-span-lane.tsx`): label + one relative track hosting N absolute bars, each `{ id, startMs, durationMs, colorClass, treatment?: "solid"|"pulse", segments?: [{kind: "wait"|"work", ms}] }`, honoring the label `w-40` · track `flex-1` · duration `w-16` layout contract. Generalizes what `push-gantt.tsx` hand-rolls.
- **`WaitWorkRow`** (promoted from `boot-profile/web/components/wait-work-row.tsx` into the profiling barrel; boot-profile imports the promoted one and its local copy is deleted).

`normalizeTrace(snapshot) → { totalMs, lanes[] }` — a **pure function** in `trace/plugins/spans/web/internal/normalize.ts` (clamping to window, open-span extension, relative-time conversion, per-label row bucketing) with co-located `normalize.test.ts` (bun:test — pure logic, per testing rules).

### Report linkage in the UI (KindView gap fills)

- **`slow-op` KindView** (new — today this kind has NO KindView and falls back to raw message): one-line summary `kind label — Nms (threshold Mms)` + **View trace** LinkChip when `data.traceId` present. Contributed by slow-ops web (it owns the kind).
- **`render-loop` KindView** (gap fill, no trace): signature + mutation class one-liner. Contributed by `reports/render-loop` web.
- **`op-time` KindView** — §5.

---

## 5. Coverage fix: the aggregate-time trip-wire

Today alerting trips on per-call latency (`slow-op`) or call count (`op-rate`) but never **count×cost**. Extend the existing monitor (`op-rate/server/internal/monitor-job.ts`) — same job, same tick, one more diff:

1. **Per-op time budget**: alongside `lastCount`, keep `lastTotalMs` per `${kind}:${label}` (from `Aggregate.totalMs`, same reset-safe delta logic as `monitor-job.ts:70-75`). Trip when `deltaMs > kindMsBudget(kind, cfg)`.
2. **Per-kind rollup**: `Σ deltaMs` across all labels of a kind vs `kindMsBudget × cfg.rollupFactor` — catches cost smeared across many labels (each under its own per-op budget). One report per kind per breach, `data` carrying the top-10 contributing labels with their deltas.

**Config additions to `opRateConfig`** (7 + 1 fields, mirroring the `…PerWindow` naming): `httpMsPerWindow 30000`, `loaderMsPerWindow 60000`, `subMsPerWindow 15000`, `pushMsPerWindow 30000`, `flushMsPerWindow 60000`, `dbMsPerWindow 60000`, `jobMsPerWindow 120000`, `rollupFactor 4`. (Defaults = "this op consumed ≥N s of wall-clock inside a 5-min window"; to be sanity-checked against `get_runtime_profile` on main during implementation.)

**Report kind `op-time`** (new `ReportKind`, registered by the op-rate plugin — it stays the "profiler-diff monitor" plugin, description updated):
- variant `warning`, `notifCooldownMs ≈ 10 min` (same as op-rate)
- fingerprints: `op-time:<kind>:<label>` (per-op), `op-time:rollup:<kind>` (rollup)
- `data`: `{ kind, label?, msInWindow, callsInWindow, windowMs, budgetMs, topLabels? , traceId? }` — carrying calls **and** ms so the renderTask/KindView can state the rate×cost decomposition ("N calls × ~M ms avg").
- **Per-op trips also call `captureTrace`** with trigger `{ kind: "op-time", label, durationMs: msInWindow, thresholdMs: budgetMs }` — capturing what is in flight *right now* while the op burns time, and proving the generic trigger API from a second call site. Subject to normal engine admission; rollup trips don't capture (no single op to point at).
- Shares the existing TOP_N=20 cap + logged-overflow policy (one combined ranking, `deltaMs` desc).

**KindView**: one-liner `kind label — N.Ns/window across M calls (budget Bs)` + View trace chip. Registered next to the existing `OpRateSummary`.

Reports with `traceId` surface in the new pane implicitly: the trace exists in the Slow Events list with trigger kind `op-time`.

---

## 6. Cleanup inventory

**Deleted:**
- `plugins/debug/plugins/flight-recorder/` — entire plugin: `core/{index,config}.ts`, `web/index.ts`, `server/{index}.ts`, `server/internal/{install-hook,trip,build-snapshot,persist,handle-test-slow-op}.ts` (+ `rate-limit.ts`/`rate-limit.test.ts` moved, not deleted), `CLAUDE.md`, `package.json`.
- `plugins/debug/plugins/boot-profile/web/components/wait-work-row.tsx` (promoted into profiling).
- slow-ops' local `SlowOpSource` union (`record-slow-op.ts:24`) — replaced by the moved `ReportSource`.

**Moved / re-owned:**
- `ReportSource` from `plugins/reports/shared/types.ts:24` → `plugins/reports/core/` (the boundary wart: `shared/` is plugin-private and already forced slow-ops to re-declare it). Reports' internals import it from core.
- `rate-limit.ts` + test → `trace/engine/server/internal/`.
- Test endpoint → `POST /api/debug/trace/test-trigger`.
- `flight-recorder` config → `trace` config (Settings → Config entry moves with it).
- `WaitWorkRow` → `debug/profiling` web barrel.

**Internalized (removed from public barrels):**
- `resolveSlowThreshold`, `Thresholds` from `@plugins/debug/plugins/slow-ops/server` (flight-recorder was the only external importer).

**Merged (pane unification, §4):** `slow-ops/plugins/pane` loses its own `Pane.Register` + sidebar entry + `SlowOps.View` slot — its `SlowOpsView` becomes the **Aggregates** tab contributed into `trace/pane`'s `SlowEvents.View` slot; `slow-ops/plugins/cluster` re-targets its tab contribution to the same slot.

**Kept deliberately:** `slow_ops` table + resource + the aggregate/cluster views (as tabs); `slow-op-markers.jsonl` dual-write (`health-monitor` consumer); `readSlowOpMarkers`, `loadSeverity` exports; `reports` public API (~15 importers — stable).

**Docs:** `.claude/skills/debug/SKILL.md` (references flight-recorder → update to the trace engine + Slow Events pane), new `trace/CLAUDE.md` + per-sub-plugin CLAUDE.mds (autogen blocks via build; hand-written prose for engine: the class contract, admission, clock domains, the how-to-read-a-snapshot walk ported from flight-recorder's CLAUDE.md). `docs/plugins-*.md` regenerate on build.

**Optional (cleanup phase, non-blocking):** refactor `push-gantt.tsx` onto `MultiSpanLane`.

---

## 7. Risks & open questions

- **No per-instance span ids** — `parent` is `{kind,label}`, so exact tree reconstruction is heuristic for concurrent same-label spans. The Gantt therefore groups by kind and shows parent chains in the detail strip instead of drawing nested trees. A future recorder enhancement (monotonic per-entry seq id threaded into `FlightSpan`) would unlock true nesting — **out of scope**, noted for later.
- ~~**Wait placement is approximate**~~ — **resolved** by `research/2026-07-09-global-positioned-wait-bands.md`: the recorder now keeps a bounded per-`(entry,layer)` band list alongside the scalar union, so waits paint at their true offsets. The bounded successor risk is the band budget (`WAIT_BAND_CAP`): wait past the budget stays counted in `waitMs` and is reported as `unpositioned` text, never mispainted.
- **Ring floor** — completed spans <5ms never enter the flight ring; the Gantt shows ≥5ms completed spans only (document in the pane's empty-ish states).
- **Client-trigger clock skew** — a client-signal trace's window is anchored at server receipt, not the client moment; acceptable (the server-side activity around receipt is the evidence sought) and documented.
- **Shared admission across trigger sources** — a slow-span storm consumes the global `maxPerMin` budget and could starve an op-time capture in the same minute. Acceptable: op-time runs on a 5-min cadence and retries next tick. If it bites, per-source budgets are a config-only extension.
- **Snapshot size** — worst case (200 open × depth-8 chains + 400 completed) is tens of KB of jsonb; list endpoint never selects the blob; 7-day TTL bounds the table. No concern at rate-limit volumes (≤30/min hard cap).
- **Class payload validation failure** — engine validates each section against the class schema; on failure it files a server error report and **omits that section** (loud via report, isolated like a slot error boundary — never kills the whole snapshot, never silent).
- **Open question:** should client slow signals for one incident (loader span + element + page-load) coalesce onto ONE trace? Deferred — each now carries a trace whose windows overlap, which is already a big step; true incident coalescing needs a client-side incident id (future).
- **Open question:** migrate `slow_ops`' aggregate itself into an event class ("aggregates lane")? Deferred; the aggregate is a store, not an instant.

---

## 8. Phases

Each phase lands independently and ends green on `./equin build` (+ `./equin check`).

### Phase 1 — Gantt primitives (S, ~½ session)
Promote `WaitWorkRow` into `debug/profiling` web barrel; add `MultiSpanLane`; boot-profile switches to the promoted import.
**Files:** `plugins/debug/plugins/profiling/web/{index.ts,components/multi-span-lane.tsx,components/wait-work-row.tsx}`, `plugins/debug/plugins/boot-profile/web/components/{boot-profile-gantt.tsx,wait-work-row.tsx(del)}`.
**Verify:** build; Playwright screenshot of Debug → Boot Profile (unchanged rendering).

### Phase 2 — Trace engine + built-in classes + storage (L, ~1–1.5 sessions)
Umbrella + `engine` (core types/zod/fields/routes/config; server: table, registry, `defineTraceEventClass`, `captureTrace` with admission [moved rate-limit + test], list/get endpoints, sweep job, test-trigger endpoint; web: `Trace.Lane`/`TriggerSummary` slots + generic fallbacks + config registration) + `spans`/`gates`/`contention` server classes. Migration via `./equin build --migration-name traces`. Flight-recorder still alive (parallel writes for one phase — harmless).
**Verify:** `bun test plugins/debug/plugins/trace` (rate-limit, snapshot assembly, schema round-trip); `POST /api/debug/trace/test-trigger` then `query_db` `SELECT trigger_kind, jsonb_object_keys(snapshot->'events') FROM traces` → expect `spans`,`gates`,`contention`; GET endpoints via curl.

### Phase 3 — Capture consolidation (M, ~½–1 session)
Single installer in slow-ops (`captureTrace` + `recordSlowOp({traceId})`); `traceId` into report data + `recentSamples`; client endpoint captures traces; **delete flight-recorder**; internalize `resolveSlowThreshold`.
**Verify:** test-trigger → one `traces` row, one `slow_ops` row, one `_reports` row sharing the traceId (query_db join); `rg flight-recorder plugins/` → only research docs; registry regenerated without it; build green.

### Phase 4 — Slow Events pane + Slow Ops merge + report links (L, ~1–1.5 sessions)
`trace/pane` (tabbed host: Events tab list DataView + detail Gantt), the Slow Ops pane merge (Aggregates + Cluster tabs re-targeted, old pane/sidebar/slot deleted), `normalizeTrace` + bun:test, spans/gates/contention **web** lane contributions, slow-op + render-loop KindViews, renderTask descriptions gain trace URLs.
**Verify:** `bun test` on `normalize.test.ts` (pure logic, co-located next to source — bun:test, not `__tests__/`). Generate traffic (test-trigger ×3, `benchmark_boot` MCP, Debug → Live-State Emit), then `bun e2e/screenshot.mjs --url http://<wt>.localhost:9000/debug/traces --click <first row>` → before/after screenshots of list + Gantt; Aggregates and Cluster tabs render inside Slow Events and the old Slow Ops sidebar entry is gone; click Reports → slow-op row → View trace navigates.

### Phase 5 — op-time trip-wire (M, ~½–1 session)
Monitor extension (`lastTotalMs`, rollup), `opRateConfig` fields, `op-time` ReportKind + KindView, `captureTrace` on per-op trips.
**Verify:** lower a budget in Settings → Config (e.g. `dbMsPerWindow 1`), generate load (`benchmark_boot`), run the monitor via the queue debug pane (or wait one cron tick); expect an `op-time` report with `msInWindow`/`callsInWindow` + linked trace; restore config. bun:test the delta/rollup math (extract into a pure helper next to the job).

### Phase 6 — Cleanup + docs (S, ~½ session)
`ReportSource` → reports/core; delete slow-ops' local union; debug SKILL update; trace CLAUDE.md prose; optional push-gantt → MultiSpanLane refactor; full `./equin check`.
**Verify:** check suite green (boundaries, plugins-doc-in-sync, type-check); `rg "ReportSource" plugins/` shows single definition.

Dependency order: 1 → 2 → 3 → 4 → 5 → 6, but 5 only needs 2 (can run parallel to 4 after 3).
