# First-paint flashes on equin.ai/website: theme + slot order

## Context

Loading `https://equin.ai/website` shows two flashes before it settles (frame
recording, 2026-10-26):

1. **Layout** (~230→240 ms): the header nav renders in raw contribution order,
   then jumps to its configured order (`config/apps/website/shell/header.jsonc`).
   `reorder`'s `useReorderTree` reads `useConfig`, which answers
   `descriptor.defaults` (`items: []`) while the document loads. On equin.ai it
   IS loading on first render: the `website` composition extends
   `served-baseline`, which bundles no `infra.boot-snapshot`, so no config is
   preloaded (each `config-v2.values` arrives by its own GET).
2. **Theme** (~293→342 ms): the server roots `:root` on the website theme at
   `/website` (`theme-engine/server/internal/theme-head.ts`), but the client's
   `useRootThemeScope()` answers `undefined` — the composition has no
   `apps-core/surface`, so nothing registers placement capabilities, and "not
   known" folds into "no app owns the surface". `ThemeInjector` repaints
   `:root` with the desktop theme; the website surface wears it until the
   `app:website` scoped block lands.

Both are the same mistake: **a not-known-yet answer stood in by a value**. The
fix makes "not known" a state every reader must handle, and removes the window
where it can.

## Approach

### A — Slot-order contract + composition (lands first)

- `SlotRender.Order.useOrder`, `useSlotOrder`, `useReorderTree`,
  `useReorderedEntries`, `useLayoutOrder` return
  `ResourceResult<…>` (`@plugins/primitives/plugins/live-state/web`; no cycle,
  allowed web→web). `useReorderTree = useMemo(mapResource(useConfigResult(d),
  doc => doc.items ?? []))`. No-order fallback = `readyResource(contributions)`.
- Error arm: with `stale` → the stale layout; without → never raw order (it
  would show hidden items); hosts render their error / nothing.
- `ReorderListMiddleware`: renders nothing until the tree is known (no
  sentinel/area/items mounted → no churn on the switch, and no edit-mode write
  over an empty layout). Ready ↔ error-with-stale keep one element.
  Accepted: the git-defaults preview toggle (dev affordance) re-enters loading
  and remounts areas.
- `served-baseline` gets `infra.boot-snapshot.**` in
  `plugins/plugin-meta/plugins/composition/core/config.ts` (+ pinned list in
  `config.test.ts`); the `.jsonc` regenerates on `./equin build`.
- Lint: add the hooks to `RESOURCE_HOOKS` in
  `plugins/primitives/plugins/live-state/lint/no-pending-data-collapse.ts`.

### B — Every call site handles the state

| Site | While loading |
|---|---|
| `apps-core/surface` surface-body | gate → `SurfaceBodyReady`; registers capabilities only once known; spinner meanwhile |
| placement-control | Layout row with loading block |
| z-layers `useZStackIndex` → `ResourceResult<number>`; viewport-overlay / toaster-host | render nothing until known (verify sonner keeps pre-mount toasts) |
| app-launcher, desktop launcher | combine with the listing result |
| page block-type-list + block menus | loading rows |
| artifacts-button | loading |
| health-report-panel | loading rows (verdict derives from rows) |
| sonata label-lane / hover-preview | empty reserved lane / null |
| tabbed-view | header kept, loading body |
| data-view, data-view-switcher | shell placeholder (`ready:false`), never "No views" |
| settings-control-panel | loading, not "Nothing to configure" |
| use-toolbar-controls | `ResourceResult`; no triggers, no count badge |
| row-order | report `pending` → body's existing loading state |

### C — Theme

- Delete the folding `useRootThemeScope()`; every consumer reads
  `useRootThemeScopeState()`: `ThemeInjector` (a `held` prop on the SAME
  `ScopeStyles` element → `values=null`, server CSS kept, ids still claimed),
  `ScopedAppTheme` (held while unknown), icon bridge (root and sub publish
  nothing while unknown), `useColorModeSetting`.
- `AppTabsBody` (the fallback body when no `Apps.Surface`) registers its own
  capabilities: `{ defaultId: "docked", ids/appThemeScope: {"docked"} }` — it
  is a docked full-area surface, so the focused app owns `:root`, matching the
  server.
- AppsLayout's `load-error` / `home-missing` / `not-found` outcomes register an
  empty capability set (no app owns the surface → desktop), so root becomes
  known there too; NOT the `loading` outcome.

## Verification

- `./equin test` on reorder, slot-render, surface, z-layers, data-view,
  theme-engine, tab-surface, live-state lint; new tests per package (pending
  renders nothing / one mount across ready→stale; held `<style>` keeps identity
  and server text; AppTabsBody registers + disposes).
- `./equin build` (checks incl. type-check, compositions in sync).
- Frame recording of `/website` on the built website composition (same iframe
  per-frame probe as the diagnosis): nav order and `:root` theme constant from
  first content frame on.
