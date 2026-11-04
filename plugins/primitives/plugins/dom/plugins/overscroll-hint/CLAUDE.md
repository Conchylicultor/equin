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

A single window-level listener set covers every scroll viewport in the app
(PaneChrome's `overflow-y-auto`, panes that own their own `overflow-auto`,
Miller's horizontal strip, …) with zero per-pane wiring.

Gestures are **batched per frame**: every `wheel` / `touchmove` delta since the
last frame is summed (a trackpad sends events at its own rate, unrelated to the
display's). On the frame, the batch is wasted when no scroller on the gesture's
chain fired a `scroll` event during it AND none of them has room left in the
gesture's direction — the first test alone is racy (under a fast flick the
scroll event can land a frame late). A scroll event from a scroller off the
chain (a streaming log in another pane) says nothing about this gesture and is
ignored. Style and geometry are read once per frame, never on the wheel path.

Gestures consumed on purpose (`defaultPrevented` — the window bubble listener
runs after everyone else's, so it is final; e.g. graph zoom / canvas pan) and
pinch-zoom (`ctrlKey`) are ignored.

The surface that bounces is the nearest scroller on the chain that really
scrolls on the axis (`scrollHeight > clientHeight` — the one the gesture ran out
of), else the nearest whose overflow would scroll (its content fits), else the
nearest `[data-pane-id]` → `<main>` → scrolling root. Range first, because
overflow alone over-matches: a code block scrolling sideways computes
`overflow-y: auto` too, and bouncing it would move only the code in its box.

## The rubber-band physics

`web/internal/rubber-band.ts`, pure and unit-tested. Two stages, so bursty
input never shows as a shake:

- **Pull** — where the band wants to be. Each wasted delta stretches it through
  a saturating curve (slope 0.5 at rest, asymptote 48px), and it relaxes
  exponentially (τ 70ms) while no finger is down.
- **Offset** — what is drawn. A critically damped spring (ω 45 rad/s) follows
  the pull, stepped analytically so the motion is the same at any frame rate.

Pushes are instant and relaxing is continuous, so the pull alone is a
sawtooth: out on a frame with a wheel event, back on one without (a trackpad
sends ~60 events/s, a ProMotion display draws 120 frames). Drawing it directly
— what this plugin did until 2026-11 — shook the content ~2px back and forth
every frame. The spring filters that ripple out, so the content goes out and
back once.

One call per frame, `frame(dt, delta, holding)`, so the order cannot be got
wrong: the frame's input arrived during it, so it lands mid-frame — half the
relax before it, half after. Relaxing it over the whole frame dropped the band
on every long frame (a shake on a loaded machine); relaxing none made the pull
depend on the frame rate. A trackpad's momentum tail keeps pushing with
shrinking deltas; the relax wins as they shrink, so the band recedes while
momentum is still arriving. While a finger is down (touch) the pull holds, then
springs back on release.

Smoothness is checked deterministically by `rubber-band.test.ts` (60 / 120 /
144 Hz and an irregular 17–83 ms cadence), not by the e2e: a headless browser on
a loaded machine delivers input and frames up to hundreds of ms apart, so a
frame-by-frame trace there measures the machine.

`prefers-reduced-motion: reduce` disables the effect (checked per batch). All
motion is inline styles set by the detector — the plugin ships no CSS.

## A transform only looks like a scroll

Moving content is not scrolling. Three things a real scroll gets right are
kept right by `web/internal/bounce-surface.ts`, all settled once when a bounce
locks onto a surface. The content layers (the surface's element children) move,
never the surface box: moving the box would drag its clip over adjacent chrome.

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

`e2e/overscroll-hint-verify.ts` checks all three on synthetic surfaces, once a
probe gesture has shown the hint is installed (its `Core.Root` controller can
mount after boot resolves).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Wasted-scroll hint: a single invisible global controller (mounted via Core.Root) that plays a small native-feeling rubber-band bounce on a surface when a wheel/trackpad/touch gesture scrolls nothing (not scrollable, or already at the edge). Gestures are batched per frame and a batch is wasted when no scroller on its chain scrolled or has room left; a two-stage physics (a saturating pull, drawn through a critically damped spring) turns bursty trackpad input into one smooth out-and-back.
- Web:
  - Contributes: `Core.Root` → `OverscrollHintController`

<!-- AUTOGENERATED:END -->
