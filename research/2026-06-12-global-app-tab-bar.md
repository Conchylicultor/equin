# App Tab Bar — multiple open apps with per-tab route isolation

## Context

Today the app surface mounts **exactly one app at a time**, and "which app" is derived purely from `window.location.pathname` (`useActiveApp`). Switching apps fully unmounts the previous one, losing all in-app state. We want a browser-like **horizontal tab bar** at the top: a `+` opens a new tab (the homepage), each tab holds an open app, and switching tabs preserves that tab's state.

The load-bearing obstacle is that the pane router keeps its route state in **module-level globals** (`currentRoute`, `routeListeners`, `currentBasePath`, `prevResolvedByUuid` in `plugins/primitives/plugins/pane/web/pane.ts`). With multiple apps mounted at once they would all read/write the same single route — background tabs would collapse to their index pane and lose their pane subtrees (defeating keep-alive). So the feature **requires** promoting that route state into per-tab instances. Importantly, `currentRoute` is the *authoritative* route (the URL is derived from it and serialized into `history.state`), so each tab's store can own its route in memory and only the focused tab mirrors to the URL.

Decisions locked with the user:
- **Tabs + rail coexist** — keep the left rail; a rail click opens/focuses that app's tab. Tab bar sits above the app content, to the right of the rail.
- **Multi-instance** — the same app can live in several tabs (tabs keyed by a per-tab id, each with its own pane-store).
- **Persist across reload** — open tabs + routes saved to `sessionStorage`, namespaced per browser tab via `getTabId()`.
- This is a big feature: ship the structural refactor + a minimal working tabbed surface; **file the polish as follow-up tasks**.

## Architecture (verified seams)

- `pane.ts` per-tab mutable state to isolate: `currentRoute: PaneSlot[]` (342), `routeListeners: Set` (343), `currentBasePath: string` (513), `prevResolvedByUuid: Map` (439).
- `pane.ts` genuinely-shared (pane *definitions* — stay module-global): `registry` (142), `paneObjectByInternal` (148), `indexInstanceIds` (976), `nextInstanceId` (43).
- Window `popstate` / `shell:navigate` listeners are registered at **module load** (pane.ts 560–563) and mutate `currentRoute` for every mounted tree — must become owned by the focused store.
- `usePaneRoute(basePath)` (1023) = `setBasePath` + `useSyncPaneRegistry` + `useRoute` (useSyncExternalStore on `routeListeners`) + `useIndexMatch`. Consumed by miller / full-pane / host / overlay via `PaneBasePathContext`.
- `AppsLayout` (`plugins/apps/web/components/apps-layout.tsx`) mounts only the active app: `body` JSX at lines 78–86, single `<PaneBasePathContext.Provider>`; `setBasePath` at 72. `Apps.RailFraming` wraps `body` (88–105).
- `renderIsolated` (`plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx:325`) is a pure `createElement` — **supports N independent instances of the same contribution**; mount/keep-alive is governed by tree position + `key`.
- Keep-alive technique in repo: pure `display:none` on a still-mounted subtree (`plugins/layouts/plugins/miller/web/components/column.tsx:77`, gated by `keepMountedWhenCollapsed`). No React `Activity`.
- Primitives to reuse: `getTabId()` (`plugins/primitives/plugins/tab-id/web`), `SortableList` horizontal (`plugins/primitives/plugins/sortable-list/web`), `defineRenderSlot` for any new chrome slot, `useActiveApp`/`usePathname` (`plugins/apps/web/internal/use-active-app.ts`) stay URL-driven and need no change.

## Plan

### Phase 1 — Instantiable pane store (behavior-preserving refactor)

Goal: promote route state into an instance without changing any current behavior. Reviewable on its own.

1. **`createPaneStore()`** in pane.ts — a closure owning `{ currentRoute, routeListeners, currentBasePath, prevResolvedByUuid }` plus all route methods that currently touch those globals: `getRoute`, `getRouteSnapshot`, `subscribeRoute`, `setRoute`, `syncRouteFromUrl`, `handleLocationChange`, `reorderRoute`, `restoreRoute`, `clearRoute`, `openPaneImpl`, `close`, `promote`, `unwrap`, `setBasePath`, `getBasePath`. A `live: boolean` field gates whether `setRoute` mirrors to `window.history` + dispatches `shell:navigate` (live) or stays in-memory (background).
2. **Shared definitions stay module-global**: `registry`, `paneObjectByInternal`, `indexInstanceIds`, `nextInstanceId` remain as-is (one set of pane defs for all tabs).
3. **`PaneSurfaceProvider`** (new) provides both the active `PaneStore` (new `PaneStoreContext`) and `basePath` (existing `PaneBasePathContext`). `usePaneStore()` reads context, **falling back to a module-level `defaultStore`** when no provider is present.
4. **Rewrite route hooks to use the context store**: `useRoute`, `usePaneRoute`, `useOpenPane`, and the `Pane` object's `useClose`/`usePromote`. Layout renderers (miller/full-pane/host/overlay) need **no change** — they already call these hooks / read `PaneBasePathContext`.
5. **Imperative free `openPane(...)`** delegates to a module-level `liveStore` pointer (the focused store). Keeps the ~40 imperative call sites untouched. `useOpenPane()` uses the context store.
6. **`defaultStore` self-wires** the `popstate`/`shell:navigate` window listeners at creation (exactly mirroring today), and is the initial `liveStore`. This makes Phase 1 ship independently: with one store everything behaves identically.

Files: `plugins/primitives/plugins/pane/web/pane.ts` (core), `plugins/primitives/plugins/pane/web/index.ts` (export `PaneStore`, `createPaneStore`, `PaneSurfaceProvider`, `usePaneStore`).

**Verify Phase 1 alone**: build + run the app, confirm navigation, deep-links, back/forward, Miller columns, conversation pane-restore all behave exactly as before. Run web-core vitest (`plugin-render.test.tsx`) and any pane/layout `bun test`.

### Phase 2 — Tabs surface (the feature, minimal cut)

1. **`TabsProvider`** (`plugins/apps/web/internal/tabs-store.ts` + `use-tabs.ts`): holds `tabs: { tabId, appId, store: PaneStore }[]` + `focusedTabId`. Actions: `openTab(appId)` (always new — multi-instance), `openOrFocus(appId)` (rail click), `focusTab(tabId)`, `closeTab(tabId)`. On focus switch: mark old store `live=false`, new store `live=true`, set module `liveStore`, and `replaceState` the new store's route into the URL so it reflects the focused tab.
2. **Multi-mount with keep-alive** in `AppsLayout`: replace the single-app `body` with `tabs.map(tab => <div key={tab.tabId} style={{display: tab.tabId===focused ? "contents" : "none"}}><PaneSurfaceProvider store={tab.store} basePath={appPath(tab.appId)}>{renderIsolated(Apps.App.id, appContribution(tab.appId))}</PaneSurfaceProvider></div>)`. The tab bar renders above this column; the whole column is the `body` handed to `Apps.RailFraming` (so rail stays left).
3. **`AppTabBar`** (`plugins/apps/web/components/app-tab-bar.tsx`): horizontal row of tab chips (app icon + label, active highlight) + a `+` button that calls `openTab("home")`. Parallel to `AppRail`; reuses `Apps.App` contributions for icon/label.
4. **Rail click → tabs**: change `AppRail` (`app-rail.tsx`) so a click calls `openOrFocus(app.id)` instead of `navigateToPath`. Highlight still via `useActiveApp()?.id` (URL = focused tab).
5. **Persistence**: `sessionStorage` key `app-tabs:${getTabId()}` storing `[{tabId, appId, route: serializedSlots}]` + `focusedTabId`. On boot: if present, rebuild stores and `restoreRoute` each; else seed one tab from the current URL. Small internal session helper (persistent-draft is localStorage-only, so not reused here).
6. **Initial load / deep-link**: URL → one seeded tab whose store adopts the URL route; that store is `live`.

Files: `plugins/apps/web/components/apps-layout.tsx`, `plugins/apps/web/components/app-rail.tsx`, new `plugins/apps/web/components/app-tab-bar.tsx`, new `plugins/apps/web/internal/tabs-store.ts` + `use-tabs.ts` + session-persistence helper.

## Follow-up tasks (file after approval — out of first cut)

- **pane-restore-store** (`plugins/conversations/plugins/pane-restore/web/internal/pane-restore-store.ts`): its module-load `popstate` listener calls the global `getRoute()` — retarget to `liveStore` and verify conversation restore works per focused tab.
- **Drag-to-reorder tabs** via `SortableList` (`orientation="horizontal"`).
- **Keyboard shortcuts** (Cmd+T new, Cmd+W close, Cmd+1..9 switch) via the `shortcuts` primitive.
- **Tab close affordances**: per-tab close button, middle-click close, "close others".
- **Tab overflow** when many tabs (scroll / `responsive-overflow`).
- **Dynamic per-tab titles** derived from the app + active pane (breadcrumb), not just the app name.
- **Isolation tests**: `prevResolvedByUuid` per-store correctness; cross-tab `instanceId` non-collision.
- **Rail "open in new tab"** affordance (middle-click / context menu) distinct from open-or-focus.
- **Optional later**: a rail-less "tabs-only" framing variant via the existing `app-rail-framing` variant region.

## Verification

- `./equin build`, then load `http://<worktree>.localhost:9000`.
- Scripted Playwright (`e2e/screenshot.mjs`): open app → click `+` → confirm a Home tab appears and focuses → navigate into an app in tab A (open a pane), switch to tab B, switch back → **tab A's pane + scroll state preserved** (the keep-alive + per-tab route proof). Capture before/after.
- Reload the page → confirm the same tabs + routes restore (sessionStorage).
- Back/forward within the focused tab still drives only that tab's route; URL reflects the focused tab.
- Run web-core vitest `plugin-render.test.tsx` and existing pane/layout `bun test` files (pane.ts is load-bearing).
```
