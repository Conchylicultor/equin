# Per-tab placement: replace the global surface-arrangement theme setting

## Context

Today, switching between "tabs" and "desktop" is a **global theme setting**: the
`surface-arrangement` plugin is a `variant-region` whose picker lives in the
theme customizer (palette icon → "Surface arrangement"), writing one global
`apps-surface-arrangement` config value that flips *all* tabs at once between
`AppTabsBody` (one fullscreen tab) and `AppWindowsBody` (free-floating windows).

Two problems:
1. **Wrong home.** Window arrangement is a workflow decision, not an aesthetic
   one — burying it next to color presets is why it feels unnatural. The user
   wants it removed from theme settings.
2. **Wrong granularity.** A single global enum can't express "this tab is a
   floating window, that one is fullscreen." The user wants each tab to carry
   its own state.

**Goal:** make arrangement a **per-tab property** so the overall "mode" becomes
*emergent* rather than a setting — exactly how Chrome has no "window mode", just
tabs that have been torn into windows. Add a third placement, `solo` (the new
"standalone / full app" fullscreen mode), a Chrome-style tear-off gesture, and a
3-way toggle acting on the focused tab. Delete the theme-customizer entry and the
global config.

## Model

Each tab carries one field:

```ts
placement: "docked" | "floating" | "solo"   // default "docked"
```

- **docked** → lives in the tab strip; rendered full-area when it is the focused tab (today's "tabs").
- **floating** → a free window with geometry (today's "desktop"), drawn on the same backdrop.
- **solo** → fills the whole viewport and hides the tab bar + rail (the new "full app").

There is **no global mode**. One `SurfaceBody` renders every open tab at once and
positions each by its own placement. The surface *looks like* "tabs" when all
tabs are docked, "desktop" once any tab is floating, "full app" when the focused
tab is solo. Visibility rules per tab:

| placement | visible when |
|-----------|--------------|
| docked    | it is the focused tab (else `display:none`, kept mounted) |
| floating  | always (window at its geometry/z) |
| solo      | it is the focused tab (fixed fullscreen overlay; else hidden) |

So when the focused tab is floating, all docked tabs hide → clean desktop with
windows. Focusing a docked chip brings it back as the full-area backdrop with the
windows on top (standard desktop behavior).

### Keep-alive across placement changes (core design constraint)

Tear-off must **not** reload the tab (Chrome preserves state). React only
preserves a child's state if its parent chain + key are stable. Therefore each
tab is rendered as **one stable container** keyed by `tabId`:

```
<div key={tabId} style={placementStyle(tab)}>
  <TabSurface tab={tab} />          {/* parent chain identical in all 3 placements */}
  {floating && <WindowChrome .../>} {/* titlebar + resize handles as SIBLING overlay */}
</div>
```

Only the wrapper's CSS and the presence of the sibling chrome change with
placement — `TabSurface`'s position in the tree never changes, so its React state
(scroll, transient UI) survives tear-off / dock / solo transitions. This requires
splitting today's `WindowFrame` (which wraps `<TabSurface>`) into wrapper-style +
a sibling `WindowChrome` overlay.

## Module boundary (the feature stays a self-contained plugin)

**There is no import cycle, so nothing moves into `apps` core.** `apps` already
renders the surface body *through a slot* — `FramedSurface` calls
`Apps.SurfaceArrangement.useContributions()` + `renderIsolated(...)`; it never
statically imports the contributor. The `surface` plugin imports `apps`
(`useTabs`, `TabSurface`), one direction → clean DAG. We keep that indirection.

Split of ownership:
- **`apps` core owns only the placement *enum*** — one `placement` field on the
  tab model + `setPlacement` in `TabsApi`. Justified: placement is per-tab *state*,
  and the tab model is already the home of per-tab state (focus, order, route). The
  shell reads it (Esc-to-exit, tab-bar control); the plugin reads it to render.
- **The `surface` plugin owns all presentation** — `SurfaceBody`, `WindowChrome`,
  `use-window-geometry`, `PlacementControl` — contributed back through slots. None
  of it lives in core.

The plugin is renamed `surface-arrangement` → `surface` and loses its
variant-region shape + `tabs`/`desktop` children (a single body now renders all
placements). `apps` swaps its variant-region slot for a plain single-contribution
render slot.

## Implementation

### 1. Add placement to the tab model (`plugins/apps/web/internal/`) — core
- `tabs-store.ts`: add `placement: Placement` to `Tab` and `PersistedTab` (default
  `"docked"` on load for back-compat); include it in `savePersistedTabs`. Persists
  in the existing `app-tabs:<browserTab>` sessionStorage blob — no new store.
  `Placement` type exported from `apps/core` so the plugin shares it.
- `use-tabs.tsx`: add `setPlacement(tabId, placement)` to `TabsApi`; default new
  tabs (`openTab`, `closeTab` seed, `replaceTabApp`) to `"docked"`. Add a
  module-level `setFocusedTabPlacement(p)` + `setPlacementSetter` handle mirroring
  the existing `tabsNavigator`/`setTabsNavigator` pattern (so an out-of-provider
  caller — floating bar, global Esc shortcut — can reach it).

### 2. Replace the variant-region slot with a plain surface slot — core
- `plugins/apps/web/slots.ts`: replace `Apps.SurfaceArrangement`
  (variant-region-shaped `defineSlot`) with `Apps.Surface`, a single-contribution
  render slot taking no props (same "host forwards no props" contract as today).
- `FramedSurface` (`apps-layout.tsx`): render the `Apps.Surface` contribution via
  `renderIsolated`, **falling back to `AppTabsBody`** when none is present, so
  `apps` still degrades to a working docked-only strip on its own.
- Add `Apps.TabBarActions` render slot, hosted in `AppTabBar`'s trailing zone (next
  to `+`), for the plugin to drop `PlacementControl` into. Keeps the control
  plugin-owned while apps owns only the seam.

### 3. The `surface` plugin renderer (`plugins/apps/plugins/surface/web/`)
Repurpose the existing plugin tree. `use-window-geometry.ts` moves up from the old
`desktop` child into `surface/web/hooks/` essentially unchanged (already per-`tabId`,
sessionStorage `app-windows:<browserTab>`). Split `window-frame.tsx` into
`window-chrome.tsx` (titlebar + min/max/close + resize handles as a *sibling*
overlay) — the geometry box style moves into `SurfaceBody`'s `placementStyle`.

`SurfaceBody` (`surface/web/components/surface-body.tsx`, contributed into
`Apps.Surface`) renders every tab as the stable container above; `placementStyle`:
- docked → `absolute inset-0`, `display` block iff focused.
- floating → `absolute` at geometry (`left/top/width/height/zIndex`); renders
  sibling `WindowChrome`; `onPointerDownCapture` focuses + `bringToFront`.
- solo → `fixed inset-0 z-max` iff focused (covers tab bar + rail → true
  fullscreen), else `display:none`; renders a hover-reveal **"Exit fullscreen"**
  affordance calling `setPlacement(tabId,"docked")`.

`SurfaceBody` is inside `TabsProvider` (rendered by `FramedSurface`), so it reads
`useTabs()` directly. Keep `pruneWindowGeometry(openTabIds)` on tab-set change. Drop
the desktop-local `+` button (the tab-bar `+` already covers new tabs).

### 4. `PlacementControl` (`surface/web/components/placement-control.tsx`)
A `SegmentedControl` (`primitives/toggle-chip`) of three icons — dock / float /
solo — reading the focused tab's placement, calling `setPlacement(focusedTabId,…)`.
Contributed by the `surface` plugin into **two** slots so it is always reachable:
- `Apps.TabBarActions` → the tab strip (contextual; uses `useTabs` in-provider).
- `ActionBar.Item` (`shell/action-bar`) → the agent-manager toolbar **and the
  floating action bar**, which is portalled and visible in *every* app including
  solo. The floating-bar instance renders outside `TabsProvider`, so it drives the
  module-level `setFocusedTabPlacement` + a small subscribable focused-placement
  snapshot (same handle pattern as `navigate`). This is the persistent home that
  answers "where does the toggle live" and gives solo a visible exit.

### 5. Tear-off gesture (`primitives/sortable-list` + tab bar)
- Add an **opt-in** `onDragOut?(id, point: {x,y})` to `SortableList`
  (`internal/sortable-list.tsx`): in dnd-kit's `onDragEnd`, if the release point
  (from `event.activatorEvent` + `event.delta`) falls outside the container rect's
  cross-axis by a margin, fire `onDragOut` instead of `onMove`. Default undefined →
  zero change for the 6 existing consumers (collapsible-wrap, reorder, miller,
  fields/list, apps).
- `app-tab-bar.tsx`: pass `onDragOut={(id) => setPlacement(id, "floating")}` then
  `focusTab(id)`. The new window seeds at the geometry store's cascade default on
  first floating render (drop-point seeding deferred — see open choices).

### 6. Esc-to-exit-solo
`defineShortcut` (`primitives/shortcuts`): `Escape` → if focused tab is solo,
`setFocusedTabPlacement("docked")`. Contributed by the `surface` plugin (uses the
module-level setter; presentation behavior stays plugin-owned).

### 7. Delete the variant-region wiring
- Remove the old `tabs`/`desktop` child plugins and the variant-region region
  files (`core/region.ts`, `web/region.ts`, `web/index.ts` variant wiring,
  `server/index.ts`) — replaced by the single `surface` renderer above.
- `apps`: the `SurfaceArrangement` slot/`SurfaceArrangementContribution` are gone
  (replaced by `Apps.Surface` in step 2). Drop `SurfaceArrangementProps` from
  `apps/core` (`index.ts`,`types.ts`) and `apps/web/index.ts`.
- Theme-customizer entry disappears automatically (it was the variant-region's
  `ThemeEngine.VariantGroup` contribution — removing that wiring removes it).
- `config/ui/theme-engine/ui.theme-engine.variant-group.jsonc` (+ `.origin`):
  remove the `surface-arrangement` ordering entry (build regenerates `.origin`;
  hand-edit the user-override `.jsonc`).
- `./equin build` regenerates `web.generated.ts` / `server.generated.ts`
  and the reorder/doc manifests; `plugins-registry-in-sync` / `plugins-doc-in-sync`
  / `plugin-boundaries` checks confirm no drift or cycle.

## Critical files
- `plugins/apps/web/internal/tabs-store.ts`, `use-tabs.tsx` — placement field + API + module setter *(core)*
- `plugins/apps/web/slots.ts` — `Apps.Surface` + `Apps.TabBarActions` slots *(core)*
- `plugins/apps/web/components/apps-layout.tsx` — `FramedSurface` renders `Apps.Surface` *(core)*
- `plugins/apps/web/components/app-tab-bar.tsx` — tear-off wiring + `TabBarActions` host *(core)*
- `plugins/apps/core/{index,types}.ts`, `plugins/apps/web/index.ts` — `Placement` export, slot/type cleanup *(core)*
- `plugins/apps/plugins/surface/web/components/surface-body.tsx`, `window-chrome.tsx`, `window-resize-handles.tsx`, `placement-control.tsx`; `hooks/use-window-geometry.ts` *(plugin — all presentation)*
- `plugins/primitives/plugins/sortable-list/web/internal/sortable-list.tsx` — `onDragOut`
- old `plugins/apps/plugins/surface-arrangement/{core,web,server}` + `plugins/{tabs,desktop}` — variant-region wiring removed
- `config/ui/theme-engine/ui.theme-engine.variant-group.jsonc` *(+ .origin)* — drop entry

## Reused, don't rebuild
- `use-window-geometry.ts` geometry store (per-tabId, sessionStorage) — relocated within the plugin, not rewritten.
- `SortableList`/`SortableItem` dnd context already on the chips — extended, not replaced.
- `SegmentedControl` (`primitives/toggle-chip`), `IconButton`, `defineShortcut`, `Text` — composed.
- The keep-alive + per-tab `PaneStore` machinery in `use-tabs.tsx` — untouched.

## Verification
1. `./equin build`, then `./equin check` (boundaries, registry-in-sync,
   doc-in-sync, type-check must pass after the plugin deletion).
2. Open `http://<worktree>.localhost:9000`. Confirm the theme customizer no longer
   shows "Surface arrangement".
3. Scripted Playwright (`bun e2e/screenshot.mjs`):
   - Open 3 tabs. **Tear-off:** drag one chip downward out of the strip → it
     becomes a floating window; the dragged tab's content is unchanged (no reload).
   - **Toggle:** focused-tab placement control → float (window), → solo (tab bar +
     rail vanish, content fullscreen), → dock (back in strip).
   - **Esc / Exit-fullscreen affordance** in solo returns to docked.
   - Reload the page → each tab restores its placement (and windows their geometry)
     from sessionStorage.
   - Drag a window, maximize/minimize, focus z-order still work (regression of
     desktop behavior).
4. `bun run test:dom plugins/apps` if/after adding a jsdom test for
   `placementStyle` visibility rules.

## Open design choices (defaults chosen; easy to revisit)
- Focused tab floating + docked tabs present → **empty backdrop** (docked tabs
  hidden until focused). Alternative: always show the last-focused docked tab as
  backdrop. Chose empty for a cleaner desktop.
- Exiting solo returns to **docked** (not the tab's prior placement). Simple; could
  remember prior placement later.
- Tear-off spawns the window at the geometry **cascade default**, not the exact
  drop point. Seeding the drop point cleanly would need `apps` to pass a transient
  spawn hint the plugin reads (to keep the apps→plugin dependency direction); judged
  not worth the coupling for v1.
