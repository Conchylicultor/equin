# Dedicated chrome theme scope

## Context

The desktop multi-window feature (`research/2026-06-14-global-per-window-theme-desktop.md`)
gave each window its own palette via `[data-theme-scope="app:<id>"]` overrides, but
**Decision 2** of that plan was *"Chrome = focused window's theme."* The global app chrome —
the sonner toaster, the desktop backdrop, and the tab bar (and, adjacent to it, the app
switcher rail) — has no theme of its own. It renders against the global `:root`, which
`ThemeInjector` rewrites to the **focused app's** theme on every focus change
(`useActiveApp()` → URL). So the chrome's palette shifts as the user switches windows: a
Studio (Ocean) window and a Conversations (Warm) window make the surrounding chrome flip
Ocean↔Warm depending on which is focused.

The page background itself is `body { @apply bg-background }` (`app.css:338`), reading
`:root --background` — so the inter-window backdrop area, the tab bar (`bg-background`), and
the app rail (`bg-background`) all paint the focused app's background.

**Goal:** the chrome gets its own **stable, dedicated** theme that does not track the focused
window.

**Decisions (locked with the user):**

1. **Theme source = the global / default theme.** The chrome renders the *unscoped* global
   theme config — the same one unforked apps fall back to. It is already user-configurable
   via Appearance settings; no new config_v2 scope and no customizer UI are added. The shell
   simply wears the user's base theme.
2. **Palette only; color mode stays shared.** The chrome's preset/palette/fonts/radius become
   stable (= the global theme). Light vs. dark continues to follow the global `<html>.dark`
   class (exactly as the per-window blocks do today). This fully fixes the "palette shifts on
   focus" complaint; light/dark only differs if apps carry divergent per-app modes (rare), and
   that residual is identical to the windows' own behavior. No flat-resolve, so there is **zero
   risk** of mismatch with Tailwind `dark:` utilities or prop-themed descendants.

This is a direct extension of the existing `ScopedAppTheme` pattern — a third theme layer with
a non-`app:` scope token, fed by the global (unscoped) config instead of an `app:<id>` config.

## Design

| Layer | Selector | Driven by | Serves |
|---|---|---|---|
| Global (unchanged) | `:root` / `.dark` | focused app (`useActiveApp`) | tabs-mode surface, body fallback, portals with no scope |
| App scope (existing) | `[data-theme-scope="app:<id>"]` / `.dark …` | each mounted app's `app:<id>` config | inline content inside each desktop window |
| **Chrome scope (new)** | `[data-theme-scope="chrome"]` / `.dark …` | **global (unscoped) config** | toaster, desktop backdrop, tab bar, app rail |

The chrome block emits the full token set (like the app blocks), so every token resolves from
the global theme within any `data-theme-scope="chrome"` subtree and falls through to `:root`
nowhere unintentionally. Specificity matches the app pattern exactly: the attribute selector
applies its vars directly to the chrome element and they inherit down; app windows nested in
the backdrop carry their own `data-theme-scope="app:<id>"` value and override locally.

## Implementation

### 0. Give the `data-theme-scope` token vocabulary one owner — `plugins/primitives/plugins/ui-kit/web/components/portal-theme-scope.tsx`

The scope-token contract currently has no home, so it is duplicated as a literal on both the
producer (`theme-injector.tsx` builds `` `app:${appScope}` ``) and the consumer
(`window-frame.tsx` stamps `` `app:${tab.appId}` ``). `ui-kit` already owns the `data-theme-scope`
attribute (this file defines `PortalThemeScopeProvider` / `usePortalThemeScope` and documents the
attribute's contract), so the token vocabulary belongs here too. Add + export from the ui-kit
barrel:

```ts
export const CHROME_THEME_SCOPE = "chrome";
export const appThemeScope = (appId: string) => `app:${appId}`;
export const themeScopeSelectors = (token: string) => ({
  light: `[data-theme-scope="${token}"]`,
  dark: `.dark [data-theme-scope="${token}"]`,
});
```

`ui-kit` is a foundational leaf (it does **not** import `theme-engine`), and `theme-engine`,
`apps`, `desktop`, and `shell/toaster` all already depend on `ui-kit` (or may add a DAG-safe edge
to it) — so every producer and consumer references one source and the literal duplication is
eliminated, including the pre-existing `app:<id>` duplication.

### 1. Generalize `GroupStyle`'s scope token — `plugins/ui/plugins/theme-engine/web/components/theme-injector.tsx`

`GroupStyle` currently couples the config-read scope and the CSS selector through one `appScope`
prop and hardcodes the `app:` prefix:

```ts
const id = appScope ? `theme-scope-${appScope}-${group.id}` : styleIdFor(group.id);
// …selectors…
appScope ? { light: `[data-theme-scope="app:${appScope}"]`, dark: `.dark [data-theme-scope="app:${appScope}"]` } : undefined
```

Decouple "which config to read" (`scopeId`, already a separate prop) from "which selector to
emit". Rename `appScope?: string` → **`scopeToken?: string`** — the full `data-theme-scope`
attribute value (e.g. `"app:home"` or `"chrome"`) — and build selectors via `themeScopeSelectors`:

```ts
const id = scopeToken ? `theme-scope-${scopeToken}-${group.id}` : styleIdFor(group.id);
// …selectors…
scopeToken ? themeScopeSelectors(scopeToken) : undefined
```

Gate the pre-paint `report(...)` calls on `!scopeToken` (unchanged behavior; only the name
changes). `serialize-vars.ts` already takes the selector pair — no change there.

### 2. Point `ScopedAppTheme` at the renamed prop (same file)

`ScopedAppTheme` passes `appScope={appId}` with `scopeId = \`app:${appId}\``. Change to
`scopeToken={appThemeScope(appId)}` (config read still `scopeId`). Byte-identical output — the
emitted selector/styleId are unchanged.

### 3. Add `ChromeTheme` (same file)

Mirror `ScopedAppTheme`, but read the **global** config (`scopeId: undefined`) and emit under
the `chrome` token (`CHROME_THEME_SCOPE` imported from ui-kit, step 0):

```ts
// CHROME_THEME_SCOPE imported from ui-kit (step 0)
export function ChromeTheme() {
  const groups = ThemeEngine.TokenGroup.useContributions();
  const colorTransforms = ThemeEngine.ColorTransform.useContributions();
  const styles = groups.map((g) => (
    <GroupStyle key={g.id} group={g} scopeId={undefined} scopeToken={CHROME_THEME_SCOPE} />
  ));
  const firstTransform = colorTransforms[0];
  return (
    <ThemeScopeProvider scopeId={undefined}>
      {firstTransform ? <WithAdjustment contrib={firstTransform}>{styles}</WithAdjustment> : <>{styles}</>}
    </ThemeScopeProvider>
  );
}
```

`scopeId: undefined` → `useConfig(group.configDescriptor)` reads the global theme; the color
adjustment resolves globally too. No `CssReportContext` provider (default no-op; `scopeToken`
gates reports off regardless). Always mounted (chrome exists in every arrangement).

### 4. Mount + export — `plugins/ui/plugins/theme-engine/web/index.ts`

- Add `Core.Root({ component: ChromeTheme })` to `contributions` (alongside `ThemeInjector`).
- Export `ChromeTheme` from the barrel (next to `ScopedAppTheme`). The scope token itself lives
  in ui-kit (step 0), not here.

### 5. Tag the chrome surfaces with `data-theme-scope`

Every consumer imports `CHROME_THEME_SCOPE` from `@plugins/primitives/plugins/ui-kit/web`
(no literals).

- **Tab bar** — `plugins/apps/web/components/app-tab-bar.tsx:59`. Add
  `data-theme-scope={CHROME_THEME_SCOPE}` to the root `<div className="… bg-background …">`; its
  `bg-background` now resolves to the chrome theme. Also wrap the bar's content in
  `<PortalThemeScopeProvider scope={CHROME_THEME_SCOPE}>` (both from ui-kit, already imported in
  `apps`) so any portaled dropdown opened from the bar adopts the chrome theme.

- **App rail** — `plugins/apps/web/components/app-rail.tsx:15`. Add
  `data-theme-scope={CHROME_THEME_SCOPE}` to the rail root. The rail is the global app-switcher
  chrome adjacent to the tab bar; leaving it on `:root` while the tab bar is stable would look
  inconsistent. (Note: the per-app *toolbar* in `app-shell-layout.tsx` is **not** touched — it is
  in-app chrome and should keep the app's theme.)

- **Desktop backdrop** — `…/surface-arrangement/plugins/desktop/web/components/app-windows-body.tsx:44`.
  Add `data-theme-scope={CHROME_THEME_SCOPE}` to the backdrop `<div>` **and** give it an
  explicit `bg-background` so the inter-window area paints the chrome background instead of
  showing the transparent passthrough to `body`'s focused-app `bg-background`. The nested
  `WindowFrame`s keep their own `app:<id>` value (via `appThemeScope`) and override locally —
  unaffected.

- **Toaster** — `plugins/shell/plugins/toaster/web/components/toaster-root.tsx`. Wrap `<Sonner>`
  in `<div data-theme-scope={CHROME_THEME_SCOPE}>`. Sonner renders its toast list **inline** (fixed-position
  `<ol data-sonner-toaster>`, no React portal), so the `style` prop's `var(--popover)` /
  `var(--border)` / `var(--radius)` resolve against the chrome scope from the wrapper. **Verify
  inline rendering at build time** (DOM-inspect the toast list); if a sonner version portals to
  `body`, fall back to passing the chrome-resolved values another way. Keep `theme={useColorMode()}`
  unchanged — under palette-only, chrome's light/dark follows the same global `<html>.dark` the
  toaster's `theme` prop already mirrors.

## Boundaries

- The scope-token vocabulary (`CHROME_THEME_SCOPE`, `appThemeScope`, `themeScopeSelectors`) lives
  in `ui-kit`, a foundational leaf that does **not** import `theme-engine`. Every producer and
  consumer (`theme-engine`, `apps`, `desktop`, `shell/toaster`) already depends on `ui-kit` or
  adds a DAG-safe edge to it (`theme-engine → ui-kit` is new but cycle-free). No literals, no new
  edge into `apps`.
- Run `./equin check plugin-boundaries` and `type-check`.

## Verification

1. `./equin build`, open `http://att-1781451327-clgw.localhost:9000`.
2. Switch to **Desktop** arrangement. Open two windows of different apps and set distinct
   presets per app (e.g. Studio = Ocean, Conversations = Warm).
3. Focus the Studio window, then the Conversations window. **Confirm the tab bar, app rail, and
   desktop backdrop keep one stable palette (the global theme) across both** — they no longer
   flip Ocean↔Warm. Each window still shows its own palette.
4. Trigger a toast (e.g. from a build) while each window is focused → the toast keeps the chrome
   palette regardless of which window is focused. Inspect the DOM to confirm the `<ol
   data-sonner-toaster>` is inside the `data-theme-scope="chrome"` wrapper (inline render).
5. Change the **global** theme preset in Appearance (no app fork active) → chrome updates;
   per-app windows keep their forked palettes.
6. Toggle global light/dark → chrome and windows switch mode together (palette-only behavior).
7. Switch to **Tabs** arrangement → behavior unchanged; the single surface still uses `:root`
   (focused-app theme), the tab bar/rail now show the stable chrome theme. Confirm warm-reload
   has no flash (global pre-paint cache untouched).
8. `./equin check`.

Use `e2e/screenshot.mjs` for the focus-switch before/after captures in step 3.

## Critical files

- `plugins/primitives/plugins/ui-kit/web/components/portal-theme-scope.tsx` — add + export
  `CHROME_THEME_SCOPE`, `appThemeScope`, `themeScopeSelectors` (one owner of the token vocabulary).
- `plugins/ui/plugins/theme-engine/web/components/theme-injector.tsx` — rename `appScope`→`scopeToken`
  (build selectors via `themeScopeSelectors`), point `ScopedAppTheme` at `appThemeScope`, add `ChromeTheme`.
- `plugins/ui/plugins/theme-engine/web/index.ts` — mount `ChromeTheme` as `Core.Root`; export it.
- `plugins/apps/web/components/app-tab-bar.tsx` — `data-theme-scope={CHROME_THEME_SCOPE}` + `PortalThemeScopeProvider`.
- `plugins/apps/web/components/app-rail.tsx` — `data-theme-scope={CHROME_THEME_SCOPE}`.
- `plugins/apps/plugins/surface-arrangement/plugins/desktop/web/components/app-windows-body.tsx`
  — `data-theme-scope` + `bg-background` on the backdrop.
- `plugins/shell/plugins/toaster/web/components/toaster-root.tsx` — wrap `<Sonner>` in the chrome scope.

## Out of scope

- A separately-configurable chrome scope (distinct from the global theme) — deferred per the
  locked decision; the global theme is the chrome's source.
- Per-chrome (or per-window) independent light/dark — color mode stays global, matching the
  existing per-window design.
- The floating action bar (`shell/floating-bar`) — it mirrors the active app's toolbar actions,
  so it intentionally keeps the active-app theme.
