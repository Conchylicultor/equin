# Full screen in the demo's desktop windows

Track: *apps running in the browser* (`block-d04c6c0d-…`). Previous step:
`research/2026-11-04-global-desktop-mode-in-browser-demo.md`. Task: task-1793851499.

## Context

In the real app's desktop, a window's titlebar has pin, minimise, maximise, **Full screen** and
close. In `/demo`'s desktop (an `AppEmbed`), Full screen is missing.

**Why (verified).** It was a deliberate cut in desktop-in-demo, not a missing plugin or a host
gate. `SurfaceBody.useAvailablePlacements` (`apps-core/surface`) drops every
`frame: "viewport"` placement (solo) for a *contained* tab set (`TabsApi.contained`). Its reason
was "a box has no viewport to escape to". So the embed's placement registry never lists `solo`,
and `floating-placement.tsx` computes `canGoSolo = placements.ids.has("solo")` and leaves
`onFullscreen` undefined. The titlebar and the window system menu then draw no Full screen
entry. The control was absent and nothing said so.

The reason does not hold. A contained tab set *has* a viewport: its box. Solo means "the focused
tab fills the tab set's viewport". For the page's set that is the window, and for an embed it is
the embed box. The embed's `transform-gpu` already makes that box the containing block.

## Design

### 1. A viewport frame resolves to the tab set's own viewport (`apps-core/surface`)

- Delete the contained filter: every placement is a mode of every tab set.
- The frame role is resolved per tab set. `viewport` on a contained set renders as `pane`, i.e.
  `absolute inset-0` inside the backdrop, which fills the embed. The backdrop keeps
  `transform-gpu`, and the viewport-escape audit is off, because nothing escapes. On the page's
  set, nothing changes.
- **Boot mode unchanged.** An embed still opens docked. Solo is the page's `default`, but for a
  contained set the default is the first default placement that does not ask for the viewport.
  An embed opens as a box on someone else's page, and filling it is the user's gesture. This keeps
  `AppEmbed` (the demo and the website's lumen exhibit) exactly as it opens today.

### 2. The way out acts on the tab set the user is in (`apps-core/tabs`, `surface`, `solo`)

In the real app, solo is left by **Esc** (the `surface.exit-solo` shortcut) or by the action
bar's **Layout** control. Both read the page-global mode, so in the embed both would act on the
page.

- `TabSetHandle` gains `setMode(mode)` and `exitToPreviousMode()`. The registry of tab sets
  becomes subscribable: a provider notifies when its mode changes.
- `useFocusedTabSet()` gives a reactive `{ id, mode, setMode }` for the set the user is in
  (`peekFocusedTabSet()`'s answer, kept current).
- The solo Esc shortcut reads `peekFocusedTabSet()`: `when` checks that set's mode is solo, and
  the handler calls that set's `exitToPreviousMode`.
- `ActionBarPlacementControl` reads and drives `useFocusedTabSet()`. On the page there is only
  one set, so nothing changes.

### 3. The class: chrome the embed silently omits

See *Audit* below. Each difference is either closed here or reported with its reason.

## Verification

- Unit: surface-body for a contained set lists solo, keeps docked as the boot mode, and renders
  solo as a box (no `fixed`). Tab-sets: the Esc handler exits the focused set only.
- `./equin build`. Screenshots of both titlebars (main `/desktop`, my `/demo`). Full screen in a
  demo window fills the embed. Esc returns to the desktop with the window layout intact. The
  Layout control in the page's action bar returns too.
- e2e: no-leak, app-switch, desktop-in-demo (new steps: the Full screen control, entering solo,
  Esc back to windows), prototypes-in-demo, sonata-in-demo, persistence.
- Real app `/desktop`: Full screen and Esc unchanged.

## Audit: what the real chrome shows that the embed does not

| Real app | In the embed | Status |
|---|---|---|
| A window's **Full screen** (titlebar + window menu) | Was silently absent (contained sets dropped solo) | **Closed here**: solo fills the embed box |
| Solo's exit: **Esc** and the action bar's **Layout** control | Both acted on the page's tab set only | **Closed here**: both act on the tab set the user is in |
| Tab bar, app rail, docked action bar (`Apps.TabBar`, `Apps.RailFraming`, `Apps.TabBarActions`) | Not mounted: an embed is one surface, no page frame | Explicit: `AppEmbed` renders `Apps.Surface` only; the desktop and solo own their chrome anyway (`ownsChrome`) |
| Floating action bar (`Core.Root`) | The host page's, outside the embed (`floating-bar-boundary` on the embed) | Explicit; its Layout control now follows the embed |
| Floating app launcher in solo (`Apps.Overlay`) | Not mounted | Reported, not closed: the demo's apps draw their own launcher, except Home's gallery, which lists the apps itself. A brandless app taken full screen in the embed would have no launcher. Esc gets back out. |
| Openverse wallpaper source | Excluded from `agent-manager-demo` | Explicit (no request leaves the browser) |
| Wallpaper from a link | Shown, says "not available" | Explicit (`needsMachine`) |
| Pinned shelf apps | Fewer | The composition's apps, by design |

## Outcome (2026-11-05)

Landed as designed.

- `SurfaceBody`'s `useAvailablePlacements` keeps every placement. For a contained set, it
  resolves `viewport` to `pane` and returns a `defaultId` chosen among the non-viewport
  placements. If there are none, it falls back to the full list.
- The tab-set registry is reactive. `registerTabSet` and `tabSetModeChanged` notify, and
  `useFocusedTabSet()` reads it. `TabSetHandle` gains `setMode` / `exitToPreviousMode`.
- **Decision (from the review).** The Layout control follows the tab set the user last
  pointed at. On `/demo`, after a click in the embed, it shows and drives the embed's mode. A
  click on the page's own surface gives it back. On the real app there is one tab set, so
  nothing changes.
- **Found along the way.** no-leak and app-switch each fail one check that predates this
  change: the page's Wish popover reads the demo's related task over the page socket, since
  b038c8c488 moved its relate read onto `useTaskCluster`. Filed as task-1793854527-do4cy8.
- **Verification:**
  - unit: apps-core surface, tabs and app-embed, 90/90 (with new contained-set and
    focused-tab-set tests);
  - e2e: desktop-in-demo 20/20 (new Full screen → fills the embed → Esc steps),
    prototypes-in-demo 27/27, sonata-in-demo 39/39, persistence 30/30, no-leak 37/38 and
    app-switch 26/27 (the pre-existing leak above);
  - real `/desktop` on the build: Full screen fills the viewport (`fixed`, 1400×900), and Esc
    returns to the window;
  - `/demo`: the Layout control switches the embed between Desktop and Fullscreen.
