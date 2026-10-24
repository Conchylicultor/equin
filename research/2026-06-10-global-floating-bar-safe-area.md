# Floating-bar safe-area gutter

## Context

The global floating action bar (`plugins/floating-bar`) mounts via `Core.Root` as a
`fixed top-2 right-3` overlay, **outside** the app layout tree, in every non-`hostsToolbar`
app. Its `FloatingAction` wrapper is pinned to the **collapsed ~32px icon footprint** and
must keep pointer events live to detect hover-to-expand — so the top-right corner is
genuinely blocked: while collapsed it silently intercepts clicks on whatever sits beneath
it, and while hover-expanded it covers a wide header strip. A pure pointer-events fix is
therefore impossible; space must be reserved.

Today each app rediscovers this trap and hand-patches a right gutter with a magic
`pr-14`: the Story Builder gallery and editor headers
(`plugins/apps/plugins/story/plugins/shell`), while Sonata's player header
(`plugins/apps/plugins/sonata/plugins/library/web/panes.tsx`) puts `ml-auto` transport
widgets in the colliding zone with **no** reservation (already buggy).

**Goal:** make the floating-bar plugin *own* the reserved corner and publish it as a
single value, so app headers route a right gutter through one sanctioned utility instead of
each hardcoding `pr-14`. The gutter must collapse to nothing when the bar is hidden (config
off, or a toolbar-hosting app). Mirrors the existing chrome-utility pattern
(`px-chrome`/`h-chrome-bar` reading runtime `--chrome-*` vars in `app.css`).

## Approach: owned safe-area gutter (band-limited to the header row)

Single source of truth: the floating-bar plugin publishes a global CSS var
`--floating-bar-safe-area` reflecting its live visibility. A new `pr-floating-bar` Tailwind
utility consumes it. `AppShellLayout`'s chrome toolbar adopts the utility (covers every
chrome app zero-touch); the three full-surface custom headers swap their ad-hoc `pr-14` for
it. Because the var is `0`/unset whenever the bar is hidden, the gutter auto-reclaims its
space — strictly better than today's always-on `pr-14`.

### 1. floating-bar owns + publishes the value

`plugins/floating-bar/shared/config.ts` — add the single source for the gutter width
(matches today's proven `pr-14`):

```ts
/** Right inset that clears the collapsed floating bar (size-8 icon at right-3). */
export const FLOATING_BAR_GUTTER = "3.5rem";
```

`plugins/floating-bar/web/components/floating-bar.tsx` — restructure so the component always
mounts and publishes the var via `useLayoutEffect` (set before paint → no reserve-then-jump
flash), rendering the bar UI only when visible. The var exists **iff** the bar is mounted:

```tsx
const SAFE_AREA_VAR = "--floating-bar-safe-area";
// ...
const visible = enabled && !activeApp?.hostsToolbar;
useLayoutEffect(() => {
  const root = document.documentElement;
  if (visible) root.style.setProperty(SAFE_AREA_VAR, FLOATING_BAR_GUTTER);
  else root.style.removeProperty(SAFE_AREA_VAR);
  return () => root.style.removeProperty(SAFE_AREA_VAR);
}, [visible]);
if (!visible) return null;
// ...existing <FloatingAction> unchanged
```

`document.documentElement` (`:root`) is the correct global owner — app headers live in a
separate subtree, and this matches how `--chrome-pad-x` is a global contract consumed by
`app.css` utilities. The var *name* is the CSS↔TS boundary contract (same unavoidable
duplication as `--chrome-pad-x`).

### 2. Sanctioned utility

`plugins/framework/plugins/web-core/web/theme/app.css` (alongside the chrome `@utility`
block, ~line 333) — add:

```css
/* Floating-bar safe area — right inset clearing the global floating action bar
 * (top-right overlay). Width is owned + published by the floating-bar plugin as
 * --floating-bar-safe-area; falls back to the chrome pad when the bar is hidden
 * (config off / toolbar-hosting app), so app headers never sit under the bar
 * without hand-reserving a pr-14. */
@utility pr-floating-bar { padding-right: var(--floating-bar-safe-area, var(--chrome-pad-x)); }
@utility pl-chrome { padding-left: var(--chrome-pad-x); }
```

`pr-floating-bar` yields `3.5rem` when the bar is visible (clears it, matching today's
`pr-14`) and `--chrome-pad-x` (0.75rem) when hidden (sane minimal padding, no edge-touch).
`pl-chrome` is added so the chrome toolbar can set left padding independently of the
floating-bar right gutter (avoids two utilities fighting over `padding-right`).

### 3. Auto-cover chrome apps

`plugins/primitives/plugins/app-shell/web/components/app-shell-layout.tsx` — the toolbar
`<header>` changes `px-chrome` → `pl-chrome pr-floating-bar`. Every `AppShellLayout`-based
app (debug, pages, studio, workflows, file-explorer, …) is then covered with zero per-app
code: any future `ml-auto`/right-aligned toolbar item clears the bar automatically.

### 4. Replace the ad-hoc gutters

- `plugins/apps/plugins/story/plugins/shell/web/components/story-gallery.tsx` —
  header `pl-6 pr-14` → `pl-6 pr-floating-bar`; delete the `pr-14` trap comment.
- `plugins/apps/plugins/story/plugins/shell/web/components/story-editor.tsx` —
  header `pl-4 pr-14` → `pl-4 pr-floating-bar`; delete the `pr-14` trap comment.
- `plugins/apps/plugins/sonata/plugins/library/web/panes.tsx` (~line 155) —
  header `px-6` → `pl-6 pr-floating-bar` (fixes the currently-unreserved `ml-auto`
  transport widgets at line 183).

## Why band-limited, not a full-height host inset

The bar is ~40px tall in the top-right corner; reserving a full-height right gutter on the
AppsLayout content container (the only fully-automatic alternative) would inset *all*
content — grids, editors, scrollbars — far below the bar where nothing collides. Routing the
gutter through the header row keeps content full-width below the header, matching the
geometry apps already target with header-only `pr-14`.

## Critical files

| File | Change |
|---|---|
| `plugins/floating-bar/shared/config.ts` | add `FLOATING_BAR_GUTTER` |
| `plugins/floating-bar/web/components/floating-bar.tsx` | publish `--floating-bar-safe-area` on visibility |
| `plugins/framework/plugins/web-core/web/theme/app.css` | add `pr-floating-bar` + `pl-chrome` utilities |
| `plugins/primitives/plugins/app-shell/web/components/app-shell-layout.tsx` | toolbar `px-chrome` → `pl-chrome pr-floating-bar` |
| `plugins/apps/plugins/story/plugins/shell/web/components/story-gallery.tsx` | `pr-14` → `pr-floating-bar` |
| `plugins/apps/plugins/story/plugins/shell/web/components/story-editor.tsx` | `pr-14` → `pr-floating-bar` |
| `plugins/apps/plugins/sonata/plugins/library/web/panes.tsx` | `px-6` → `pl-6 pr-floating-bar` |

## Verification

1. `./equin build` (from the worktree).
2. Story gallery — `bun e2e/screenshot.mjs --url http://<wt>.localhost:9000/story --click "New story" --out /tmp/story` and confirm the "New story" button is clickable (not under the bar) and the grid below still reaches the right edge.
3. Story editor — open a story; confirm the view switcher / split toggle in the header clear the bar and stay clickable.
4. Sonata — open a song (`/sonata/song/:id`); confirm the transport widgets clear the bar.
5. Hover the floating bar → it expands over the header strip (expected transient behavior); collapsed state no longer overlaps any control.
6. Disable the bar (`floatingBarConfig.enabled = false`) and reload an `AppShellLayout` app → header right padding collapses to the chrome pad (var unset), no dead gutter.
7. `./equin check` (eslint / boundaries clean).
