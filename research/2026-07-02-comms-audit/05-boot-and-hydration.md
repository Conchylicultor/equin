# 05 — Client Boot & Hydration

> Part of the [communications audit](./00-overview.md). How the browser goes
> from a cold URL to a painted, live app — and the machinery that makes first
> paint show *real data* with zero visible loading states.

## 1. The boot timeline (what actually happens, in order)

```
index.html
 ├─ inline script 1: pre-paint theme replay (localStorage critical-CSS → <style> + .dark)
 │    → correct theme at frame 0, before any framework JS
 ├─ inline script 2: React DevTools commit bridge (__commitSubscribers)
 │    → lets boot-trace/render-profiler observe commits without the extension
 └─ <script src="main.tsx">
main.tsx        markBootInstant(...) → createRoot(<App/>)
App.tsx  (plugins/framework/plugins/web-core/web/App.tsx — the boot sequencer)
 ├─ [transport hoist] ensureNotificationsClient()  ← BEFORE any plugin loads,
 │    so the leader-election lock + WS connect start at t≈0 and the socket
 │    opens during the plugin-loading await gaps
 ├─ partitionWebEntries(webEntries) → { eager, deferred }
 ├─ await loadPlugins(eager)          — dynamic import(), per-plugin error isolation
 ├─ await runBootTasks(eager)         — all Core.Boot contributions, allSettled:
 │      • bootSnapshotTask   (boot-critical resources → cache)     [§3]
 │      • configBootTask     (config snapshot → cache)             [§5]
 │      • tweakcn/theme task
 ├─ setState({plugins}) → FIRST REACT COMMIT / FIRST PAINT
 │    (every boot-critical useResource finds hydrated cache → no pending flash)
 └─ deferred tier, strictly after paint:
      priority batch = deferred plugins under the deep-linked app's URL prefix
      remaining in batches of 24 with yieldToMain() between batches
      each batch: loadPlugins → runBootTasks → appendPlugins
      → markDeferredLoadComplete()
```

`yieldToMain()` (`perfs/scheduler`) = `scheduler.yield()` → `postTask` →
`setTimeout(0)` — breathing room for input, paint, and the queued socket
grant between plugin batches.

## 2. Eager vs deferred plugin tiers (`web-sdk/core/load-tiers.ts`)

The cold-deep-link problem: loading all ~400 plugin modules before paint
saturates the main thread. The split:

- **Deferred**: app content plugins under `apps/plugins/<app>/plugins/*` for
  apps in `DEFERRABLE_APPS` (browser, debug, mail, pages, sonata, …).
- **Always eager**: each app's `shell` sub-plugin (rail icon + routes must
  exist for navigation), everything outside `apps/`, and `EAGER_EXCEPTIONS`.

The exceptions encode a real constraint: **anything that must run before
first paint has to sit in the eager import graph** —

- boot-critical resource *descriptors* self-register at module-evaluation
  time; if the descriptor only loads with a deferred app, boot-snapshot can't
  hydrate it. Fix pattern (commit `146da4a80`): give the resource its own
  eager web barrel (`release`) instead of keeping the whole app eager.
- a `ConfigV2.WebRegister` read by an eager surface must be eager. Fix
  pattern (commit `a24fc1d6f`): pin the single config leaf
  (`sonata/voicing`) eager and defer the other 48 sonata plugins.

A header comment documents the intended endgame: codegen the eager set from
"carries a boot-critical descriptor / config registration / Core.Root /
Core.Boot" instead of hand-maintained lists.

While the deferred tier loads, the pane router shows a loading placeholder
(not "not found") for routes whose plugin hasn't arrived, via the
`deferred-load-store` (`useSyncExternalStore`).

## 3. Boot-snapshot: real data at first paint (`infra/boot-snapshot`)

The single-request hydration of every boot-critical resource:

- **Opt-in is one-sided**: the resource's own plugin declares
  `Resource.Declare(myResource, { bootCritical: true })` server-side. No
  client list to keep in sync (that dual registry was a real drift bug class).
- **Server**: `GET /api/resources/boot-snapshot` reads all persisted L2
  snapshots in **one batched SELECT** ([02-database-layer](./02-database-layer.md) §6);
  only keys with no persisted row fall back to running their loader
  (allSettled; a failure omits the key — that resource just hydrates later
  via its normal sub-ack).
- **Client** (`Core.Boot` task): one `fetchEndpoint`, then per key resolve
  `resourceDescriptorByKey(key)` and `hydrateResource(descriptor, undefined,
  value)` — a schema-parsed `setQueryData` with a real `dataUpdatedAt`, so
  the first `useResource` render is `pending: false`. A key with no
  registered descriptor is a loud bug: console.error + a direct keepalive
  crash report (the normal crash listeners aren't mounted yet this early).
- **Scope**: param-less global resources only — the server can't know route
  params at snapshot time; parametrized resources self-heal via sub-ack.

Interplay with the WS: hydration and socket connection race harmlessly — the
sub-ack that eventually arrives carries a version, and the shared version
guard keeps whichever is newer.

## 4. The web plugin runtime in one paragraph (`web-sdk`)

Plugins are `{description, contributions}` objects discovered by codegen
(`web.generated.ts`: one dynamic-import loader per `web/index.ts`, with
`dependsOn` inferred from imports; drift-checked). `loadPlugins` imports with
`allSettled` (one broken plugin = one error card, not a blank app);
`PluginProvider` runs the sync register phase topo-sorted, then buckets
contributions by slot id. Rendering goes through sealed-component slot
primitives (`defineRenderSlot`/`defineDispatchSlot`) that auto-wrap every
contribution in an error boundary — a crashing pane never takes down the
shell. `Core.Root` = mount points; `Core.Boot` = pre-paint async tasks. The
communication relevance: **`Core.Boot` is the only sanctioned pre-paint
network window**, and everything in it is one round-trip (snapshot + config),
by design.

## 5. Config delivery (`config_v2`)

Typed JSONC config with a three-layer model (code defaults → git origin
files → user overrides in `~/.singularity/config/`), each hash-stamped for
conflict detection.

- **Server**: `getConfig(descriptor)` / `watchConfig` — a debounced
  `@parcel/watcher` on the config dir invalidates in-memory caches; derived
  caches (scopes, conflicts, modified-counts) recompute only on change
  notifications, never per read.
- **Web**: `useConfig(descriptor)` — reactive, backed by the
  `configV2Resource` live resource; the `configBootTask` hydrates global
  values, per-app scoped overrides, and the scope-membership map before first
  paint (so a scoped app paints its scoped value on frame 1, no
  global→scoped flash), plus `setKnownServerPaths` so a web-only
  half-registration throws loudly instead of silently defaulting.
- Config edits propagate live: file change → watcher → resource notify →
  every tab. "Promote my runtime tweak to a committed default" is a staged
  flow (staging plugin → Review pane → a job that writes the `.jsonc` and
  pushes from a throwaway worktree).

## 6. Boot observability (`perfs/boot-trace`, `debug/boot-profile`)

A module-level span store imported before anything else:
`startBootSpan`/`markBootInstant`/`recordBootSpan`, folding in Navigation
Timing, Paint Timing, Long Tasks (buffered observers cover the pre-module
blind spot), Resource Timing, and the first React commit (via the index.html
bridge). Phases: navigation / scripts / main-thread / boot-tasks / resources
/ assets / paint. The boot-snapshot task records one `res:<key>` span per
hydrated resource with the server-reported `workMs` — so the Gantt shows
exactly which resource made boot slow. Traces can be POSTed
(`/api/boot-traces`) for shareable permalinks; a `benchmark_boot` MCP tool
runs the server-side boot burst in-process for regression numbers. Every
instrumentation site is try/catch-wrapped — profiling must never brick boot.

## 7. Staying fresh after boot: the reload loop

`./equin build` swaps `dist` (new `.build-id`) then restarts the
backend. Detection is push-based end to end:

1. Backend restarts → `frontendHashResource` (push mode) recomputes; its
   loader re-reads `.build-id` **fresh on every call** (memoizing it caused a
   permanently-wedged reload button, because the dist swap precedes the
   restart — commit `2aefc8770`).
2. The frame arrives over `/ws/notifications`; `useStaleFrontend()` compares
   against the baked `VITE_BUILD_ID` (inert under the dev server's `"dev"`).
3. Toolbar shows "Server updated — reload". No polling anywhere in the loop.
