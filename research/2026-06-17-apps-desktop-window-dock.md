# Desktop-mode window dock (taskbar for floating windows)

## Context

In floating "desktop mode" (`plugins/apps/plugins/surface/plugins/floating/`), minimizing a
window (`MdRemove` titlebar button → `geo.minimized = true`) only hides the window's *content
inset* (`display:none`). The container box (border + `bg-background` + shadow) and the floating
titlebar stay painted full-size on the desktop — an empty bordered box with a titlebar floating
mid-screen. The titlebar is the *only* restore affordance: there is no taskbar/dock, no list of
open windows, no window switcher. This breaks the desktop metaphor and makes "minimize"
incoherent (it doesn't reclaim space; it just blanks the body).

Goal: a real desktop **dock / taskbar** — a persistent bottom strip listing every floating
window, with click-to-focus, click-to-restore (un-minimize), an active-window highlight, and a
minimized indicator. Minimize should fully clear the window from the desktop (no lingering box),
leaving the dock as the restore target.

## Design

A macOS-style **dock**: a centered, translucent (`backdrop-blur`), rounded floating bar pinned to
the bottom of the desktop, shown whenever ≥1 tab is floating (i.e. exactly "desktop mode"). One
chip per floating window: app icon + truncated title. Active window highlighted; minimized
windows dimmed with a status dot. Click behavior (taskbar convention):

- minimized or unfocused window → restore (un-minimize) + raise to front + focus
- the already-focused, non-minimized window → minimize (toggle back to the dock)

### 1. Generic `Foreground` placement slot (surface API)

The dock must sit *above* windows; the existing `Backdrop` renders *below* them. Add a symmetric,
generic `Foreground` to the placement descriptor — rendered once, above all tab containers,
whenever ≥1 open tab resolves to that placement. Keeps the surface body generic (names no
placement); floating contributes the dock as its `Foreground`.

- `plugins/apps/plugins/surface/web/slots.ts` — add to `PlacementDef`:
  ```ts
  /** Rendered once, ABOVE all tab containers, whenever >= 1 tab uses this
   *  placement. Symmetric with Backdrop (which renders below). Receives the open
   *  tabIds in this placement so it stays decoupled from placement-resolution. */
  Foreground?: ComponentType<{ tabIds: string[] }>;
  ```
- `plugins/apps/plugins/surface/web/components/surface-body.tsx` — after the `tabs.map(...)`
  containers, render each placement's `Foreground` (mirror the `backdrops` derivation), passing
  the tabIds whose `resolveId(t.placement) === d.id`. Foregrounds render last in DOM and rely on
  their own z-layer to sit above windows.

### 2. Window dock component (floating plugin)

New `plugins/apps/plugins/surface/plugins/floating/web/components/window-dock.tsx`:

- Props: `{ tabIds: string[] }`. Reads `useTabs()` for `titles`, `focusedTabId`, `focusTab`;
  reads geometry via the new `useWindowGeometryMap()`; resolves app icons via
  `Apps.App.useContributions()`.
- Renders nothing when `tabIds` is empty (defensive; host already gates on ≥1).
- Layout: absolutely positioned, `bottom`-centered, `z-overlay` (above the window band — see §4),
  `pointer-events-auto`. Rounded translucent bar (`backdrop-blur`, border, shadow-lg) mirroring
  the token-utility style already used in `window-chrome.tsx` (`gap-xs`, `px-sm`, `rounded-lg`,
  `border`, `bg-muted/…`). One chip per tabId (app icon + truncated `Text variant="label"`):
  - focused & not minimized → highlighted (e.g. `bg-muted`, subtle ring)
  - minimized → dimmed (`opacity-…`) + a `StatusDot`/small dot indicator
  - hover → subtle bg
- Click: `const g = map.get(id); if (focused && !g.minimized) restoreWindow(id, /*minimize*/true)`
  else `restoreWindow(id) + bringWindowToFront(id) + focusTab(id)`. (Implement as a small helper
  that sets minimized and raises; see store API below.)

### 3. Minimize fully clears the window

`plugins/apps/plugins/surface/plugins/floating/web/floating-placement.tsx` — in `FloatingChrome`'s
`useLayoutEffect`, when `geo.minimized`, push `display:"none"` onto the **container** style (not
just the inset), so the whole window (box + titlebar) leaves the desktop and only the dock chip
remains. Keep the tab mounted (`display:none` preserves keep-alive). Non-minimized stays as today
(box + `WINDOW_TITLEBAR_INSET` inset).

### 4. Bounded window z-order + dock z (geometry store)

`plugins/apps/plugins/surface/plugins/floating/web/hooks/use-window-geometry.ts`:

- The dock uses `z-overlay` (40). Window z is a raw inline `geo.z` from a monotonic `++nextZ`,
  which grows unboundedly across a session and would eventually exceed 40 and cover the dock.
  Fix at the source: **renormalize** z to compact ranks (`1..N`, N = open window count) whenever
  `nextZ` would exceed a ceiling (`Z_CEILING = 30`). Committed window z then stays ≤ 30 < 40, so
  the dock is always above the windows. This also removes the latent unbounded-counter growth.
- Add reactive whole-map read `useWindowGeometryMap(): Map<string, Geometry>` (subscribe to the
  existing `subscribers` set; return a snapshot map — memoize a stable snapshot so
  `useSyncExternalStore` doesn't loop; rebuild the snapshot only inside `notify()`/mutations).
- Extract module-level `bringWindowToFront(tabId)` (today inlined in the hook) and add
  `restoreWindow(tabId, minimize = false)` (sets `minimized`); have `useWindowGeometry` delegate
  to these so there is one implementation. Export the three for the dock.

### 5. Barrel / wiring

- Floating `floatingDef` gains `Foreground: WindowDock`.
- No new cross-plugin barrels: the dock imports `useTabs`/`Apps` from `@plugins/apps/web` and the
  store helpers from its sibling hook file (intra-plugin). Surface `slots.ts` change is additive.

## Files

- `plugins/apps/plugins/surface/web/slots.ts` — add `Foreground` to `PlacementDef`.
- `plugins/apps/plugins/surface/web/components/surface-body.tsx` — render foregrounds.
- `plugins/apps/plugins/surface/plugins/floating/web/hooks/use-window-geometry.ts` — map read,
  `bringWindowToFront`, `restoreWindow`, z renormalization.
- `plugins/apps/plugins/surface/plugins/floating/web/components/window-dock.tsx` — new dock.
- `plugins/apps/plugins/surface/plugins/floating/web/floating-placement.tsx` — minimize hides
  container; add `Foreground`.

## Verification

1. `./equin build`.
2. Playwright on `http://<worktree>.localhost:9000`:
   - Float a tab (placement control → "Float as window"); open a 2nd window via `+`.
   - Confirm the dock appears bottom-center listing both windows; the focused one is highlighted.
   - Minimize a window → its box+titlebar vanish entirely; its dock chip shows the minimized
     (dimmed + dot) state. Click the chip → it restores, raises, and focuses.
   - Click the focused window's chip → it minimizes (toggle).
   - Drag windows over the dock → dock stays on top; switch all tabs back to docked → dock and
     wallpaper disappear.
