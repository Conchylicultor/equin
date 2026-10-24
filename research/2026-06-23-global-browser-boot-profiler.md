# Browser Boot Profiler — Gantt debug page

## Context

We have a **server** boot Gantt (Debug → Profiling → "Boot") that shows the backend
startup phases (`register`, `onReadyBlocking`, …). But there is **zero client-side
boot instrumentation** today: nothing measures the browser path from the initial
HTTP request to first paint, nor how long the boot-critical resources (e.g. the
conversation sidebar) take to load, nor — for resources whose work is gated behind
a server round-trip — how much of that time is *waiting* vs *actual work*.

This plan adds a **new standalone Debug page** ("Boot Profile") that renders the
browser boot timeline as a Gantt, reusing the existing Gantt primitives. It
decomposes:

1. **Request → first paint** — Navigation Timing (TTFB, response download), script
   eval, plugin load, boot tasks, first React commit, and the browser's
   first-contentful-paint.
2. **Resources getting loaded** — each boot-critical resource (conversation
   sidebar, tasks, attempts, …) shipped in the boot snapshot.
3. **Wait vs actual work for gated resources** — each gated resource bar splits
   into *wait* (network + queue) and *work* (server loader/read time), using
   per-resource server timing added to the boot-snapshot endpoint.

The trace is captured **per page load** in an in-memory client store (one tab's
boot), read by the page; a "Reload & re-measure" button re-runs boot.

## Goals / Non-goals

- **Goal:** one-clock Gantt of the real browser boot, with wait/work split for the
  boot-critical resources.
- **Non-goal (v1):** wait/work split for route-scoped resources fetched over the WS
  after boot (the sub-ack carries no loader timing). v1 captures those as a single
  "wait" bar only — see Phase 2.
- **Non-goal:** persisting boot traces server-side / historical comparison. The
  store is ephemeral (current tab's boot). Slow-ops already persists outliers.

## Architecture

Four pieces. Everything shares **one clock**: `performance.now()` is relative to
`performance.timeOrigin` ≈ navigationStart, and Navigation/Paint Timing entries are
already on that same epoch — so no custom epoch wiring is needed. Every span's
`startMs` is `performance.now()` captured at that instant.

### 1. `primitives/perfs/boot-trace` — client capture leaf (new plugin under a new umbrella)

Introduce a new **`primitives/perfs/` umbrella** to cluster client-side
performance primitives (per the "group related plugins under an umbrella" rule).
It is a pure grouping folder — `CLAUDE.md` + `package.json`
(`@singularity/plugin-perfs`), no barrel (matching the `history` / `search`
umbrellas). `boot-trace` is its inaugural member; future client perf primitives
land here too. (The existing perf *surfaces* — `debug/profiling`,
`debug/render-profiler`, `debug/slow-ops`, `debug/health-monitor` — stay under
`debug` as app panes; `perfs` is for reusable primitives, not debug panes. No
existing plugin is relocated in this change.)

`boot-trace` itself is a dependency-free **web-only leaf library** (no
contributions, no UI). It owns the module-level boot-span store and is imported
eagerly by the framework boot path, so it is live before any resource mounts.

```ts
// plugins/primitives/plugins/perfs/plugins/boot-trace/web (barrel)
export type BootPhase = "navigation" | "scripts" | "boot-tasks" | "resources" | "paint";

export interface BootSpan {
  id: string;
  phase: BootPhase;
  label: string;
  startMs: number;       // performance.now() at start
  durationMs: number;
  workMs?: number;       // server actual work; wait = durationMs - workMs (gated resources)
  detail?: string;
}

export function startBootSpan(id: string, phase: BootPhase, label: string): () => void; // returns closer
export function markBootInstant(id: string, phase: BootPhase, label: string): void;     // 0-duration marker
export function recordBootSpan(span: BootSpan): void;                                   // explicit (with workMs)

export interface BootTrace {
  spans: BootSpan[];
  navigation: NavTiming | null;   // requestStart, responseStart(TTFB), responseEnd, domInteractive, domContentLoadedEventEnd
  paint: { firstPaintMs: number | null; firstContentfulPaintMs: number | null };
  firstCommitMs: number | null;   // first React commit
  capturedAt: number;
}
export function getBootTrace(): BootTrace;
```

- **Navigation / paint** are read lazily inside `getBootTrace()` from
  `performance.getEntriesByType("navigation")[0]` and `getEntriesByType("paint")`
  (entries persist in the buffer), then converted into `navigation`-phase /
  `paint`-phase `BootSpan`s for the Gantt.
- **First React commit** — on import the module pushes a one-shot subscriber into
  `window.__REACT_DEVTOOLS_GLOBAL_HOOK__.__commitSubscribers` (the commit bridge
  already installed by `index.html`), records `firstCommitMs`, then removes itself.

### 2. Instrumentation points (minimal, in the framework boot path)

These are the only edits outside the new plugins; all import
`@plugins/primitives/plugins/perfs/plugins/boot-trace/web`.

- `plugins/framework/plugins/web-core/web/main.tsx` — `markBootInstant("module-eval",
  "scripts", "main.tsx eval")` at top; `markBootInstant("create-root", "scripts",
  "createRoot")` before `createRoot(...).render(...)`.
- `plugins/framework/plugins/web-core/web/App.tsx` — wrap the two awaits in
  `App`'s effect (currently lines 63–64):
  ```ts
  const endLoad = startBootSpan("load-plugins", "scripts", "loadPlugins");
  const result = await loadPlugins(webEntries); endLoad();
  const endBoot = startBootSpan("boot-tasks", "boot-tasks", "runBootTasks");
  await runBootTasks(result.plugins); endBoot();
  markBootInstant("set-state", "paint", "App setState (first render)");
  ```
- `plugins/infra/plugins/boot-snapshot/web/internal/boot.ts` — record the snapshot
  fetch span **and** one `resources`-phase span per resource with its server
  `workMs` (see piece 3):
  ```ts
  const reqStart = performance.now();
  const { resources, timings } = await fetchEndpoint(bootSnapshot, {});
  const reqMs = performance.now() - reqStart;
  recordBootSpan({ id: "boot-snapshot", phase: "boot-tasks", label: "Boot snapshot fetch",
    startMs: reqStart, durationMs: reqMs });
  for (const key of Object.keys(resources)) {
    recordBootSpan({ id: `res:${key}`, phase: "resources", label: key,
      startMs: reqStart, durationMs: reqMs, workMs: timings[key]?.workMs,
      detail: timings[key]?.source });
  }
  ```

### 3. Server work-time split — enhance the boot-snapshot endpoint

`plugins/infra/plugins/boot-snapshot/core/endpoints.ts` — add per-key timing to the
response:

```ts
response: z.object({
  resources: z.record(z.string(), z.unknown()),
  timings: z.record(z.string(), z.object({
    source: z.enum(["persisted", "loader"]),
    workMs: z.number(),
  })),
}),
```

`plugins/infra/plugins/boot-snapshot/server/internal/handle-boot-snapshot.ts` — time
the persisted read and each fallback loader:

```ts
const t0 = performance.now();
const persisted = await readPersistedSnapshots(keys);
const persistedReadMs = performance.now() - t0;
const persistedCount = [...persisted.keys()].filter(k => keys.includes(k)).length || 1;

const missing = keys.filter(k => !persisted.has(k));
const loaded = await Promise.allSettled(missing.map(async k => {
  const s = performance.now();
  const v = await loadResourceByKey(k);
  return [k, v, performance.now() - s] as const;
}));

const timings: Record<string, { source: "persisted" | "loader"; workMs: number }> = {};
for (const k of keys) if (persisted.has(k))
  timings[k] = { source: "persisted", workMs: persistedReadMs / persistedCount }; // shared read amortized
for (const r of loaded) if (r.status === "fulfilled")
  timings[r.value[0]] = { source: "loader", workMs: Math.round(r.value[2]) };
```

This gives each boot-critical resource (the conversation-sidebar's four
`conversations-*` resources, `tasks`, `attempts`, …) a real **work** number; the
client computes **wait = durationMs − workMs** (network + batching + amortized DB
read). For the normal L2 fast path all keys are `persisted`, so `workMs` is the
amortized one-query read share — small, which is the correct story ("almost all the
time was network/wait, the server barely worked").

### 4. The new Debug page — `debug/boot-profile` (new plugin)

`plugins/debug/plugins/boot-profile/web/` — mirrors the profiling plugin's
registration (verified template: `plugins/debug/plugins/profiling/web/index.ts`):

```ts
contributions: [
  Pane.Register({ pane: bootProfilePane }),       // Pane.define id "debug-boot-profile", segment "boot-profile"
  DebugApp.Sidebar({ id: "boot-profile", ...sidebarNavItem({
    title: "Boot Profile", icon: MdTimeline,
    onClick: () => openPane(bootProfilePane, {}, { mode: "root" }) }) }),
]
```

The pane body:
- Reads `getBootTrace()` once (re-read on a local `refreshKey`).
- Provides `ProfilingContext` itself (copy the `{hovered, setHovered, refreshKey}`
  state pattern from `gantt-view.tsx`), so it can reuse `GanttContainer`, `TimeAxis`,
  `SpanRow`, `SpanDetail`, `formatDuration`, `useGanttContainerContext` from
  `@plugins/debug/plugins/profiling/web`.
- Header buttons: **Refresh** (re-read store) and **Reload & re-measure**
  (`window.location.reload()`).
- Renders `<GanttContainer title="Browser Boot" totalMs={…}>` with one `PhaseGroup`
  per `BootPhase` in order: `navigation → scripts → boot-tasks → resources → paint`,
  using a local `PHASE_CONFIG` (categorical colors, same shape as the boot
  section's).
- **Wait/work rendering:** macro phases use the stock `SpanRow`. The `resources`
  phase uses a small new `WaitWorkRow` (local to this plugin) that consumes
  `useGanttContainerContext()` and paints **two segments in one row** on the shared
  timeline — a muted `wait` segment `[startMs … startMs+durationMs−workMs]` then a
  solid `work` segment of width `workMs` — with a legend. This is the one new visual;
  the timeline/zoom/hover/scale all come from the reused `GanttContainer` context.

A top summary strip (reusing `DataTable`, like the boot section's `MemorySummary`)
shows headline numbers: **TTFB**, **response end**, **plugin load**, **boot tasks**,
**first React commit**, **first-contentful-paint** — i.e. the "request → first
paint" decomposition in one glance.

## Phase 2 (optional, follow-up) — route-scoped resource capture

To also capture resources that load over the WS *after* boot (route-scoped panes):
convert the single-slot reporter
`plugins/primitives/plugins/live-state/web/slow-resource-reporter.ts` from
`let reporter` to a **`Set<Reporter>`** (`addSlowResourceReporter` /
`removeSlowResourceReporter`) — a clean "a signal should allow multiple observers"
fix. Update `slow-ops`' `SlowOpCollector` to add/remove instead of register/null.
`boot-trace` then subscribes on import and records a `resources`-phase **wait-only**
span (`{ key, durationMs }`, no `workMs`) for each settle within the boot window,
skipping keys already recorded from the snapshot. Deferred so v1 stays focused on
the explicit ask (boot-critical wait/work).

## Files

**New — `plugins/primitives/plugins/perfs/`** (umbrella) — `CLAUDE.md`,
`package.json` (`@singularity/plugin-perfs`).

**New — `plugins/primitives/plugins/perfs/plugins/boot-trace/`** (web-only leaf)
- `web/index.ts` (barrel), `web/internal/store.ts` (span store + nav/paint/commit
  capture), `package.json`, `CLAUDE.md`.

**New — `plugins/debug/plugins/boot-profile/`** (web-only pane)
- `web/index.ts` (barrel: Pane.Register + DebugApp.Sidebar), `web/panes.tsx`
  (`bootProfilePane` + body), `web/components/boot-profile-gantt.tsx` (provider +
  GanttContainer + phase groups), `web/components/wait-work-row.tsx`,
  `web/components/boot-summary.tsx`, `CLAUDE.md`.

**Modified**
- `plugins/framework/plugins/web-core/web/main.tsx` — 2 marks.
- `plugins/framework/plugins/web-core/web/App.tsx` — wrap loadPlugins/runBootTasks +
  first-render mark.
- `plugins/infra/plugins/boot-snapshot/core/endpoints.ts` — add `timings` to response.
- `plugins/infra/plugins/boot-snapshot/server/internal/handle-boot-snapshot.ts` —
  time persisted read + each loader.
- `plugins/infra/plugins/boot-snapshot/web/internal/boot.ts` — record snapshot +
  per-resource spans.

## Reused (do not reimplement)

- Gantt primitives from `@plugins/debug/plugins/profiling/web`: `GanttContainer`,
  `TimeAxis`, `SpanRow`, `SpanDetail`, `formatDuration`, `useGanttContainerContext`,
  `ProfilingContext` / `useProfilingContext` (`web/components/gantt-container.tsx`,
  `shared.tsx`).
- Pane/sidebar registration: `Pane.define` / `Pane.Register` / `openPane`
  (`@plugins/primitives/plugins/pane/web`), `DebugApp.Sidebar`
  (`@plugins/apps/plugins/debug/plugins/shell/web`), `sidebarNavItem`
  (`@plugins/primitives/plugins/app-shell/web`).
- `DataTable` (`@plugins/primitives/plugins/data-table/web`) for the summary strip.
- The commit bridge `window.__REACT_DEVTOOLS_GLOBAL_HOOK__.__commitSubscribers`
  already installed by `web-core/web/index.html`.

## Verification

1. `./equin build` from the worktree; open `http://<worktree>.localhost:9000`.
2. Navigate to **Debug → Boot Profile**. Confirm the Gantt shows the
   navigation → scripts → boot-tasks → resources → paint phases, and the summary
   strip shows TTFB / plugin-load / boot-tasks / first-commit / FCP.
3. Confirm the `resources` phase lists boot-critical resources (incl. the four
   `conversations-*`, `tasks`, `attempts`) each with a wait + work segment, and that
   `wait + work = total`.
4. Click **Reload & re-measure** → a fresh trace renders (numbers change on cold vs
   warm cache).
5. Sanity-check the server timing: hit `GET /api/resources/boot-snapshot` (via the
   browser/`query`-style fetch) and confirm the `timings` map has a `workMs` per key.
6. `./equin check` (boundaries, plugins-registry-in-sync, plugins-doc-in-sync,
   type-check) is clean.

## Risks / notes

- **Single clock** removes the hardest class of bug (epoch mismatch): everything is
  `performance.now()` / Timing API on `timeOrigin`.
- **Amortized persisted read:** on the L2 fast path the per-resource `workMs` is the
  shared one-query read divided across persisted keys — directional, not isolated
  per-resource (documented in the UI, mirroring the server boot Gantt's
  "directional under Promise.all" caveat).
- **Boundary legality:** `web-core` already imports `primitives/*` web barrels
  (error-boundary, live-state), so importing
  `primitives/plugins/perfs/plugins/boot-trace/web` is legal (nested-depth barrels
  are allowed by the import grammar); `boot-trace` is a leaf (no cross-plugin
  imports) to keep the boot path dependency-light.
