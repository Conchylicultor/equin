# Tri-state pane route + settled-and-healthy fallback gating

## Context

Refreshing a deep link (e.g. `/pages/page/:id`) could render the app's index
"homepage" at the deep-link URL, or destroy the URL entirely. Root cause: the
pane route (`PaneSlot[]`) uses ONE value — empty/null — for three realities:

- (a) genuinely bare app root,
- (b) URL not resolvable **yet** (target pane's plugin still loading in the
  deferred tier),
- (c) URL **failed** to resolve (invalid link, or its plugin chunk failed to
  load — load failure is tracked nowhere today).

Commit `fc2f3c598` patched one consumer (`usePaneRoute`) with a time-scoped
guard (`store.live && !deferredComplete`); the class survived because the
ambiguous representation survived. Every other consumer still guesses:
`bootTabs` clobbers persisted routes with `clearRoute()`, apps-layout's
default-app redirect rewrites deep links via raw `replaceState`, and after
`deferredComplete` an unresolvable deep link falls back to the index again
(chunk failure ⇒ silent homepage; the error is a render-only banner, invisible
in telemetry).

This plan makes the invalid state unrepresentable (tri-state route) and gates
every destructive fallback on **settled-and-healthy** (loading finished AND no
load errors under the relevant plugin subtree). Design doc for the incident
analysis: this conversation; prior fix: `fc2f3c598`, its test:
`plugins/primitives/plugins/pane/web/__tests__/deep-link-load-gap.test.tsx`.

## Core design

**Store holds a two-state route; the public tri-state is folded at read time.**

```ts
// pane.ts — store-internal state
type RouteState =
  | { kind: "resolved"; slots: PaneSlot[] }   // slots [] ⇒ bare root (explicit)
  | { kind: "unresolved"; rawPath: string };  // URL matched no registered pane
```

Pending vs NotFound is *derived* at read time from `deferredComplete` +
`hasLoadErrorUnder(prefix)` — it flips on load progress, so storing it would
mean rewriting route state on every deferred batch. The existing
`useSyncPaneRegistry → handleLocationChange` per-render re-sync remains the
sole re-resolution driver.

**Compatibility invariant:** `getRoute(): PaneSlot[]` keeps returning
`resolved ? slots : []` (stable `EMPTY` identity), so the ~44 tolerant
`useRouteEntry()/useRouteEntries()` readers need **zero changes**. Only the
emptiness-branching consumers (enumerated below) are updated, and
`parseUrl`'s new return type compile-forces them.

`clearRoute()` stays the sanctioned explicit "go to index" (sonata/story back
buttons unchanged): it writes `resolved([])`.

## Commits (each independently buildable)

### 1. Load-health signal (`deferred-load-store.ts` + `App.tsx`)

`plugins/framework/plugins/web-sdk/core/deferred-load-store.ts`:

- Add `failedPluginPaths: ReadonlySet<string>` to `DeferredLoadState`
  (fs-registry dirs from `PluginLoadError.pluginPath`).
- New exports: `markDeferredPluginsFailed(paths: string[])`,
  `hasLoadErrorUnder(pathPrefix: string): boolean` (prefix match; `""` ⇒
  false, never global), `useHasLoadErrorUnder(prefix)` (useSyncExternalStore).
- Define `pluginLoadReportSink = defineReportSink<PluginLoadReport>()` here
  (imports `@plugins/primitives/plugins/report-sink/core` — pure, no cycle).
  `PluginLoadReport = { pluginPath: string; message: string }`.
- Update the module comment (currently says failures are deliberately
  untracked).
- Export all from `web-sdk/core/index.ts`.

`plugins/framework/plugins/web-core/web/App.tsx` (composition root, exempt):

- After the eager `setState` (~line 168) and inside `appendPlugins` (~line
  124): `recordErrors(errors)` — calls `markDeferredPluginsFailed` + emits one
  `pluginLoadReportSink` event per error.

No routing behavior change.

### 2. Report filing (`reports/plugins/plugin-load-errors`)

- Add `"plugin-load"` to `CLIENT_REPORT_SOURCES` in
  `plugins/reports/shared/types.ts`.
- New sub-plugin `plugins/reports/plugins/plugin-load-errors/web/` mirroring
  `plugins/reports/plugins/endpoint-errors` — a `Core.Root` reporter that
  registers on `pluginLoadReportSink` and calls `report()`
  (`plugins/reports/web/report.ts`) with
  `{ kind: "crash", source: "plugin-load", message, url, data: { errorType:
  "PluginLoadError <pluginPath>", stack: null } }`. Server fingerprint dedupes
  to one report+task per failing plugin path.
- Run `./equin build` to regenerate the plugin registry.

### 3. Tri-state route store (`pane.ts`) — inert refactor

`plugins/primitives/plugins/pane/web/pane.ts`:

- `parseUrl` returns a discriminated result (compile-forces all call sites):

  ```ts
  export type ParsedRoute =
    | { status: "matched"; slots: PaneSlot[] }    // [] ⇒ bare root
    | { status: "unresolved"; rawPath: string };  // segment matched no pane
  ```

  Line ~343 (`if (!bestMatch)`) → `unresolved`; line ~355 → `matched` (may be
  empty).

- Store: `currentRoute: PaneSlot[]` becomes `currentState: RouteState`.
  - `getRoute()/getRouteSnapshot()` — unchanged contract (see invariant).
  - New `getRouteState()` / `getRouteStateSnapshot()` + hook
    `useRouteState()`; reuse `subscribeRoute`.
  - `setRoute(slots, replace)` → `resolved(slots)`; history/URL side-effects
    unchanged. `restoreRoute`, `resolveRoute`, `reorderRoute`, `openPaneImpl`,
    `clearRoute` unchanged in behavior.
  - New writers:
    - `seedPending(rawPath)` — set `unresolved`, notify, NO url/history
      (boot + background tabs).
    - `navigatePending(rawPath)` — live navigation to a not-yet-resolvable
      URL: set `unresolved`, push `history.state = { pending: rawPath }` +
      URL, dispatch `popstate`/`shell:navigate`.
  - `syncRouteFromUrl` — the **no-clobber rule** (the linchpin):
    - `matched` ⇒ adopt slots (equality-guarded, as today).
    - `unresolved` ⇒ adopt ONLY if the current state is not a resolved
      non-empty route **or** loading is settled-and-healthy for the surface.
      While `!deferredComplete`, a resolved non-empty route (restored from
      persistence / prior nav) must never be wiped by a pre-registry parse —
      this is today's cold-boot clobber. After settle+healthy, the unresolved
      parse wins (a genuinely dead link must become NotFound, not a stale
      pane). Note: within a session this path is nearly unreachable
      (address-bar edits are full reloads; back/forward restores from
      `history.state`), so the rule is boot-protection.
  - `handleLocationChange` — new branch: `history.state.pending` (string, no
    `route`) ⇒ `unresolved(rawPath)`; existing `state.route` branch first,
    else `syncRouteFromUrl`.

- New context `PaneLoadScopeContext = createContext<string>("")` (fs prefix,
  e.g. `"apps/plugins/pages/"`); optional `loadScopePrefix?: string` prop on
  `PaneSurfaceProvider`.

- Shim the two `use-tabs.tsx` `parseUrl` call sites to preserve behavior
  (`parsed.status === "matched" ? parsed.slots : []`) — refined in commit 5.

- Barrel exports: `ParsedRoute`, `RouteState`, `useRouteState`,
  `PaneLoadScopeContext`.

### 4. Read-time gating (fallback, `usePaneRoute`, title reporter)

`plugins/primitives/plugins/pane/web/pane.ts` — `usePaneRoute` drops the
`fc2f3c598` guard (`store.live`/pathname/deferredComplete) entirely:

```ts
const route = useRoute();
const state = useRouteState();
if (route) return route;
if (state.kind === "resolved" && state.slots.length === 0) return index; // genuine bare root
return null; // pending / notfound / slots-not-yet-registered ⇒ layout renders fallback
```

Background stores are always `resolved` (routes come from `restoreRoute`), so
the old `store.live` special case is no longer needed.

`plugins/layouts/plugins/route-fallback/web/components/deferred-route-fallback.tsx`
— rework into the tri-state + health surface (keep the exported name so
miller/full-pane/host imports stand):

- `resolved` non-empty (slots not registry-resolvable — the fallback only
  renders when `match` is null):
  - `!deferredComplete` ⇒ spinner (load gap).
  - settled ⇒ **same as unresolved-settled below** (covers stale paneIds in
    `history.state` from an old bundle — must not render blank forever).
- `resolved([])` ⇒ `null` (bare root with no index pane — host renders blank,
  as today).
- `unresolved`:
  - `!deferredComplete` ⇒ spinner (Pending; keep the existing 120ms-delayed
    `Loading`).
  - settled + `useHasLoadErrorUnder(useContext(PaneLoadScopeContext))` ⇒
    `AppLoadErrorSurface` with a Retry (location.reload) affordance.
  - settled + healthy ⇒ `NotFoundSurface`.
- Add the two small presentational surfaces in this plugin.

`plugins/apps-core/plugins/tab-surface/web/components/tab-surface.tsx`:

- `TabSurface`: derive `loadScopePrefix` from the app contribution's
  `_pluginId` (readable; sealing hides only `component`) via
  `asFsPath(asPluginId(id))` + the `/^(apps\/plugins\/[^/]+)\//` regex (same
  convention as `resolveActiveAppPrefix` in App.tsx); pass to
  `PaneSurfaceProvider`.
- `TabTitleReporter`: index title ONLY at genuine bare root
  (`resolved([])`); Pending/NotFound ⇒ `TitleClear` (app name), no more
  homepage-title misreport during the load gap.

`pane-overlay-host.tsx` (miller) — unchanged and now intentionally correct:
`useRoute()` null ⇒ no overlay for Pending AND bare root (no flash).

### 5. Write-time no-clobber (`bootTabs`/`navigate`) + redirect gating + persistence

`plugins/apps-core/plugins/tabs/web/internal/tabs-store.ts`:

- `PersistedTab` gains `rawPath?: string`, **persisted for every tab**:
  resolved tabs ⇒ `buildRouteUrl(route)` at save time (registry has the panes
  then); pending tabs ⇒ the stored `rawPath` with `route: []`. Additive and
  optional ⇒ old sessionStorage payloads load unchanged (`loadPersistedTabs`
  untouched, still fail-loud on true malformation).
- Rationale: on the next cold boot `rawPath` is the discriminator that lets a
  plain reload restore the persisted slots **instantly** (no spinner, no
  registry) while an address-bar jump to a different deep link seeds Pending
  instead of showing a stale route.

`plugins/apps-core/plugins/tabs/web/internal/use-tabs.tsx`:

- `bootTabs` (replaces the destructive lines 254–257):

  ```ts
  const parsed = parseUrl(resolved.routePath);
  const persistedFocused = persisted?.tabs.find((t) => t.tabId === focused.tabId);
  if (parsed.status === "matched" && parsed.slots.length > 0) {
    focused.store.restoreRoute(parsed.slots);        // registry already has these panes
  } else if (parsed.status === "matched") {
    focused.store.clearRoute();                      // genuine bare root ⇒ index
  } else if (persistedFocused?.route.length && persistedFocused.rawPath === resolved.routePath) {
    focused.store.restoreRoute(persistedFocused.route); // reload of the same deep link ⇒ instant restore
  } else {
    focused.store.seedPending(parsed.rawPath);       // unresolved deep link ⇒ Pending
  }
  ```

- `rebuildBackgroundTab`: persisted `rawPath` + empty route ⇒
  `seedPending(rawPath)` (a backgrounded pending tab survives reload).
- `navigate()`: on `unresolved` —
  `deferredComplete && !hasLoadErrorUnder(shellPrefix)` ⇒ **throw** (dead
  link; mirrors the existing loud throw for unmatched apps); otherwise
  `navigatePending` on the live store (same-app) or a new
  `replaceTabAppWithPending(tabId, appId, rawPath)` (cross-app).

`plugins/apps-core/plugins/layout/web/components/apps-layout.tsx` — gate the
default-app redirect (the only raw-history redirect in the repo):

```ts
if (matchedId || !defaultPath) return;
if (pathname === "/") return redirectTo(defaultPath); // bare root: nothing to destroy, keep instant
if (!deferredComplete) return;                        // shells may still be loading ⇒ wait
if (anyAppShellLoadError) return;                     // render AppLoadErrorSurface; NEVER destroy the deep link
redirectTo(defaultPath);                              // settled + healthy + genuinely unmatched
```

`anyAppShellLoadError` = `hasLoadErrorUnder("apps/plugins/")` — deliberately
coarse: when the failed shell never registered, the URL→subtree mapping is
unknowable; redirect is destructive, so bias to not redirecting on any
unclean apps tier. While suppressed, render an app-load-error / loading
surface in the tabs area instead of nothing.

### 6. Tests + e2e

Extend `plugins/primitives/plugins/pane/web/__tests__/deep-link-load-gap.test.tsx`
(vitest, existing harness stubs location/liveStore/index pane):

- pending → resolved: unresolved deep link renders spinner-fallback; register
  the target pane → resolves to the pane.
- pending → notfound: `markDeferredLoadComplete()` + healthy ⇒ NotFound
  surface, **not** the index.
- pending → error: `markDeferredPluginsFailed(["apps/plugins/x/…"])` + scope
  context ⇒ error/Retry surface.
- bare root unchanged: index renders.
- no-clobber (store): resolved non-empty state + unresolved URL parse while
  `!deferredComplete` ⇒ state survives.
- stale-paneId after settle ⇒ NotFound surface, not blank.
- bootTabs: persisted `rawPath === url` + unresolved parse ⇒ persisted slots
  restored (not cleared); different url ⇒ Pending.
- redirect predicate unit test: (unsettled ⇒ no), (settled+shell-error ⇒ no),
  (settled+healthy ⇒ yes), (bare "/" ⇒ always).

E2e smoke (pattern of `e2e/screenshot.mjs`): cold-load
`/pages/page/<id>` ⇒ assert the page pane renders (not the welcome), URL
unchanged. Optionally a chunk-block variant (route-intercept the page-tree
chunk) ⇒ assert error surface + a `plugin-load` report row, not the homepage.

## Risks

- **The no-clobber rule is the linchpin** — without it, the per-render
  `handleLocationChange` re-parse wipes restored routes exactly as today.
  Covered by dedicated tests.
- **Background stores** never parse URLs ⇒ always `resolved`; pending
  background tabs ride `rawPath`.
- **Back/forward**: `history.state.pending` round-trips Pending;
  `state.route` still restores without re-parsing.
- **Bare "/" boot** stays instant (ungated redirect) — no UX regression on
  the common cold start.
- **apps-layout health attribution is coarse** (any app-shell error suppresses
  redirect); safe failure direction, documented in code.
- Out of scope (noted, not touched): `conversations/pane-restore` collapses
  missing/expired/corrupt into one null — same anti-pattern, separate task.

## Files

- `plugins/primitives/plugins/pane/web/pane.ts` (core refactor)
- `plugins/framework/plugins/web-sdk/core/deferred-load-store.ts` (+ index.ts)
- `plugins/framework/plugins/web-core/web/App.tsx`
- `plugins/reports/shared/types.ts`, new `plugins/reports/plugins/plugin-load-errors/web/`
- `plugins/layouts/plugins/route-fallback/web/components/deferred-route-fallback.tsx`
- `plugins/apps-core/plugins/tabs/web/internal/{use-tabs.tsx,tabs-store.ts}`
- `plugins/apps-core/plugins/tab-surface/web/components/tab-surface.tsx`
- `plugins/apps-core/plugins/layout/web/components/apps-layout.tsx`
- Tests: `plugins/primitives/plugins/pane/web/__tests__/deep-link-load-gap.test.tsx`

## Verification

1. `bun run test:dom plugins/primitives/plugins/pane` (extended suite) +
   `bun run test:dom plugins/apps-core` if tab tests land there.
2. `./equin build` (registers the new reports sub-plugin; runs checks).
3. Scripted Playwright against `http://<worktree>.localhost:9000`:
   - reload `/pages/page/<id>` (with and without sessionStorage) ⇒ page
     restores; with persisted `rawPath` the restore is instant (no spinner).
   - chunk-block run ⇒ error surface + Retry, URL intact, report row in
     Debug → Reports (`query_db`: `SELECT * FROM reports WHERE source='plugin-load'`).
   - bare `/` ⇒ still redirects to the default app immediately.
   - sonata/story "← back" buttons ⇒ index, unchanged.
