# Synthetic no-op live-state push emitter (deterministic churn repro)

**Date:** 2026-06-22
**Category:** debug (with a supporting framework/resource-runtime primitive)

## Context

Push-driven UI bugs — idle re-render storms, remount churn, DOM thrash — only
manifest while a worktree is actively emitting live-state pushes. That cadence is
ambient and outside a debugging agent's control: during a recent investigation the
*same* probe returned **0 vs ~2448 mutations** across runs purely depending on
whether pushes happened to be flowing, taking ~13 runs to catch a window. There is
no way to drive a controlled, steady cadence of no-op pushes on demand.

The existing `plugins/debug/plugins/live-state-churn` plugin is the **detect** half:
an in-process accumulator fed by every keyed push, plus a scheduled job that files
`live-state-noop` reports when a resource sustains a high no-op rate. The **emit**
half — a way to *generate* that churn deterministically — is missing.

**Goal:** a debug affordance that emits N synthetic no-op live-state pushes/sec for
a chosen resource, drivable from a Debug pane, an HTTP endpoint, and a `window`
API (for headless e2e), so re-render/DOM-churn bugs reproduce deterministically
under the render-profiler + a MutationObserver. A safety auto-stop prevents a
forgotten session from churning forever.

## Design overview

A synthetic no-op push must go through the **exact same code path** as a real
change-feed-driven no-op so the repro never diverges from the bug. That path is
`scheduleNotify(entry, params, affected=null)` → `flushNotifies` → `drainEntry`:
the loader re-runs against an **unchanged** DB, the keyed diff comes back empty
(zero upserts/deletes, `order === undefined`), and a `delta` frame with the bumped
version is still sent to every subscriber — `onPush(key, { changed: false })`
fires. That is byte-for-byte the real no-op churn case, and it feeds the existing
churn accumulator automatically (the monitor counts it with no extra wiring).

So the feature is two pieces:

1. **A generic runtime primitive** `triggerResourcePush(key, params?)` — "re-emit a
   registered resource to its current subscribers without a DB change." Sibling to
   the existing `loadResourceByKey`. Lives in the resource runtime (the owner of
   pushes), exposed through the server-core facade.
2. **A debug `emit` plugin** that drives `triggerResourcePush` on a bounded
   `setInterval` at a chosen rate, with a pane + endpoints + `window` API. Added as
   a child under a new **`live-state-churn` umbrella** alongside the existing
   monitor (per the user's choice).

"Worktree selection" is implicit: each worktree has its own backend, so you drive
churn on the worktree you're debugging by hitting *its* subdomain's endpoint/pane.
No cross-worktree emission is needed.

---

## Part A — runtime primitive: `triggerResourcePush`

### A1. `plugins/framework/plugins/resource-runtime/core/runtime.ts`

- **Extend the `scheduleNotify` source union** from `"hand" | "feed"` to
  `"hand" | "feed" | "synthetic"` (line ~1113). Handle `"synthetic"` as: **no**
  `stats.hand`/`stats.feed` increment, **no** `recordFeedIntent`, **no**
  read-set-gap `console.warn`. This keeps the hand-vs-feed self-verification
  counters (read-set debug pane) honest — a debug session must not pollute them or
  spam the gap warning at N/sec.

- **Add `triggerResourcePush` to the `ResourceRuntime` interface** (near
  `loadResourceByKey`, line ~618) and implement it (near `loadResourceByKey`'s impl
  at line ~1807), then add it to the returned object (line ~1924):

  ```ts
  // Re-emit a registered resource to its current subscribers WITHOUT a DB change:
  // schedules a notify so the loader re-runs and the keyed diff comes back empty,
  // producing a real no-op push. Sibling to loadResourceByKey. If `params` is
  // omitted, fans out to every distinct currently-subscribed params tuple for the
  // key. Returns the number of param-tuples scheduled (0 = no subscribers, so the
  // push is unobservable). Throws on an unknown key (fail loudly).
  function triggerResourcePush(key: string, params?: ResourceParams): number {
    const entry = registry.get(key);
    if (!entry) throw new Error(`[resources] triggerResourcePush: unknown key "${key}"`);
    let targets: ResourceParams[];
    if (params) {
      targets = [params];
    } else {
      // Distinct subscribed param tuples across all sockets (dedupe by pk).
      // state.subs.get(key) is a Map<pk, params> (see handleSub, line 1598).
      const byPk = new Map<string, ResourceParams>();
      for (const st of sockets.values()) {
        const inner = st.subs.get(key);
        if (inner) for (const [pk, p] of inner) byPk.set(pk, p);
      }
      targets = [...byPk.values()];
    }
    for (const p of targets) scheduleNotify(entry, p, null, { source: "synthetic" });
    return targets.length;
  }
  ```

  Reuses the existing `registry`, `sockets`, `state.subs` Map<pk, params>, and
  `scheduleNotify` — no new state.

### A2. `plugins/framework/plugins/server-core/core/resources.ts`

- Add `triggerResourcePush` to the destructure of `runtime` (line ~237) and export
  it, mirroring `loadResourceByKey`. Update the CLAUDE.md "Exports" block via the
  doc-in-sync regen (`./equin build`).

> The central runtime (`framework/central-core`) consumes the same
> `createResourceRuntime`; the new method appears there too at no cost and is
> simply unused — no central-side change required.

---

## Part B — umbrella refactor of `live-state-churn`

Convert the existing flat plugin into an umbrella with the current code as a
`monitor` child, so `emit` can be a sibling. **Delegate to Opus agents.** Safe
because: no cross-plugin importers; all domain ids are explicit literals.

### B1. Move (mechanical, preserve every literal)

Move the entire current tree into a `monitor/` child:

```
plugins/debug/plugins/live-state-churn/
├── package.json          # KEEP (umbrella parent → pure container, like plugins/history)
├── CLAUDE.md             # rewrite as umbrella description
└── plugins/
    ├── monitor/          # ← all existing code moves here verbatim
    │   ├── package.json  # name: @singularity/plugin-debug-live-state-churn-monitor
    │   ├── core/         # config.ts, kinds.ts, index.ts
    │   ├── server/       # index.ts, internal/{accumulator,monitor-job,noop-kind}.ts (+ accumulator.test.ts)
    │   └── web/          # index.ts, components/noop-summary.tsx
    └── emit/             # ← new (Part C)
```

- **Do NOT change** the config `name: "live-state-churn"`, the job name
  `"debug.live-state-churn-monitor"`, or the report kind `"live-state-noop"` — these
  are explicit strings, so persisted config and report dedup survive the move.
- Update the parent `package.json` description to the umbrella line; remove nothing
  else from it. The parent has **no** core/web/server barrels (mirror
  `plugins/history` / `plugins/search`).
- Internal relative imports inside the moved files are unaffected (same relative
  layout). There are no cross-plugin importers to update.
- `./equin build` regenerates the plugin registry from the filesystem.

---

## Part C — the `emit` child plugin

`plugins/debug/plugins/live-state-churn/plugins/emit/`

### C1. `core/constants.ts`
```ts
export const LIVE_STATE_EMIT_GLOBAL = "__liveStateEmit";
export const DEFAULT_EMIT_DURATION_MS = 5 * 60_000;  // auto-stop default
export const MAX_EMIT_DURATION_MS = 30 * 60_000;     // hard cap
export const MAX_EMIT_RATE = 100;                    // pushes/sec ceiling
```

### C2. `shared/endpoints.ts` (typed contracts — `@plugins/infra/plugins/endpoints/core`)
```ts
export const EmitStatusSchema = z.object({
  active: z.boolean(),
  key: z.string().nullable(),
  rate: z.number(),
  startedAtMs: z.number().nullable(),
  endsAtMs: z.number().nullable(),
  ticks: z.number(),                 // scheduled triggerResourcePush calls so far
  lastSubscriberCount: z.number(),   // param-tuples reached on the last tick (0 = nobody listening)
});

export const startEmit = defineEndpoint({
  route: "POST /api/debug/live-state-emit/start",
  body: z.object({
    key: z.string(),
    rate: z.number().min(0.1).max(MAX_EMIT_RATE),
    durationMs: z.number().positive().optional(),
  }),
  response: EmitStatusSchema,
});
export const stopEmit = defineEndpoint({ route: "POST /api/debug/live-state-emit/stop", response: EmitStatusSchema });
export const getEmitStatus = defineEndpoint({ route: "GET /api/debug/live-state-emit/status", response: EmitStatusSchema, dedupe: true });

// Own minimal typed view of the kernel-served /api/resources/_debug, to populate
// the resource dropdown — exactly the pattern read-set/shared/endpoints.ts uses
// (a second typed view of the same kernel route; NOT a cross-plugin import).
export const listResourcesForEmit = defineEndpoint({
  route: "GET /api/resources/_debug",
  response: z.array(z.object({ key: z.string(), mode: z.string(), subscribers: z.number() })).or(/* loose passthrough */ z.any()),
});
```
> Use a tolerant response schema for `_debug` (it's a rich kernel payload); only
> `key`, `mode`, `subscribers` are consumed.

### C3. `server/internal/emitter.ts` — the controller (singleton, in-memory)
```ts
import { triggerResourcePush } from "@plugins/framework/plugins/server-core/core";
```
- Module-level state `{ active, key, rate, timer, autoStopTimer, startedAtMs, endsAtMs, ticks, lastSubscriberCount }`.
- `startEmitting(key, rate, durationMs)`: `stopEmitting()` first (single active
  session); compute `intervalMs = Math.max(1000 / rate, 10)`; arm
  `setInterval(() => { state.lastSubscriberCount = triggerResourcePush(key); state.ticks++; }, intervalMs)`;
  arm `setTimeout(stopEmitting, clamp(durationMs ?? DEFAULT, MAX))`; stamp times.
- `stopEmitting()`: clear both timers, `active = false`.
- `getStatus()`: snapshot of state.
- **Rationale comment** (mirror health-monitor's setInterval exception): the
  no-polling rule forbids `setInterval` loops that *poll for change*; this is the
  opposite — a deliberate, on-demand **signal generator** at sub-second cadence
  (N/sec is below graphile cron's 1-minute floor), started/stopped explicitly and
  bounded by a hard auto-stop cap. It generates pushes, it does not watch for them.

### C4. `server/internal/handle-*.ts` + `server/index.ts`
- `implement()` the three endpoints (start → `startEmitting` + return status; stop
  → `stopEmitting` + status; status → `getStatus`). `listResourcesForEmit` is
  already served by the kernel — do **not** re-implement it; just don't register a
  handler for that route (the kernel's `handleResourceHttp` owns `_debug`).
- `server/index.ts`: `httpRoutes` for start/stop/status; `onShutdown: stopEmitting`
  (cleanup on restart).

### C5. `web/`
- `web/panes.tsx`: `liveStateEmitPane = Pane.define(...)` rendering `EmitPane`.
- `web/components/emit-pane.tsx`:
  - `useEndpoint(listResourcesForEmit, {})` → dropdown of resources with
    `mode === "keyed" && subscribers > 0` (the only ones where a no-op push is
    observable); allow free-text key entry as a fallback.
  - Rate input (pushes/sec) + duration input (default `DEFAULT_EMIT_DURATION_MS`).
  - Start/Stop via `useEndpointMutation(startEmit/stopEmit, { invalidates: [getEmitStatus] })`.
  - Live status via `useEndpoint(getEmitStatus)`: active key, rate, ticks,
    `lastSubscriberCount` (warn when 0 — "nobody subscribed, no churn observable"),
    time remaining. Compose with css primitives (`Stack`, `Inset`, `Text`,
    `Button`, `Badge`) — read the `css`/`theme` skills before building UI.
- `web/internal/global-api.ts` + `EmitInstaller` (idempotent install, mounted via
  `Core.Root`), mirroring render-profiler's `installGlobalApi`/`ProfilerInstaller`:
  ```ts
  window[LIVE_STATE_EMIT_GLOBAL] = {
    start: ({ key, rate, durationMs }) => fetchEndpoint(startEmit, { body: { key, rate, durationMs } }),
    stop: () => fetchEndpoint(stopEmit, {}),
    status: () => fetchEndpoint(getEmitStatus, {}),
  };
  ```
- `web/index.ts`: `Pane.Register({ pane: liveStateEmitPane })` +
  `DebugApp.Sidebar({ id: "live-state-emit", ...sidebarNavItem({ title: "Live-State Emit", icon, onClick: () => openPane(liveStateEmitPane, {}, { mode: "root" }) }) })` +
  `Core.Root({ component: EmitInstaller })`.

---

## Part D — e2e harness (the payoff)

`e2e/live-state-churn.mjs` (mirror `e2e/render-profile.mjs`): drive a fully
deterministic repro headlessly.

1. `addInitScript` installs a `MutationObserver` counting added/removed nodes into
   `window.__domMutations` (the `perf.mjs` pattern — runs before page JS).
2. `goto(url)` + settle (~3s) so `Core.Root` installers mount.
3. `page.evaluate(() => window.__liveStateEmit.start({ key, rate, durationMs }))`.
4. `page.evaluate(() => window.__reactRenderProfiler.start({ maxDurationMs }))`.
5. wait `--seconds`.
6. stop both; collect `window.__reactRenderProfiler.getReport()` and
   `window.__domMutations`; `window.__liveStateEmit.stop()`.
7. print report + mutation count.

CLI: `bun e2e/live-state-churn.mjs --url http://<wt>.localhost:9000/<route> --key <resourceKey> --rate 10 --seconds 8`.

---

## Critical files

| Concern | File |
|---|---|
| Source union + `triggerResourcePush` impl | `plugins/framework/plugins/resource-runtime/core/runtime.ts` (~1113, ~1807, ~1924, interface ~618) |
| Facade export | `plugins/framework/plugins/server-core/core/resources.ts` (~237) |
| Umbrella parent | `plugins/debug/plugins/live-state-churn/{package.json,CLAUDE.md}` |
| Moved monitor | `plugins/debug/plugins/live-state-churn/plugins/monitor/**` (was the plugin root) |
| New emit plugin | `plugins/debug/plugins/live-state-churn/plugins/emit/{core,shared,server,web}/**` |
| e2e harness | `e2e/live-state-churn.mjs` (new) |
| Patterns to copy | render-profiler (`web/internal/global-api.ts`, `Core.Root`), heap-snapshot (endpoints), health-monitor (setInterval rationale + `onShutdown`), read-set (`shared/endpoints.ts` second view of `_debug`) |

## Caveats / notes

- **Keyed vs push mode.** A true *no-op* (empty-diff) push is a keyed-resource
  concept; the dropdown targets keyed resources. Push-mode resources always re-send
  the full value (always "changed"), so they're not no-ops — out of scope, though
  `triggerResourcePush` works on them too.
- **debounceMs resources** coalesce rapid synthetic notifies, capping *delivered*
  rate at 1/debounceMs. `ticks`/`lastSubscriberCount` report *scheduled* calls; the
  real delivered cadence shows up in the render-profiler and the existing churn
  monitor. This is faithful, not a bug.
- **Detection stays separate.** The emit plugin only drives pushes; delivered no-op
  counts are surfaced by the existing `monitor` child (its accumulator is fed via
  `onPush` automatically) and the Debug → Reports pane. Clean emit/detect split.

## Verification

1. `./equin build` (regenerates migrations/registry/docs; runs checks incl.
   `plugin-boundaries`, `type-check`, `plugins-doc-in-sync`).
2. Open `http://<wt>.localhost:9000` → Debug → **Live-State Emit**. Pick a keyed
   resource that's on-screen (e.g. the tasks list), set rate 10/s, Start.
3. In another view rendering that resource, open Debug → **Render Profiler**,
   Start → confirm ranked `useSyncExternalStore` initiators appear; Debug →
   **Reports** should accrue a `live-state-noop` report for the key (proving the
   monitor counts the synthetic pushes).
4. Stop → confirm emission halts; let a short-duration session lapse → confirm
   auto-stop fires (status `active: false`).
5. Headless: `bun e2e/live-state-churn.mjs --url http://<wt>.localhost:9000/agents --key <key> --rate 10 --seconds 8` → non-zero, stable `__domMutations` across repeated runs (the determinism this whole feature exists to provide).
6. Sanity: with no subscribers to the chosen key, `lastSubscriberCount` is 0 and the
   pane warns; hand-vs-feed counters in the read-set pane are unchanged by a
   synthetic session (confirms the `"synthetic"` source exclusion).
```
