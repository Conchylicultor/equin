# Floating action bar: nameless surface-mode radios, `?` click blocked mid-open

## Context

Found while e2e-testing the onboarding tour (`plugins/hints/e2e/first-launch.ts`):

1. **The Layout row's surface-mode radios have no accessible name.**
   `ActionBarPlacementControl` (`apps-core/surface/web/components/placement-control.tsx`) maps each
   `Surface.Placement` to `{ label: "", icon, title: d.label }`. `SegmentedOption` has no `title`
   field, and tsc doesn't flag it: the object is built in a `.map` callback, so the excess-property
   check never runs. The name is dropped silently. Even with `tooltip` it would still be nameless:
   `ToggleChip` → `Badge` draws a tooltip but never derives `aria-label` from it (unlike `Button`,
   whose icon-only form takes a string tooltip as its name). So `solo-safe-area.ts`
   (`getByRole("radio", { name: "Fullscreen (solo)" })`) fails, and `first-launch.ts` picks modes
   by position.

2. **Clicking `?` in the floating (solo) bar is sometimes blocked.** I reproduced it on main by
   logging `elementFromPoint` at `?`'s centre every frame while hovering the bar open:

   | t (ms) | `?` centre x | open | hit at `?` centre |
   |---|---|---|---|
   | 0–574 | 1425 | no (inert) | nothing (`?` is clipped) |
   | 574–653 | **1425, not moving** | **yes, `data-open`, not inert** | nothing (`?` is clipped) |
   | 662–695 | 1405 → 1249 | yes | `?`, then a neighbour's `border-l` separator, then `?` |
   | 703+ | 1225 (at rest) | yes | `?` |

   When the bar opens, `data-open` is set and `inert` is lifted at once. But for about 80 ms the
   reveal strip has not started its `max-width` morph, so `?` still sits at its collapsed spot,
   laid out but clipped. It then slides about 200 px over the next 130 ms. Playwright's checks
   (attached → visible → stable for two frames) all pass during that still window, so it clicks
   where `?` is drawn but not visible, and another element gets the hit. Its retry moves the mouse
   there again; that spot is outside the bar's box, so the bar closes and the click never lands.
   By hand, a quick click during the slide lands on whatever is passing under the pointer.
   The hint overlays (Halo, Spotlight) are `pointer-events-none`, so they are not involved.

   The flaw is in `FloatingAction`: its content becomes live (not `inert`, `data-open`) as soon as
   the open *intent* exists, not once the content is *at rest*.

## Approach

### 1. Icon-only segmented options must carry a name (type-level)

`plugins/primitives/plugins/css/plugins/toggle-chip/web/internal/toggle-chip.tsx`:

- Make `SegmentedOption<T>` a union, following `Button`'s icon-only rule:
  ```ts
  type SegmentedOption<T> = { id: T } & (
    | { label: ReactNode; icon?: ReactNode; tooltip?: ReactNode }   // labelled
    | { label?: never; icon: ReactNode; tooltip: string }           // icon-only: tooltip IS the name
  );
  ```
- `SegmentedControl` passes `aria-label={typeof opt.tooltip === "string" && !opt.label ? opt.tooltip : undefined}`
  to each chip (ToggleChip already forwards `...rest` to Badge → the element). Render no label
  child when `label` is absent (ToggleChip `children` becomes optional, or pass `null`).
- `label: ""` still satisfies the labelled arm, so add a loud runtime assert (rung 4): an option
  whose label is `""`/`null` must use the icon-only arm.
- `placement-control.tsx`: `{ id, icon, tooltip: d.label }`, with no `label` and no `title`.
- Run `tsc` and fix any other icon-only `SegmentedControl` call site the union now rejects (37
  importers; any that pass `label: ""` today are nameless too).

### 2. `FloatingAction` content is live only once it is at rest

`plugins/primitives/plugins/overlay/plugins/floating-action/web/internal/floating-action.tsx`:

- Add a third state, `revealed`: `open` and the panel's open morph has finished. It is derived
  without timers: after `open` turns true (in a layout effect), wait for
  `Promise.all(panel.getAnimations().map(a => a.finished))`. That resolves at once when nothing
  animates (reduced motion, no size change). It rejects with `AbortError` when the close cancels
  the transition; that case alone is handled by staying unrevealed. Any other error is rethrown.
  Closing clears `revealed` immediately.
- The panel is `inert={!revealed}`, and the wrapper carries `data-revealed` beside `data-open`.
  `data-open` keeps driving the morph and the fade (the visuals are unchanged). Only reachability
  waits until the content is at rest.
- jsdom has no `Element.getAnimations`: the existing `floating-action/web/__tests__` stub it, with
  no fallback in product code.

Consumers do not change: the global action bar keeps passing children as before.

### 3. E2E scripts use the real names and the real reveal

- `plugins/hints/e2e/first-launch.ts`:
  - `pickSurfaceMode` selects the radio by its placement label instead of by position, and the
    doc comment about missing names goes.
  - `openHelpMenu` waits for `[data-revealed]` (has `?`), not `[data-open]`.
- `plugins/shell/plugins/global-action-bar/e2e/solo-safe-area.ts`: its name-based radio
  selector now resolves. Implementation found three other stale assumptions, now fixed:
  - it assumed a docked boot (solo is the boot mode), so it now docks first through the
    revealed floating bar;
  - "View options" also names a DataView toolbar button, so the gear is now located by its
    component (`ViewOptionsButton`);
  - it hit-tested the first `.floating-bar-band`, which is no longer the bar, so it now picks
    the band holding the health dot;
  - it defaults to `/agents`, since Home has no header to centre on.
  `openFloatingActionBar` (e2e/support) now waits for `data-revealed`.

## Tests

- `toggle-chip/web/__tests__/`: an icon-only `SegmentedControl` option's radio is named by its
  tooltip (`getByRole("radio", { name })`), and an empty-label option without a tooltip throws.
- `floating-action/web/__tests__/`: content stays `inert` and the wrapper has no `data-revealed`
  while the stubbed animation is pending; both flip once it finishes; closing mid-morph (the
  promise rejects with `AbortError`) never reveals.

## Verification

1. `./singularity test plugins/primitives/plugins/css/plugins/toggle-chip plugins/primitives/plugins/overlay/plugins/floating-action`
2. `./singularity build` (runs checks and type-check).
3. Re-run the per-frame hit-test log above against my build: `?` must be inert/unrevealed for
   every frame where it isn't at rest.
4. `./singularity run plugins/shell/plugins/global-action-bar/e2e/solo-safe-area.ts` and
   `./singularity run plugins/hints/e2e/first-launch.ts`, with the first-launch one run several
   times in a row (the failure was intermittent).
5. `browser_find "radio"` in the View options popover shows "Docked …" / "Fullscreen (solo)" names.
