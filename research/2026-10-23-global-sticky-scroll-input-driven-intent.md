# Sticky scroll: following stops only on evidence the reader acted

## Context

A following conversation transcript keeps "parking" (it stops chasing the bottom
and new cards arrive off screen), and each fix has been one more exception:

- `0ccabb5e62` — a card collapsing made the browser clamp the offset → `atEnd` exception.
- `eb2d27fa5b` — the paged window sliding made `KeepAnchorAcross` scroll the
  follower up by the released row → the bottom-pin.
- now — stand-ins, eased heights, rows fading in, thinking cards folding: the
  same bug, spelled differently.

The root cause is the intent rule in `useStickyScroll`
(`plugins/primitives/plugins/dom/plugins/auto-scroll/web/use-sticky-scroll.ts`):
**"a scroll I did not write is the reader leaving."** That is an inference by
elimination. The browser (clamping, anchoring), focus, and the plugin's own
compensations (`KeepAnchorAcross`, `KeepScrollAcross`) all write scroll offsets
the follower did not author. Every new layout effect that moves the offset is a
new way to park. The rule cannot be patched exception by exception.

The reader also asked that a scroll ending *a little above* the bottom, inside
the margin, keeps following. Today `movedUp` parks it.

**Goal:** make "a layout effect parked the follower" impossible to express.
Only positive evidence that the reader acted (an input event, or a navigation
through the repo's own scroll funnels) may stop following. Every other scroll
while following is re-pinned to the bottom. The public API of `useStickyScroll`
does not change, so all four consumers (transcript, agent thread, shell output,
live log) inherit the fix.

### Why the 2026-07-31 objection to gesture listeners no longer holds

`research/2026-07-31-global-sticky-scroll-follow-intent-and-restore.md` rejected
gesture listeners because they miss some scrolls. Here is how each one is
covered:

| Missed scroll | Covered by |
|---|---|
| scrollbar drag, middle-click autoscroll, native drag-select autoscroll | `pointerdown` inside the scroller (the scrollbar's target is the scroller itself) |
| `useEdgeAutoScroll`, `scrollChildIntoView`, `scrollToBottom`/`scrollToTop`, `revealElement` (StickyUserHeader expand, outline jumps) | these are the **only** sanctioned writers (`no-adhoc-scroll-write`, `no-adhoc-scroll-into-view`), so each funnel *announces a navigation* on the scrollers it moves |
| find-in-page | ⌘F / Ctrl+F keydown parks explicitly (the find bar's own keys never reach the page) |

So the input set is complete by construction: lint already forces every
programmatic scroll through funnels this plan instruments. The writers that
remain unannounced are compensations (KeepAnchorAcross, KeepScrollAcross, the
hook's own writes) plus browser-native moves (clamp, anchoring, `focus()`,
`#hash`). None of those is the reader asking to leave.

## Design

### Modes

```
following ──(reader scrolls, not into the bottom)──▶ driving ──settle──▶ following | anchored
anchored  ──(reader scrolls)──────────────────────▶ driving
any       ──jump / followKey──▶ following         any ──⌘F──▶ anchored
```

- **following**: the hook owns the offset (as today: `overflow-anchor: none`,
  bottom pin claimed, IO + motion-frame writes). **A scroll it did not write
  and that no armed intent explains → re-pin to the bottom** (`writeToBottom`).
  This replaces `nextMode`'s `movedUp`/`atEnd` inference and turns every past
  parking bug into a re-pin.
- **driving**: the reader is moving the surface. No follow writes. Anchoring is
  handed to the browser (`auto`, pin released), so reflow above them does not
  move them.
- **anchored**: parked, exactly as today.

### Intent: arming

An *intent* arms the scroller. A scroll event that lands while it is armed,
and that the hook did not write, is the reader's. Intents:

- `wheel`, `touchstart`/`touchmove`, `pointerdown` (any button) on the scroller;
- `keydown` of a scroll key (PageUp/PageDown/Home/End/arrows/Space) whose target
  is not editable, on the scroller or with focus on `body`;
- `announceNavigation(el)` from a funnel (below).

Arming alone moves nothing. A click on a card arms the scroller, and if no
scroll follows it disarms without effect, so streaming growth keeps being
followed through the click. The armed window ends on the **settle** timer: a
trailing debounce (~150 ms after the last input or scroll), held open while a
pointer is down. A trailing debounce over input events is not polling. It is
the same shape as the existing persist debounce.

### The reader's scroll, and settle

When the reader scrolls (armed, not ours):

- moving down and within `threshold` of the bottom → **following** at once
  (the jump button disappears as they arrive);
- otherwise → **driving**.

On settle in `driving`, decide from the distance **at the reader's last scroll
event** (`scrollHeight` recorded then, minus `scrollTop + clientHeight`).
Content that streamed in during the gesture is not the reader's displacement.
Within `threshold` → **following** (and write the bottom); else → **anchored**.
This is the new "stopped a bit above the bottom still sticks" behaviour.

### Navigation funnels announce

A per-scroller **navigation registry** (`web/announce-navigation.ts`, beside
the unchanged `internal/bottom-pin.ts`): each mounted `useStickyScroll`
registers its `arm` for its scroller (`listenForNavigation`). The public
`announceNavigation(target: Element)` from `auto-scroll/web` arms the owner of
`target` and of every ancestor scroller. It is cheap, because it only walks
ancestors.

Callers, all in the two sanctioned plugins:
- `scrollChildIntoView`, `scrollToBottom`, `scrollToTop` → `announceNavigation(container)`;
- `useEdgeAutoScroll` → on each edge write;
- `revealElement` (`scroll-reveal/web/internal/use-reveal-on-active.ts`) →
  `announceNavigation(el)` before `scrollIntoView` / `revealInNearest`.
  This adds the edge scroll-reveal → auto-scroll (web → web; no cycle, since
  auto-scroll imports nothing of scroll-reveal).

A smooth navigation streams scroll events, so settle waits for its end. A
navigation that lands at the bottom (the outline's "Scroll to bottom") resumes
following. One that leaves the bottom (outline jump, header expand) parks once
it settles, and no follow write fights it in flight.

Not announced: `KeepAnchorAcross`, `KeepScrollAcross`,
`captureDocumentScroll`/`restoreDocumentScroll`. These are compensations, and
a compensation on a follower is re-pinned (KeepAnchorAcross already re-pins
via the pin).

### State machine stays pure, and the guarantee becomes a test

Rewrite `internal/sticky-scroll-machine.ts` as
`step(state, signal) → { state, action: "none" | "scroll-to-bottom" }` with signals
`intent`, `scroll { ours, armed, movedDown, distance }`, `settle`,
`sentinel { visible }`, `jump`, `follow-key`, `find`. The hook stays thin
wiring.

`sticky-scroll-machine.test.ts` adds the **invariant test**: enumerate every
sequence (length ≤ 6) of non-reader signals (`sentinel` either way,
`scroll { armed: false }` up/down/clamped, `settle` without a drive) from
`following`, and assert the state is always `following`. That makes "a layout
effect parked the follower" a test failure, whatever effect is added later.
Keep the existing tests that still apply: the sign-asymmetry guarantee (no
observation-driven write while anchored), persistence and restore.

## Files

- `plugins/primitives/plugins/dom/plugins/auto-scroll/web/internal/sticky-scroll-machine.ts`: new reducer; drop `nextMode`'s `movedUp`/`atEnd`; keep `followAction`'s guarantee, `isAtBottom`, `sentinelObserverOptions`, `resolveRestore`.
- `…/auto-scroll/web/internal/sticky-scroll-machine.test.ts`: reducer cases plus the invariant enumeration.
- `…/auto-scroll/web/use-sticky-scroll.ts`: input listeners, arm/settle timer, driving mode, re-pin on unexplained scroll, registry registration; API unchanged.
- `…/auto-scroll/web/announce-navigation.ts` (new: the registry and `announceNavigation`).
- `…/auto-scroll/web/{scroll-child-into-view,scroll-to-bottom,use-edge-auto-scroll}.ts` + `index.ts` (export `announceNavigation`).
- `plugins/primitives/plugins/dom/plugins/scroll-reveal/web/internal/use-reveal-on-active.ts`: announce in `revealElement`.
- `…/auto-scroll/CLAUDE.md`: rewrite the `useStickyScroll` section, replacing the "do not use gesture listeners" rule with the coverage table and the "only reader evidence stops following" rule; note the find-in-page ⌘F handling.

## Verification

1. `./singularity test plugins/primitives/plugins/dom/plugins/auto-scroll`: the reducer and the invariant.
2. `./singularity build`, then a new e2e `auto-scroll/e2e/sticky-follow-verify.ts`
   against the agent-thread or transcript surface on a streaming conversation,
   in the browser:
   - following through growth, a card collapsing (clamp), a programmatic
     `KeepAnchorAcross`-style up-scroll and a thinking fold → still at the bottom;
   - wheel up 30 px and stop → still following once settled; wheel up 400 px →
     parked, jump button shown, no yank while content streams;
   - outline "Scroll to bottom" (smooth) → following; outline jump to a turn → parked;
   - StickyUserHeader expand at the bottom → the reveal is not undone.
3. A manual look at a live streaming conversation in this worktree's build.
