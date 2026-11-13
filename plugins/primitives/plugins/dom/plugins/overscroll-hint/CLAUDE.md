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
pinch-zoom (`ctrlKey`) are ignored. So is a touch the page claimed with
`touch-action` — a dial, a slider, a seek bar, a canvas (`none`, or `pan-y` for
a sideways drag): the browser never pans for it and nothing cancels its
`touchmove` (pointer events do the work), so without this check every drag on
such a control read as a wasted scroll and bounced the panel around it (the
media player's speed dial shook its whole settings sheet on a phone). The
effective `touch-action` is the intersection up the ancestor chain
(`web/internal/touch-action.ts`); a drag control needs nothing beyond the
`touch-action` it already declares.

### The touch-claim guard

That declaration is now the contract every drag lives by, so it is enforced
(`web/internal/touch-claim-guard.ts`, installed by the same controller). A
lint rule cannot: the capture call and the `touch-action` routinely sit in
different files (a CSS file, a drag hook handed someone else's element). At
runtime it is one question — the guard wraps `Element.prototype.setPointerCapture`
and, for a touch pointer, reads the effective `touch-action` from where the
touch began. If it still lets the browser pan **both** ways, the drag is broken
on a phone (the browser takes it: `pointercancel`, the page scrolls or bounces)
and an `UnclaimedTouchDragError` naming the element is raised with
`reportError` — an uncaught error, so it is filed as a report, without
throwing into the drag's own handler. A one-axis claim (`pan-y` on a sideways
dial) is a claim.

It wraps the call rather than listening for `gotpointercapture` because the
browser captures every touch pointer implicitly too — that event fires on
every tap and cannot tell a drag from one (the e2e pins this).

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
  leaves the page short of its end. An invisible 1px anchor whose far edge sits
  exactly on the current end holds it — placed, because the end is often past
  the last child's box (a pane's `h-full` content box overflows). It is
  **absolutely positioned inside a moved layer** (cancelling the layer's offset
  each frame), never an in-flow box of the surface: out of flow it moves no
  sibling in any layout and can only grow the overflow, so placing it never
  clamps the scroll offset (an in-flow one re-centred a centred flex row — a
  markdown table's bleed scroller — and yanked it ~100px back on every push at
  its end). If the anchor cannot reach
  the end without adding extent, the bounce is skipped rather than scroll the
  page.

`e2e/overscroll-hint-verify.ts` checks all three on synthetic surfaces, once a
probe gesture has shown the hint is installed (its `Core.Root` controller can
mount after boot resolves).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Wasted-scroll hint: a single invisible global controller (mounted via Core.Root) that plays a small native-feeling rubber-band bounce on a surface when a wheel/trackpad/touch gesture scrolls nothing (not scrollable, or already at the edge). Gestures are batched per frame and a batch is wasted when no scroller on its chain scrolled or has room left; a two-stage physics (a saturating pull, drawn through a critically damped spring) turns bursty trackpad input into one smooth out-and-back. A touch the page claimed with touch-action (a dial, a slider) is never a wasted scroll; and the touch-claim guard enforces the claim — a setPointerCapture on a touch whose touch-action still lets the browser pan both ways is reported (UnclaimedTouchDragError), since the browser would take that drag.
- Web:
  - Contributes: `Core.Root` → `OverscrollHintController`
  - Uses: `primitives/css/viewport-overlay.describeElement`

<!-- AUTOGENERATED:END -->
