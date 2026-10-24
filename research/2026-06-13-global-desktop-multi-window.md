# Desktop multi-window mode

**Date:** 2026-06-13
**Category:** global (apps + primitives/pane + layouts)
**Status:** Plan — awaiting approval

## Context

Now that we have multi-app + tabs, every open tab already carries its **own
independent pane route** (`Tab = {tabId, appId, store: PaneStore}`) and **all
tabs are already mounted at once** via keep-alive (`display:none` on the
unfocused ones — `apps-layout.tsx:73-74`). The only thing stopping us from
showing several apps side-by-side on one screen is that exactly one surface is
ever *visible*, and a pile of **global singletons** assume "one active surface":

- `liveStore` (module-global pointer, `pane.ts:661`) — every imperative
  navigation free function targets it.
- `useActiveApp()` / `useCurrentAppId()` (`use-active-app.ts:28`) — derive the
  active app from `window.location.pathname`. Fine when only one surface is
  visible; **wrong the moment a second surface is on screen** (its rail
  highlight, floating-bar visibility, per-app theme scope, and the
  conversation-list highlight would all read the *focused* window's URL).
- `useColumnMaximize` (`use-column-maximize.ts`) — module-global `maximizedId`;
  maximizing a column in one surface force-collapses columns in every other
  mounted surface.

So the work is two stages:

- **Stage 1 — scope-by-context refactor.** Make per-surface reads resolve from
  the surface's own `PaneStore` + appId instead of the global URL/singletons.
  Valuable on its own, zero behavior change in tabs mode, independently
  reviewable.
- **Stage 2 — desktop window arrangement.** A new switchable surface
  arrangement that renders each `Tab` as a free-floating, draggable, resizable
  window. Pure spatial re-arrangement of the same `Tab[]` — reuses the entire
  tab/PaneStore lifecycle unchanged.

### Decisions (confirmed with user)

- **URL model: focused window owns the URL.** Keep exactly one `live` store (the
  focused window); it mirrors to the URL. Other windows hold their route in
  memory (today's keep-alive model, just rendered concurrently). Clicking a
  window focuses it → makes it live → asserts its route to the URL. Deep links
  restore one app. No multi-surface URL serialization.
- **Window style: free-floating** — drag/resize/overlap, z-order on focus,
  maximize/minimize. Built on raw pointer events (the existing `ResizeHandle`
  idiom), not a new dependency.
- **Delivery: two stages**, two separate pushes.

---

## Stage 1 — Scope-by-context refactor

Goal: when code runs inside a `PaneSurfaceProvider`, "the active app" and "open
this pane" resolve to **that surface**, not the global URL / `liveStore`. After
this stage, tabs mode behaves identically (only one surface visible, so
focused-surface == global), but the foundation is multi-surface-correct.

### 1a. Carry `appId` on the surface context

`PaneSurfaceProvider` already binds `store` + `basePath` per tab
(`pane.ts:711`). Add the owning `appId` to that context so consumers can read
the surface's app without touching `window.location`.

- `plugins/primitives/plugins/pane/web/pane.ts` — add an `appId?` to
  `PaneSurfaceProvider` props and a `PaneSurfaceAppContext` (or fold into the
  existing surface context). Expose `useSurfaceAppId()`.
- `plugins/apps/web/components/apps-layout.tsx:76` — pass `appId={tab.appId}`
  when rendering each tab's `PaneSurfaceProvider`.

### 1b. Make `useActiveApp` / `useCurrentAppId` context-aware

`plugins/apps/web/internal/use-active-app.ts` and
`plugins/apps/web/use-current-app-id.ts`:

- New behavior: **if a surface app context is present, return that app**
  (looked up from the `Apps.App` registry by id); **else fall back** to the
  current `window.location.pathname` logic (for code outside any surface, e.g.
  the app rail itself, which legitimately wants the *focused* app).
- This single change fixes the per-app consumers automatically — they already
  call `useCurrentAppId()`:
  - `theme-customizer.tsx:184`, `use-color-mode.ts:42`, `theme-toggle.tsx:8`,
    `variant-region-host.tsx:20`, `theme-injector.tsx:172` → per-app theme/config
    scope becomes per-surface.
  - `app-grid.tsx:8` launcher highlight, `use-capture-url-default.ts:14`.
- `app-rail.tsx:12` and `floating-bar.tsx:39` are **outside** any surface →
  keep reading the focused app (correct: the rail/floating bar reflect the
  focused window). No change needed, fallback path covers them.

### 1c. Fix `conversation-list` URL read

`plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx:19,23`
reads `window.location.pathname` directly (+ its own `popstate` listener) to
highlight the active conversation. In a visible background surface this shows
the *focused* window's selection. Replace with a read of **its own surface's
route** via `usePaneStore()` / `useRoute()` (the component is already inside the
surface and already calls `useOpenPane()` at line 16).

### 1d. Scope `useColumnMaximize` per surface

`plugins/layouts/plugins/miller/web/hooks/use-column-maximize.ts` — replace the
module-global `maximizedId` + subscriber set with **per-store state**. Cleanest:
store `maximizedId` on the `PaneStore` instance (or a `WeakMap<PaneStore, …>`
keyed by `usePaneStore()`), so each Miller surface maximizes independently.
Consumers in `column.tsx:23,54,56` switch to the store-scoped hook. Mirrors how
`use-column-widths.ts` / `use-column-collapse.ts` are keyed, but keyed by
surface rather than global.

### 1e. Migrate context-available imperative call sites to hooks

Switch TSX/​hook call sites that import the **free** `openPane`/`clearRoute`/
`reorderRoute`/`getRoute`/`restoreRoute` to the context hooks
(`useOpenPane()`, `usePaneStore()`), so they act on their own surface. The
Explore pass enumerated these (Category A/B in the call-site map). Notable:
`miller-columns.tsx:39,43` (use `store.getRoute()`/`store.reorderRoute()` from
the `usePaneStore()` it already has), Sonata/Story back buttons, the various
`*-chip` / `*-pane` components.

**Intentionally left targeting `liveStore` (correct = act on focused window):**

- The ~20 `index.ts` sidebar nav `onClick: () => openPane(...)` lambdas — static
  slot contributions with no React/surface context. Sidebar nav *should* act on
  the focused window. Leave on the `liveStore` indirection.
- `pane-restore-store.ts:41` — `getRoute()` in a module-level `popstate`
  listener; always wants the focused route. Leave.
- `apps-layout.tsx:229` `setBasePath(liveStore)` — documented global registry
  sync for global actions; leave.

> Don't try to eliminate `liveStore`. It stays as the **focused-surface
> pointer** — that's exactly the right abstraction under "focused window owns
> the URL". The refactor is about *context-available* code preferring its own
> surface, not about deleting the global.

### Stage 1 verification

- `./equin build`, then in tabs mode confirm **no behavior change**:
  switch tabs, open/close panes, maximize a Miller column, toggle theme per app
  — all identical to before.
- `bun run test:dom plugins/primitives/plugins/pane` and any
  `plugins/layouts/.../__tests__` if present.
- Targeted check: open two tabs (Agents + Pages), confirm column-maximize in one
  no longer affects the other once both are mounted (today it would — this is
  the observable proof the scoping landed). Use `e2e/screenshot.mjs` with
  `--click` to drive it.

---

## Stage 2 — Desktop window arrangement

Goal: a switchable surface arrangement that lays the same `Tab[]` out as
free-floating windows. Insertion point is the `body` handed to the rail framing
in `FramedSurface` (`apps-layout.tsx:255-268`) — today always `<AppTabsBody />`.

### 2a. `Apps.SurfaceArrangement` variant region

Model it exactly like `app-rail-framing` (rail/hidden):

- New plugin `plugins/apps/plugins/surface-arrangement/` with:
  - `core/region.ts`: `defineVariantRegion<SurfaceArrangementProps>({ id:
    "apps-surface-arrangement", label: "Surface arrangement", defaultVariant:
    "tabs" })` (global scope). See `app-rail-framing/core/region.ts:13`.
  - `web/region.ts`: `defineVariantRegionWeb(...)` → `.Region`, `.Variant`,
    `.Picker`, `.contributions`. See `app-rail-framing/web/region.ts`.
  - `web/index.ts`: spread `.contributions`; the `Region` host calls
    `useTabs()` and passes the tab slice as `SurfaceArrangementProps` to the
    active variant. The `Region` becomes the new `body` in `FramedSurface`.
- Sub-plugins:
  - `plugins/.../surface-arrangement/plugins/tabs/` — variant `tabs`; component
    = the **existing** `AppTabsBody` (move/lift it here or re-render it).
  - `plugins/.../surface-arrangement/plugins/desktop/` — variant `desktop`;
    component = new `AppWindowsBody`.
- `apps-layout.tsx` `FramedSurface` (line ~255): replace `body={<AppTabsBody/>}`
  with `body={<SurfaceArrangement.Region {...} />}`.
- Picker shows up in the theme customizer automatically via the
  `ThemeEngine.VariantGroup` contribution (same as rail/sidebar framing).

`SurfaceArrangementProps` carries what both variants need: `tabs: Tab[]`,
`focusedTabId`, `apps`, and the focus/close handlers from `useTabs()`. Each
variant still renders, per tab, the **same**
`<PaneSurfaceProvider store={tab.store} basePath={...} appId={tab.appId}>` core
(`apps-layout.tsx:76-83`) — identical mounting, different spatial container.

### 2b. `AppWindowsBody` (the desktop variant)

A `relative h-full w-full transform-gpu` container (keep `transform-gpu` so
`position:fixed` sidebars inside each app stay bounded to their window — the
same trick as `apps-layout.tsx:65`). For each tab render a window frame:

```
<div class="absolute" style={{left:x, top:y, width:w, height:h, zIndex:z}}>
  <WindowChrome titlebar(drag) + resize handles />
  <div class="relative flex-1 transform-gpu">      ← per-window containing block
    <PaneSurfaceProvider store appId basePath>
      {renderIsolated(Apps.App.id, app)}            ← unchanged app shell
```

- **Titlebar drag + resize**: raw pointer events following
  `plugins/layouts/plugins/miller/web/components/resize-handle.tsx:9`
  (`onPointerDown` → `window` `pointermove`/`pointerup`, emit deltas). Titlebar
  emits `{dx,dy}` → move; 8 edge/corner handles → resize. No new dependency.
- **Focus / z-order**: pointer-down anywhere in a window calls
  `useTabs().focusTab(tabId)` (→ `activate()` makes it live and mirrors its
  route to the URL — Stage-1-correct) and bumps its `z` to top.
- **Maximize / minimize**: reuse the now-surface-scoped `useColumnMaximize`
  pattern, or a small per-window state; maximize = fill the desktop, minimize =
  collapse to a titlebar strip. (`use-column-maximize.ts` /
  `use-column-collapse.ts` as references.)
- **App shells need no change** — they already fill `h-full` whatever box
  they're given (`AppShellLayout` `app-shell-layout.tsx:72`, `MillerColumns`
  `flex h-full`).

### 2c. Window geometry store

Modeled on `use-column-widths.ts:49` (module-global `Map` + `useSyncExternalStore`
+ storage), keyed by `tabId`:

- New `useWindowGeometry(tabId): [Geometry, setGeometry]` where
  `Geometry = {x,y,w,h,z}`.
- Persist to a **separate** `sessionStorage` key (`"app-windows:" +
  getTabId()` via `@plugins/primitives/plugins/tab-id/web`) — keep
  `PersistedTabs` (`tabs-store.ts:35`) untouched so tabs-mode round-trip is
  unaffected. New windows get a cascade/default position; closing a tab drops
  its geometry entry.

### 2d. New-window affordance

In desktop mode, the existing tab-creation paths (`openTab`,
`replaceTabApp`, the app rail's `replaceTabApp` at `app-rail.tsx:22`, the
home-launcher cards) all still create `Tab`s — they just appear as windows. The
`AppTabBar` can stay visible (acts as a window list / taskbar) or hide in
desktop mode; default: keep it as a taskbar. Clicking a rail icon in desktop
mode should **open a new window** for that app rather than replacing the
focused one — small branch in the rail click handler keyed on the active
arrangement variant.

### Stage 2 verification

- `./equin build`. Open the theme customizer → Surface arrangement →
  Desktop. Confirm switching is live and reversible (tabs ⇄ desktop) with no
  reload.
- Drive with `e2e/screenshot.mjs`: open 2–3 apps as windows, drag/resize,
  confirm each window navigates independently (open a pane in window A, verify
  window B's route and the rail/floating-bar reflect the focused window only).
- Confirm focused-window-owns-URL: focus window A → URL is A's route; focus B →
  URL becomes B's route (`replaceState`, no history spam); reload restores the
  focused window from the URL and background windows from their in-memory/
  persisted routes.
- Confirm geometry persists across reload (sessionStorage) and that tabs-mode
  persistence is unchanged.

---

## Critical files

**Stage 1**
- `plugins/primitives/plugins/pane/web/pane.ts` — surface appId context, `liveStore` stays as focused pointer
- `plugins/apps/web/internal/use-active-app.ts`, `plugins/apps/web/use-current-app-id.ts` — context-aware active app
- `plugins/apps/web/components/apps-layout.tsx:76` — pass `appId` to `PaneSurfaceProvider`
- `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx:19,23`
- `plugins/layouts/plugins/miller/web/hooks/use-column-maximize.ts` + `components/column.tsx`
- `plugins/layouts/plugins/miller/web/components/miller-columns.tsx:39,43`
- Category-A TSX call sites (free `openPane`→`useOpenPane`) per the call-site map

**Stage 2**
- `plugins/apps/plugins/surface-arrangement/{core,web}/**` (new variant region)
- `plugins/apps/plugins/surface-arrangement/plugins/{tabs,desktop}/web/**` (variants)
- `plugins/apps/web/components/apps-layout.tsx` — `FramedSurface` body → `SurfaceArrangement.Region`; lift `AppTabsBody`
- `plugins/apps/web/components/app-rail.tsx:22` — desktop-mode: new window vs replace
- New `useWindowGeometry` + sessionStorage store (ref `use-column-widths.ts:49`)

## Reuse (don't rebuild)
- Variant-region factory: `defineVariantRegion` / `defineVariantRegionWeb`
  (`plugins/ui/plugins/variant-region/**`), pattern in `app-rail-framing/**`.
- Pointer-drag idiom: `resize-handle.tsx:9`.
- Per-key external-store pattern: `use-column-widths.ts`, `use-column-collapse.ts`.
- Whole tab/PaneStore lifecycle (`use-tabs.tsx`) — unchanged.
- `PaneSurfaceProvider` (`pane.ts:711`) — unchanged, just rendered N× visibly.

## Out of scope (possible follow-ups)
- Multi-surface URL deep-links (chose focused-window-owns-URL).
- Tiling / snap-to-grid (chose free-floating).
- Cross-window history (back/forward stays per focused surface, as today).
