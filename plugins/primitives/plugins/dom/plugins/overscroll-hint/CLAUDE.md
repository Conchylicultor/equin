# overscroll-hint

A self-installing client primitive that gives the app a native-feeling
"there's nothing more to scroll here" signal. When the user makes a scroll
gesture (wheel / trackpad / touch) that is fully **wasted** — nothing actually
scrolls because the surface isn't scrollable or is already pinned at the edge in
that direction — the surface **rubber-bands**: it follows the gesture live,
translating proportionally to how hard you push (damped by ever-increasing
resistance so it asymptotes at ~48px instead of running away), then springs back
when the gesture stops. This is the iOS/macOS elastic-overscroll model — every
push against the wall produces movement, so repeated scroll attempts keep giving
feedback (there is no one-shot animation to "use up").

It self-installs globally via `Core.Root` — no per-consumer wiring. The
controller component renders `null`; all behavior lives in the framework-free
detector.

## Wasted-scroll detection

A single document-level listener set covers every scroll viewport in the app
(PaneChrome's `overflow-y-auto`, panes that own their own `overflow-auto`,
Miller's horizontal strip, …) with zero per-pane wiring.

The trick: record each `wheel` (or `touchmove`) gesture, then on the **next
animation frame** check whether ANY real `scroll` event fired in the meantime
(captured globally), and — because under a fast flick that event can land a frame
late — whether any scroller on the gesture's chain still has room in its
direction. Only when neither holds was the gesture wasted. The hot wheel path
stays cheap: the style and geometry reads run only on the rare no-scroll-event
frame.

Gestures that were intentionally consumed (`event.defaultPrevented`, e.g. graph
zoom / canvas pan) and pinch-zoom (`ctrlKey`) are ignored.

## The rubber-band (push + decay physics)

`pickScrollSurface` walks up from the gesture target to the first element whose
computed overflow on the gesture's dominant axis is `auto`/`scroll`/`overlay`
(falling back to nearest `[data-pane-id]` → `<main>` → scrolling root). The
transform is applied to that viewport's **content layers** (its direct element
children), never the viewport box itself: moving the box would drag its clip
boundary over an adjacent toolbar/footer and — since `transform` opens a stacking
context — paint the overscrolled content *above* that chrome. Moving the content
keeps the bounce inside the viewport's own `overflow` clip, the native model
(viewport stays put and clips; only content moves). A viewport with no element
children has nothing to bounce safely and is skipped. Its displacement is driven
by a small continuous physics loop, not a clip:

- **Push.** Each wasted scroll event adds `−delta · PUSH_FACTOR · (1 − |offset|/MAX_PULL)`
  to the signed `offset`. The `(1 − |offset|/MAX_PULL)` term is the resistance:
  contributions shrink to nothing as the offset nears `MAX_PULL` (~48px), so a
  hard flick reaches the limit in a few events and pushing further barely moves
  it (down/right → nudge content up/left, like native).
- **Decay.** A `requestAnimationFrame` loop multiplies `offset` by
  `exp(−dt / DECAY_TAU_MS)` (τ ~90ms → ~270ms back to rest) every frame, then
  writes `transform: translate(±offset px)`. When `|offset|` drops below
  `STOP_EPS` the loop stops and the inline styles are cleared.

Because decay runs every frame regardless of incoming events, a trackpad
**momentum tail recedes smoothly** as its deltas shrink — the surface is never
pinned waiting for momentum to end. A fresh flick simply re-pushes it, so
repeated dead-end scrolls always produce feedback. While a finger is down
(`touchstart`→`touchend`) the decay **pauses** so the surface tracks the touch
1:1, then springs back on release.

`prefers-reduced-motion: reduce` disables the effect entirely (checked per
gesture in JS). Everything is driven from inline `transform` in the
framework-free detector — the plugin ships no CSS.

## A transform only looks like a scroll

Moving content is not scrolling. Three things a real scroll gets right are
kept right by the detector, all settled once when a bounce locks onto a surface:

- **Pinned elements stay pinned.** A sticky element stuck to the surface's edge
  (pane header, table header, menu search bar) is chrome: it is held on the edge
  while the content moves under it — left out of the moved layers if it is
  one, otherwise put back each frame (via the `translate` property) to the
  position measured when the bounce locked on. A `display: contents` wrapper (a
  theme boundary around a floating pane header) draws no box, so it is looked
  through: its children are the layers. Only
  elements exactly on their pinned position count; a sticky still in flow (a
  group header below the fold) moves with its rows. Found via the `.sticky`
  class — the one spelling `position: sticky` has here (`Sticky` primitive,
  ui-kit menu headers; inline `position: sticky` is lint-banned) — confirmed
  against computed style.
- **Fixed elements stay fixed.** A layer in normal flow is moved by a relative
  inset (`position: relative; top`), not a `transform`: a transform makes every
  `position: fixed` descendant (a floating button, a side rail) resolve against
  the moved layer instead of the viewport, so it jumped away for the length of
  the bounce. Only a layer that is already positioned falls back to a transform.
- **The scroll position never moves.** Scrollable overflow counts a transformed
  box where it is drawn, so pushing content up at the end edge shortens the
  range and the browser clamps the offset back — the bounce cancels itself and
  leaves the page short of its end. An invisible anchor appended after the last
  child, sized to reach the current end, holds it — sized, because the end is
  often past the last child's box (a pane's `h-full` content box overflows). If
  it cannot reach the end without adding extent, the bounce is skipped rather
  than scroll the page.

`e2e/overscroll-hint-verify.ts` checks both on synthetic surfaces.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Wasted-scroll hint: a single invisible global controller (mounted via Core.Root) that plays a small native-feeling rubber-band bounce on a surface when a wheel/trackpad/touch gesture scrolls nothing (not scrollable, or already at the edge). Detects 'wasted' gestures by checking whether a real scroll event fired within one animation frame of the gesture.
- Web:
  - Contributes: `Core.Root` → `OverscrollHintController`

<!-- AUTOGENERATED:END -->
