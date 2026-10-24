# Unify theme model: desktop = `:root`, eliminate the `:root` / chrome-scope duality

## Context

The theme system has **two sources of truth** for "what theme a surface shows":

1. The global `:root` / `.dark` blocks — emitted by `ThemeInjector`, currently fed
   by the **focused app's** config. `:root` doubles as "focused app theme" AND
   "neutral base".
2. The per-surface `[data-theme-scope=…]` override blocks — `ScopedAppTheme`
   (one `[data-theme-scope="app:<id>"]` block per open app) plus a separate
   `ChromeTheme` emitting `[data-theme-scope="chrome"]` fed by the *unscoped*
   (global) config. `ChromeTheme` exists **only because** `:root` was hijacked to
   follow the focused app, so a stable neutral layer was needed for the chrome
   (rail, tab bar, toaster, desktop backdrop).

The recent pre-paint cache fix (`research/2026-06-17-unified-prepaint-theme-cache.md`)
unified the *cache* across all scopes, but the underlying conceptual duality
remains.

**End state (this pass):** one rule — a subtree's theme = its nearest
`data-theme-scope` ancestor, and **`:root` carries the stable global "desktop"
theme** (focus-independent, from the unscoped config). The focused app no longer
writes `:root`. The redundant `chrome` scope + `ChromeTheme` collapse into `:root`
(chrome surfaces that have no app to track simply inherit the desktop `:root`).

**Decisions locked with the user:**
- **Chrome keeps tracking the focused app.** In docked/solo (one app fills the
  surface) the rail/tab-bar/toaster still wear `data-theme-scope="app:<id>"`.
  Only the floating / no-app fallback changes — from the deleted `chrome` scope to
  **bare `:root`** (the desktop theme).
- **Per-scope light/dark is DEFERRED.** Color mode stays a single global
  `<html>.dark`. This pass *repoints* it to the desktop (unscoped) config so it is
  focus-independent like the rest of `:root`. A forked app's own `colorMode` thus
  becomes visually inert until the deferred per-scope-dark pass (its scoped dark
  block still gates on the global `.dark`); a forked app's *preset* still applies
  fully via its scope block. This is an accepted, documented interim.

## Why this is clean

`ChromeTheme` already does exactly what the new `:root` must do — render the
**global/unscoped** config — it just targets `[data-theme-scope="chrome"]` instead
of `:root`. So "collapse chrome into `:root`" = point `ThemeInjector`'s `:root`
writer at the global config (what `ChromeTheme` did) and delete `ChromeTheme`.

And once `:root` = the global/desktop theme, an **unforked** app's theme *is* the
`:root` theme — so its subtree needs no override block at all. **Only forked apps
need a `[data-theme-scope="app:<id>"]` block.** This shrinks the scoped-block set
to ~0 in the common case and makes the rule sharp: `:root` is the desktop/base,
scope blocks are forked-app overrides.

## Implementation

### 1. `ThemeInjector` → desktop theme writer
`plugins/ui/plugins/theme-engine/web/components/theme-injector.tsx`

Feed the `:root`/`.dark` blocks, the `<html>.dark` toggle, and the cache `mode`
from the **global (unscoped) config** instead of the active app:
- The `GroupStyle` children: pass `scopeId={undefined}` (was the active app's
  `app:<id>`), so they emit `:root` / `.dark` from the base config.
- `ColorModeApplier`: `resolved = useResolvedColorMode(undefined)` (desktop mode).
- `colorMode` for `setPaintContext`: `useConfig(themeEngineConfig, { scopeId: undefined })`.
- Keep the active-app `scopeId` / `forked` / `persistActiveForkedScope` effect and
  `setPaintContext({ appPath: active?.path, … })` — still used for cache keying and
  the boot re-hydration of the active forked scope.

### 2. Delete `ChromeTheme`
- Remove the `ChromeTheme` component (same file, lines ~290–316).
- `plugins/ui/plugins/theme-engine/web/index.ts`: drop the `ChromeTheme` import,
  the `export { … ChromeTheme … }`, and the `Core.Root({ component: ChromeTheme })`
  contribution.
- Fix the stale comment in
  `plugins/ui/plugins/theme-engine/web/internal/paint-cache-aggregator.ts:7`.

### 3. `ScopedAppTheme` → forked-only, mounted centrally
`plugins/ui/plugins/theme-engine/web/components/theme-injector.tsx`
- Gate emission on fork: `const forked = useScopeForked(appThemeScope(appId));
  if (!forked) return null;` — an unforked app inherits `:root`, so it needs no
  block. (Reuses `useScopeForked` from `@plugins/config_v2/web`, already imported.)
- Add a new `Core.Root` component (e.g. `AppScopeThemes`) that mounts one
  `<ScopedAppTheme appId={app.id}/>` per `Apps.App.useContributions()`. Slot reads
  are **provider-free**, so this works at `Core.Root` (no `TabsProvider` ancestor —
  the reason it can't live off `useTabs`). Register it in `index.ts` alongside
  `ThemeInjector`. This replaces `surface-body`'s per-open-app mounting and is what
  lets the degraded `AppTabsBody` path be themed without an `apps → theme-engine`
  import cycle (see step 6).
- Import `Apps` from `@plugins/apps/web` (the `theme-engine → apps` edge already
  exists via `useActiveApp`).

### 4. Remove the `chrome` scope token
- `plugins/primitives/plugins/ui-kit/web/components/portal-theme-scope.tsx`: delete
  `export const CHROME_THEME_SCOPE`.
- `plugins/primitives/plugins/ui-kit/web/index.ts`: drop the `CHROME_THEME_SCOPE`
  re-export.

### 5. `useChromeThemeScope` → app-or-undefined
`plugins/apps/web/internal/use-chrome-theme-scope.ts`
- Return `string | undefined`; fallback from `CHROME_THEME_SCOPE` to `undefined`
  (no attribute → inherit `:root` desktop theme). Update the JSDoc (the
  `{@link CHROME_THEME_SCOPE}` reference).
- Consumers already tolerate `undefined`: `data-theme-scope={themeScope}` omits the
  attribute and `PortalThemeScopeProvider scope={themeScope}` accepts `undefined`:
  - `plugins/apps/web/components/app-rail.tsx`
  - `plugins/apps/web/components/app-tab-bar.tsx`
  - `plugins/shell/plugins/toaster/web/components/toaster-root.tsx`

### 6. `surface-body` — drop chrome scope + local ScopedAppTheme mount
`plugins/apps/plugins/surface/web/components/surface-body.tsx`
- Remove `data-theme-scope={CHROME_THEME_SCOPE}` from the backdrop `<div>` (it now
  inherits `:root` = desktop). Remove the `CHROME_THEME_SCOPE` import.
- Remove the `{appIds.map((id) => <ScopedAppTheme … />)}` block and the
  `ScopedAppTheme` import (now mounted centrally in theme-engine, step 3). Keep the
  `appIds`-derived `PlacementCapabilities` logic.
- `TabContainer` keeps `data-theme-scope={`app:${tab.appId}`}` and its
  `PortalThemeScopeProvider` — unchanged.
- Update `plugins/apps/plugins/surface/CLAUDE.md` "Uses" (autogen via build).

### 7. Fix the degraded fallback `AppTabsBody`
`plugins/apps/web/components/apps-layout.tsx`
- Wrap each tab's content with the app scope so it is themed by the same central
  scoped blocks the real surface uses:
  ```tsx
  <div … data-theme-scope={appThemeScope(tab.appId)}>
    <PortalThemeScopeProvider scope={appThemeScope(tab.appId)}>
      <TabSurface tab={tab} />
    </PortalThemeScopeProvider>
  </div>
  ```
  `appThemeScope` + `PortalThemeScopeProvider` are already imported by `apps` from
  ui-kit (no new edge, no cycle). Unforked apps simply inherit `:root` (correct —
  same as the real surface); forked apps pick up their central override block.

### 8. Docs
- `.claude/skills/theme/SKILL.md`: update the pre-paint section to state `:root` =
  desktop (global) theme, scope blocks = forked-app overrides, `chrome` scope
  removed.
- Append a short "landed" note to
  `research/2026-06-17-unified-prepaint-theme-cache.md`'s deferred-follow-ups (the
  duality item is now done; per-scope dark still pending).
- Plugin `CLAUDE.md` autogen reference blocks regenerate on `./equin build`.

## What is explicitly NOT changed
- Scoped dark selector stays `.dark [data-theme-scope=…]` (ancestor gate) —
  per-scope dark is deferred.
- `index.html` replay script, `theme-cache.ts` envelope shape, and the aggregator's
  flush/prune mechanics are untouched (the replay is CSS-agnostic; it injects
  whatever ids are cached, and `<html>.dark` now reflects the global mode stored in
  `entry.mode`). Cache keying by `appPath` becomes largely path-independent for
  `:root` but is left as-is; a later simplification to a single global entry is a
  possible follow-up, out of scope here.
- `useColorMode` (toaster/Sonner) is left as-is. In the common (unforked) case its
  resolved mode == global == desktop, so it stays consistent; the only divergence
  is a forked-different-mode app, which is the deferred per-scope-dark case.

## Critical files
- `plugins/ui/plugins/theme-engine/web/components/theme-injector.tsx` (ThemeInjector, ScopedAppTheme, delete ChromeTheme, new AppScopeThemes)
- `plugins/ui/plugins/theme-engine/web/index.ts` (registrations/exports)
- `plugins/ui/plugins/theme-engine/web/internal/paint-cache-aggregator.ts` (comment)
- `plugins/primitives/plugins/ui-kit/web/components/portal-theme-scope.tsx` + `…/web/index.ts` (remove `CHROME_THEME_SCOPE`)
- `plugins/apps/web/internal/use-chrome-theme-scope.ts` (fallback → `undefined`)
- `plugins/apps/plugins/surface/web/components/surface-body.tsx` (drop chrome scope + local ScopedAppTheme)
- `plugins/apps/web/components/apps-layout.tsx` (AppTabsBody scope)
- `.claude/skills/theme/SKILL.md`, `research/2026-06-17-unified-prepaint-theme-cache.md`

## Verification

1. `./equin build` (regenerates docs/registry; runs checks incl.
   `plugin-boundaries`, `type-check`, `eslint`, `plugins-doc-in-sync`). Must pass —
   in particular confirms no `apps ↔ theme-engine` cycle and no dangling
   `CHROME_THEME_SCOPE` references.
2. App at `http://att-1781696003-bpd5.localhost:9000`. With a scripted Playwright
   run (`bun e2e/screenshot.mjs`), verify:
   - **Desktop stability**: switching the focused docked app does NOT recolor the
     backdrop/`:root`; chrome (rail/tab bar) still recolors to the focused app
     (docked) and goes neutral desktop in floating/multi-window.
   - **Per-app preset**: fork one app to a distinct preset (theme customizer →
     "Customize for this app") — only that app's surface recolors; other apps and
     the desktop chrome stay on the base theme.
   - **No reload flicker**: hard-reload while a forked app is focused — it paints
     its own theme on frame 0 (the landed pre-paint cache still covers the scope
     block); chrome/backdrop paint the desktop theme with no global→app snap.
   - **Light/dark**: toggling color mode flips the whole desktop (global) as today.
   - **Floating windows**: a floating window shows its app's theme; the wallpaper
     backdrop + chrome show the desktop `:root` theme.
3. Confirm via DevTools that there is no `[data-theme-scope="chrome"]` element or
   `theme-scope-chrome-*` `<style>` left, and that unforked apps emit no
   `theme-scope-app:*` block (only forked ones do).
