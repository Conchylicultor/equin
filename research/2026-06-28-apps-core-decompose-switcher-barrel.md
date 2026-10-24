# Decompose the `apps-core` switcher barrel into focused sub-plugins

## Context

The `apps→apps-core` relocation (commit `97177fe99`) moved the switcher infra
into `plugins/apps-core/`, but deliberately **deferred the internal split** — the
prior doc (`research/2026-06-28-apps-extract-apps-core.md`) filed this exact
follow-up: *"split the barrel into `tabs` / `rail` / `tab-bar` / `tab-surface` /
`layout` sub-plugins."*

Today the `apps-core/web` barrel still bundles ~5 distinct, separable
responsibilities behind one plugin:

1. **Tab manager** — the open-tab set, focus model, `navigate()`, the
   focused-placement module store, and the placement-capabilities registry
   (`use-tabs.tsx`, `tabs-store.ts`, `placement-registry.ts`).
2. **App rail** — the left icon strip (`app-rail.tsx` → `AppRail`).
3. **Tab bar** — the top tab strip (`app-tab-bar.tsx` → `AppTabBar`).
4. **Per-tab surface render core** — `TabSurface` + the keep-alive fallback body
   `AppTabsBody` (`tab-surface.tsx`, `apps-layout.tsx`).
5. **The `AppsLayout` `Core.Root` composition** — the root that wires tab bar +
   framing + surface together (`apps-layout.tsx`).

This runs against the project's plugin-first ethos (even mandatory sections
should be their own plugin) and makes the switcher hard to reason about / extend.

**Goal:** decompose the barrel into focused sub-plugins, leaving `apps-core/web`
as the **thin leaf barrel everyone imports** — the `Apps` slot contract + the
app-resolution helpers — with **zero dependency on the tab runtime**.

### Key structural finding (drives the design)

The barrel splits cleanly into a DAG **except** for the theme-scope helpers
(`useChromeThemeScope` / `useRootThemeScope` in `use-chrome-theme-scope.ts`).
They read `useFocusedPlacement` (the tab-manager module store) and
`placementHasAppThemeScope` (the placement registry), so they **depend on the
`tabs` sub-plugin**. Meanwhile `tabs` depends on the leaf barrel (`Apps`,
`resolveAppForPath`, `useActiveApp`). If theme-scope stayed physically in the
`apps-core` barrel it would create an `apps-core ⇄ apps-core/tabs` cycle —
forbidden by boundary **R8** (cycles, type-only edges count). **R3** (no
cross-plugin re-exports) also forbids proxying the moved symbols back through the
barrel to keep old import paths. Verified: no umbrella parent→child cycle
exception exists in `boundary-config.ts`.

→ **Decision (confirmed with user):** theme-scope becomes its **own
`theme-scope` sub-plugin** (not kept in the barrel, not folded into `tabs`). The
app-resolution helpers (a true leaf) **do** stay in the barrel.

→ **Decision (confirmed with user):** the rail component sub-plugin is named
**`app-rail`** (disambiguates from the existing `app-rail-framing/plugins/rail`
framing variant).

## Target structure

```
plugins/apps-core/
  web/index.ts          # THIN LEAF BARREL — slots + app-resolution only
  web/slots.ts          # Apps, RailFramingContribution, SurfaceContribution  (unchanged)
  web/internal/resolve-app.ts      (stays)
  web/internal/use-active-app.ts   (stays)
  web/use-current-app-id.ts        (stays)
  core/                 # RailFramingProps, Placement  (unchanged)
  plugins/
    tabs/               # NEW — tab manager + store + placement registry
    theme-scope/        # NEW — chrome/root theme-scope helpers
    tab-surface/        # NEW — TabSurface render core + AppTabsBody fallback body
    app-rail/           # NEW — AppRail icon strip
    tab-bar/            # NEW — AppTabBar top strip
    layout/             # NEW — AppsLayout Core.Root composition
    surface/            # EXISTING — repoint imports
    app-rail-framing/   # EXISTING — repoint imports
```

### What the thin `apps-core/web` barrel keeps (exports)

- `Apps`, `RailFramingContribution`, `SurfaceContribution` (from `slots.ts`)
- `useActiveApp`, `ActiveApp` (+ `usePathname`, `matchAppForPath`,
  `resolveAppForPath`, `defaultApp`, `ResolvedApp` as needed by sub-plugins)
- `useCurrentAppId`
- `Placement` type (re-export from its **own** `../core` — allowed)

The barrel's default export drops the `Core.Root` contribution (moves to
`layout`). It becomes a contribution-less library plugin (valid; like any leaf
primitive). Keep `loadBearing: true`.

## The dependency DAG (verified acyclic)

```
apps-core (leaf: slots + resolution)
   ▲      ▲      ▲        ▲        ▲
   │      │      │        │        │
 tabs ───┘      │        │        │     tabs → apps-core
   ▲            │        │        │
   ├── theme-scope ──────┤        │     theme-scope → apps-core + tabs
   ├── tab-surface       │        │     tab-surface → apps-core + tabs
   ├── app-rail ── theme-scope    │     app-rail → apps-core + tabs + theme-scope
   ├── tab-bar  ── theme-scope    │     tab-bar  → apps-core + tabs + theme-scope
   └── layout → tabs, tab-surface, app-rail, tab-bar, apps-core
   surface → apps-core + tabs + tab-surface
   app-rail-framing/rail → app-rail
```

## Per-sub-plugin breakdown

### 1. `apps-core/plugins/tabs` (tab manager — co-locates the singletons)
- **Move in:** `web/internal/use-tabs.tsx`, `web/internal/tabs-store.ts`,
  `web/internal/placement-registry.ts`.
- **Why co-located (task constraint):** `use-tabs` holds the `tabsNavigator` +
  `focusedPlacement` module singletons and `placement-registry` holds the
  `capabilities` singleton; `use-tabs` calls `getDefaultPlacement()`. They are
  one page-global runtime — splitting risks duplicate-module-instance breakage.
- **Barrel exports:** `TabsProvider`, `useTabs`, `navigate`,
  `setFocusedTabPlacement`, `getFocusedPlacement`, `useFocusedPlacement`,
  `TabsApi`, `Tab`, `appPathFor` (+ `appContributionFor`), `registerPlacementCapabilities`,
  `getDefaultPlacement`, `useDefaultPlacement`, `tearOffPlacement`,
  `placementIsNewTabFollows`, `placementHasAppThemeScope`, `PlacementCapabilities`.
- **Imports from leaf:** `Apps` (slots), `resolveAppForPath`/`defaultApp`,
  `useActiveApp`, `Placement` (apps-core/core).
- `TabsProvider` is exported (mounted by `layout`), not contributed.

### 2. `apps-core/plugins/theme-scope`
- **Move in:** `web/internal/use-chrome-theme-scope.ts`.
- **Barrel exports:** `useChromeThemeScope`, `useRootThemeScope`.
- **Imports:** `useActiveApp` (apps-core leaf); `useFocusedPlacement` +
  `placementHasAppThemeScope` (tabs).
- No contributions (pure hooks library).

### 3. `apps-core/plugins/tab-surface`
- **Move in:** `web/components/tab-surface.tsx` (`TabSurface` + the 4 title
  reporters) **and** `AppTabsBody` (the keep-alive fallback body, currently in
  `apps-layout.tsx`). Keeping the fallback body next to the render core leaves
  `layout` as pure composition wiring.
- **Barrel exports:** `TabSurface`, `AppTabsBody`.
- **Imports:** `Apps` (leaf); `useTabs`, `appPathFor`, `Tab` (tabs); pane,
  sync-status, slot-render, ui-kit (`appThemeScope`, `PortalThemeScopeProvider`).
- No contributions.

### 4. `apps-core/plugins/app-rail`
- **Move in:** `web/components/app-rail.tsx`.
- **Barrel export:** `AppRail`.
- **Imports:** `Apps`, `useActiveApp` (leaf); `useTabs` (tabs);
  `useChromeThemeScope` (theme-scope); css primitives, tooltip.
- No contributions.

### 5. `apps-core/plugins/tab-bar`
- **Move in:** `web/components/app-tab-bar.tsx` (`AppTabBar` + `TabChip`).
- **Barrel export:** `AppTabBar`.
- **Imports:** `Apps` (leaf); `useTabs`, `getDefaultPlacement`,
  `placementIsNewTabFollows`, `tearOffPlacement` (tabs); `useChromeThemeScope`
  (theme-scope); css/icon-button/tooltip primitives, `ui/tab-bar`.
- No contributions.

### 6. `apps-core/plugins/layout` (the `Core.Root` composition)
- **Move in:** `web/components/apps-layout.tsx` — `AppsLayout`, `FramedSurface`,
  `DefaultRailFraming`, `DocumentTitleSync`, `redirectTo` (and `AppTabsBody`
  leaves for `tab-surface`).
- **Contribution:** `Core.Root({ component: AppsLayout })`. Mark `loadBearing`.
- **Imports:** `Apps`, `useActiveApp`, `defaultApp`, `usePathname` (leaf);
  `TabsProvider`, `useTabs` (tabs); `AppTabsBody`, (`TabSurface` indirectly) from
  `tab-surface`; `AppRail` (app-rail, for `DefaultRailFraming`); `AppTabBar`
  (tab-bar); pane/css/slot-render primitives.

### Existing sub-plugins to repoint (no behavior change)
- **`surface`** (`surface-body.tsx`, `placement-control.tsx`,
  `use-tab-presence.ts`, `floating/*`, `solo/*`): split its
  `@plugins/apps-core/web` imports —
  `TabSurface` → `tab-surface`;
  `useTabs`/`registerPlacementCapabilities`/`getFocusedPlacement`/`Tab` → `tabs`;
  `Apps` stays on the leaf.
- **`app-rail-framing/plugins/rail`** (`rail-framing.tsx`): `AppRail` →
  `app-rail`. `RailFramingProps` stays on `apps-core/core`.

## Cross-plugin consumer repointing (R3: must update import paths, can't re-export)

Most consumers import only leaf symbols and are **unchanged** (all 13 app
`shell`s, `config_v2/settings`, `global-action-bar/index`, `theme-customizer`,
`variant-region-host`, `theme-toggle`, `use-color-mode`, `task-draft-form`).
The moved symbols touch these sites:

| Symbol(s) | New source | Consumers to edit |
|---|---|---|
| `navigate` | `…/plugins/tabs/web` | `debug/reports/.../report-detail.tsx`, `ui/theme-engine/theme-customizer/.../theme-customizer-button.tsx`, `shell/notifications/.../bell-button.tsx`, `apps/story/pages-integration/.../story-section.tsx`, `apps/agent-manager/shell/.../agent-manager-layout.tsx` |
| `useTabs`, `ActiveApp` | `useTabs`→`tabs`; `ActiveApp`/`Apps`/`useCurrentAppId` stay leaf | `apps/home/app-cards/.../app-grid.tsx` (split import) |
| `getFocusedPlacement`, `setFocusedTabPlacement`, `useFocusedPlacement` | `…/plugins/tabs/web` | `shell/global-action-bar/.../global-action-bar.tsx` |
| `useChromeThemeScope` | `…/plugins/theme-scope/web` | `shell/toaster/.../toaster-root.tsx` |
| `useRootThemeScope` | `…/plugins/theme-scope/web` | `ui/theme-engine/.../theme-injector.tsx` (split: `useActiveApp`/`Apps` stay leaf) |

(`theme-customizer-button` and `theme-injector` and `app-grid` each split one
import line into two — leaf symbols stay, moved symbols repoint.)

## Critical files

- Barrel + internals: `plugins/apps-core/web/index.ts`, `web/slots.ts`,
  `web/internal/{use-tabs.tsx,tabs-store.ts,placement-registry.ts,resolve-app.ts,
  use-active-app.ts,use-chrome-theme-scope.ts}`,
  `web/components/{apps-layout,app-rail,app-tab-bar,tab-surface}.tsx`,
  `web/use-current-app-id.ts`, `core/{index.ts,types.ts}`.
- Repoint: `plugins/apps-core/plugins/surface/**`,
  `plugins/apps-core/plugins/app-rail-framing/plugins/rail/web/components/rail-framing.tsx`,
  plus the 7 cross-plugin consumer files in the table above.
- Each new sub-plugin needs `package.json` (`@singularity/plugin-apps-core-<name>`),
  `web/index.ts` barrel (R7 barrel purity: imports + own re-exports + single
  default export only), `CLAUDE.md` (autogen block filled by build), and a
  one-line `description` in the default export.

## Conventions / rules to honor

- **Barrel purity (R7):** sub-plugin `index.ts` = only imports, re-exports of own
  internal files, type aliases, one `default` export. Move JSX into
  `web/components/` per the components-folder convention.
- **No hand registry edits:** `web.generated.ts` / docs / `dependsOn` regenerate
  from the filesystem on `./equin build`. The `Core.Root` moving to
  `layout` is picked up automatically.
- **Slot ids unchanged** (`apps.app`, `apps.surface`, etc.) — only plugin ids for
  the new sub-plugins are added; no persisted `config_v2` reorder churn.
- **Component-internal imports** should use the *sibling* file path within a
  sub-plugin, and the *barrel* path for cross-sub-plugin imports.

## Suggested execution order

1. Create `tabs` (move use-tabs + tabs-store + placement-registry; barrel).
2. Create `theme-scope` (move use-chrome-theme-scope; depends on tabs).
3. Create `tab-surface` (move tab-surface.tsx + AppTabsBody).
4. Create `app-rail`, `tab-bar` (move components; depend on tabs + theme-scope).
5. Create `layout` (move apps-layout.tsx; takes the `Core.Root`).
6. Slim `apps-core/web/index.ts` to the leaf barrel; drop `Core.Root`.
7. Repoint `surface` + `app-rail-framing/rail` and the 7 cross-plugin consumers.
8. `./equin build` (regenerates registry/docs/migrations + runs checks).

## Verification

- `./equin build` — must succeed (regenerates registry + docs; runs
  `type-check`, `plugins-registry-in-sync`, `plugins-doc-in-sync`).
- `./equin check plugin-boundaries` — must pass (proves the DAG is acyclic
  and no illegal cross-plugin re-exports / deep imports were introduced). This is
  the single most important gate for this refactor.
- `./equin check` — full suite green.
- Behavioral smoke test (no behavior should change) via the e2e helper, e.g.:
  ```bash
  bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/agents --out /tmp/apps-core
  ```
  Confirm: app rail switches apps; tab bar opens/closes/reorders tabs and shows
  per-tab titles; floating/docked/solo placements still work; cross-app links
  (notifications bell, reports, story "open in pages", theme customizer) navigate;
  toaster + theme-injector still adopt the focused app's theme (theme-scope).
- Run the moved jsdom/unit tests still co-located under
  `surface/floating/web/hooks/*.test.ts` (they don't move):
  `bun test plugins/apps-core/plugins/surface/plugins/floating`.

## Notes / risks

- **Pure structural move** — no logic changes. The `data-theme-scope` /
  keep-alive / placement-registry behavior is byte-identical; only file homes and
  import paths change.
- The `apps-core` barrel becoming contribution-less is fine (leaf-library
  pattern). If any check assumes the umbrella owns the `Core.Root`, that's now
  `layout` — the autogen registry handles it.
- Watch for the module-singleton hazard: `tabs` must be a single sub-plugin so
  `tabsNavigator` / `focusedPlacement` / `capabilities` resolve to one module
  instance — do not split placement-registry out of `tabs`.
