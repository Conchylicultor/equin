# Per-window theming in desktop multi-window mode

## Context

In the **desktop** surface arrangement (`plugins/apps/plugins/surface-arrangement/plugins/desktop`),
open tabs are laid out as free-floating, simultaneously-mounted windows. Today every
window shares one global theme: `ThemeInjector` is a single `Core.Root` instance that
reads the *focused* app via `useActiveApp()` and writes the resolved tokens to a global
`:root {…}` / `.dark {…}` block in `document.head`. All windows read the same `:root`,
so a Studio window and a Conversations window look identical.

**Goal:** each desktop window's subtree shows the theme configured for *its* app, while
the desktop chrome (backdrop) and all portaled UI keep a single coherent theme.

**Decisions (locked with the user):**

1. **Palette per window, color mode shared.** Each window gets its own preset / palette /
   fonts / radius / shadow (everything expressed as CSS custom properties). Light vs. dark
   stays **global** — driven by the focused window, as today. Rationale: CSS vars override
   cleanly per subtree, but class-based dark mode (`<html>.dark`, Tailwind `dark:`) cascades
   into descendants and cannot be reversed per-subtree, and portals escape the subtree
   entirely. Per-window light/dark is deferred (see Follow-ups).

2. **Chrome = focused window's theme.** The desktop backdrop and all portaled content
   (popovers, dialogs, dropdowns, selects, tooltips, toasts — all portal to `document.body`
   via Base UI) use the global `:root` theme, which is *already* the focused app's theme.
   No new "Desktop" scope, no customizer changes.

The happy consequence of (2): the **entire existing global path is untouched** — the
`Core.Root` `ThemeInjector`, the `<html>.dark` toggle (`ColorModeApplier`), and the
pre-paint localStorage cache (`theme-cache.ts` + the `web-core/index.html` replay) all stay
exactly as they are. This feature is purely **additive scoped overrides** layered on top,
active only in desktop mode.

## Why this is now small

- **`useActiveApp()` already resolves per-tab.** Inside a `TabSurface`, it reads
  `PaneSurfaceAppContext` (set per tab by `PaneSurfaceProvider`), returning *that tab's* app
  (`plugins/apps/web/internal/use-active-app.ts:36`). The same hooks the global injector uses
  resolve a window's own theme when mounted inside/around that window.
- **No dark-class work.** Shared mode means scoped blocks reuse the global `.dark` on
  `<html>`: `.dark [data-theme-scope="app:x"] { …dark vars… }` matches when the global mode is
  dark. No per-window class.
- **No cache work.** Scoped `<style>` is injected in a `useLayoutEffect`, which runs before
  the browser paints the window subtree → no flash, so the localStorage pre-paint cache
  (which exists to theme the shell before React hydrates) is irrelevant to scoped overrides.

## Design

Two cooperating layers:

| Layer | Selector | Driven by | Serves |
|---|---|---|---|
| Global (unchanged) | `:root` / `.dark` | focused app (`useActiveApp` URL fallback) | chrome backdrop, **all portals**, tabs mode |
| Scoped (new) | `[data-theme-scope="app:<id>"]` / `.dark [data-theme-scope="app:<id>"]` | each mounted app's `app:<id>` config | inline (non-portaled) content inside each window |

Scoped specificity (`[data-theme-scope]` = 0,1,0; `.dark [data-theme-scope]` = 0,2,0) beats
the global `:root` (0,1,0) / `.dark` (0,1,0) **within** a window, and falls through to `:root`
outside it. Each scoped block emits the full token set, so nothing falls through unintentionally.

## Implementation

### 1. Parameterize serialization by selector — `plugins/ui/plugins/theme-engine/web/internal/serialize-vars.ts`

`renderGroupBlock(descriptor, light, dark)` currently hardcodes `:root` / `.dark`. Add an
optional selector pair (default preserves byte-identical output for the global path, on which
the pre-paint cache's no-flash identity depends):

```ts
export function renderGroupBlock(
  descriptor, light, dark,
  selectors: { light: string; dark: string } = { light: ":root", dark: ".dark" },
): string {
  return `${selectors.light} {\n${buildVarsBlock(descriptor, light)}\n}\n`
       + `${selectors.dark} {\n${buildVarsBlock(descriptor, dark)}\n}`;
}
```

Scoped callers pass `{ light: '[data-theme-scope="app:x"]', dark: '.dark [data-theme-scope="app:x"]' }`.

### 2. Make `GroupStyle` scope-aware — `plugins/ui/plugins/theme-engine/web/components/theme-injector.tsx`

`GroupStyle` already takes `scopeId` (for the config read). Extend it to optionally render a
**scoped** block:

- Add an optional `appScope?: string` (an app id). When set:
  - styleId becomes `theme-scope-${appScope}-${group.id}` (distinct prefix — see note below).
  - pass scoped selectors to `renderGroupBlock`.
  - **do not** call `report(...)` (no pre-paint cache for overrides) — gate the existing
    `report` calls on `!appScope`.
- When unset, behaves exactly as today (global `:root`, `theme-engine-<group>` id, reports to cache).

**Prune-collision note:** the global `ThemeInjector` prunes orphan styles via
`querySelectorAll('style[id^="theme-engine-"]')` (theme-injector.tsx:256). Using the distinct
`theme-scope-` id prefix keeps scoped styles out of that sweep. Scoped styles are cleaned up by
their own component unmount (one injector per distinct mounted app — see step 3), so they need
no separate prune.

### 3. Add `ScopedAppTheme` and mount one per distinct desktop app

New component (theme-engine web, exported from its barrel), mirroring `ThemeInjector`'s body
but for a fixed app id and scoped output:

```tsx
export function ScopedAppTheme({ appId }: { appId: string }) {
  const scopeId = `app:${appId}`;
  const groups = ThemeEngine.TokenGroup.useContributions();
  const colorTransforms = ThemeEngine.ColorTransform.useContributions();
  const styles = groups.map((g) => (
    <GroupStyle key={g.id} group={g} scopeId={scopeId} appScope={appId} />
  ));
  const firstTransform = colorTransforms[0];
  return (
    <ThemeScopeProvider scopeId={scopeId}>
      {firstTransform ? <WithAdjustment contrib={firstTransform}>{styles}</WithAdjustment> : styles}
    </ThemeScopeProvider>
  );
}
```

Reuses the same preset resolution, merge, `transformValues` adjustment, and `assertComplete`
backstop as the global path (all already inside `GroupStyle` / `WithAdjustment`). No
`CssReportContext` provider → `report` is the default no-op, and `appScope` gates it off anyway.

Mount one per **distinct** mounted app id (dedupe so two windows of the same app share one
`<style>`) in `AppWindowsBody`
(`plugins/apps/plugins/surface-arrangement/plugins/desktop/web/components/app-windows-body.tsx`):

```tsx
const appIds = useMemo(() => [...new Set(tabs.map((t) => t.appId))], [tabs]);
// …inside the backdrop div:
{appIds.map((id) => <ScopedAppTheme key={id} appId={id} />)}
```

This makes desktop the **only** consumer of scoped theming — `apps/.../desktop` already imports
from `@plugins/apps/web`; it adds an import of `ScopedAppTheme` from
`@plugins/ui/plugins/theme-engine/web`. (Verify this edge is DAG-legal; desktop is a leaf UI
arrangement, theme-engine is upstream — fine. Run `./equin check plugin-boundaries`.)

### 4. Tag each window subtree — `…/desktop/web/components/window-frame.tsx`

Add `data-theme-scope={`app:${tab.appId}`}` to the window root `<div>` (the
`className="absolute flex flex-col …"` element, window-frame.tsx:84). That single attribute is
what the scoped block targets; everything rendered inside the window (its `TabSurface`) inherits
the override. Portaled descendants escape to `document.body` and intentionally keep the global
theme (the focused-window chrome theme).

## Out of scope / Follow-ups

- **File a task** (the user asked): *per-window portal theming* — popovers/dialogs/dropdowns
  opened **inside** a window portal to `document.body` and therefore show the chrome (focused-app)
  theme, not the originating window's theme. Investigate whether to thread a per-window portal
  `container` into the Base UI primitives (`plugins/primitives/plugins/ui-kit/web/components/ui/*`,
  + `shell/toaster`) via a context-provided default container, or rethink the portal strategy
  entirely. (To be filed via `add_task` once out of plan mode.)
- **Per-window light/dark** (deferred): would require removing the global `<html>.dark`,
  per-subtree dark classes, and almost certainly the per-window portal container above.

## Verification

1. `./equin build`, then open `http://<worktree>.localhost:9000`.
2. Switch the surface arrangement to **Desktop** (theme-engine variant group "Surface arrangement").
3. Open two windows of **different** apps (e.g. Studio + Conversations). In the theme customizer,
   set distinct presets for each app (`app:<id>` scope, selected via the active app). Confirm each
   window renders its own palette **side by side**.
4. Open two windows of the **same** app; change that app's preset in one → both windows update
   together (shared `app:<id>` config, reactive via `useConfig`). Confirm one `<style id="theme-scope-…">`
   exists for that app, not two.
5. Toggle global light/dark → **all** windows switch mode together, each keeping its own palette
   (verifies `.dark [data-theme-scope]` reuse).
6. Open a popover/dropdown inside a window → it shows the **chrome/focused** theme (documented
   limitation, not a bug).
7. Switch back to **Tabs** arrangement → behavior pixel-identical to today (global path untouched;
   no `theme-scope-` styles present). Confirm the pre-paint warm-reload still has no flash.
8. `./equin check` (esp. `plugin-boundaries` and `type-check`).

## Critical files

- `plugins/ui/plugins/theme-engine/web/internal/serialize-vars.ts` — selector param.
- `plugins/ui/plugins/theme-engine/web/components/theme-injector.tsx` — `GroupStyle` `appScope`,
  new `ScopedAppTheme` (+ export from `…/theme-engine/web/index.ts`).
- `plugins/apps/plugins/surface-arrangement/plugins/desktop/web/components/app-windows-body.tsx`
  — mount one `ScopedAppTheme` per distinct app.
- `plugins/apps/plugins/surface-arrangement/plugins/desktop/web/components/window-frame.tsx`
  — `data-theme-scope` on the window root.
