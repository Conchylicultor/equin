# Drag-select auto-scroll past the viewport edge (page editor)

## Context

In the Pages block editor a drag-select gesture stops making progress the moment the
pointer reaches the top or bottom edge of the scroll viewport. The document does not
follow the drag, so a selection cannot be extended past the blocks currently on
screen — on a long page the user has to abandon the gesture, scroll, and use
shift+click instead.

Both drag entry points are affected equally, and for the same reason: they are one
tracking loop. `onPointerDown` in
[`plugins/page/plugins/editor/web/components/block-editor.tsx`](../plugins/page/plugins/editor/web/components/block-editor.tsx)
(~L823-912) classifies the press as `background` (marquee) or `text` (promotes to a
block range at the first row boundary), then attaches window-level `pointermove` /
`pointerup` listeners. **Nothing in that loop ever scrolls anything.** These gestures
deliberately do not go through dnd-kit, so dnd-kit's built-in `autoScroll` — which
does cover the block-reorder drag — never applies to them.

Intended outcome: holding the pointer at either edge scrolls the document and keeps
extending the selection while it scrolls, for both entry points, exactly as Notion
does.

### Two defects, not one

Making the surface scroll mid-drag exposes a second, currently-latent bug:

```ts
const r = content.getBoundingClientRect();
const top = Math.min(start.y, ev.clientY) - r.top;     // block-editor.tsx:884
const height = Math.abs(ev.clientY - start.y);         // block-editor.tsx:885
```

`start.y` is a **viewport** `clientY` frozen at pointerdown, but `r.top` moves with
the scroll. Let `T` be the content top at pointerdown and `S` the pixels scrolled
since. The anchor's true content coordinate is `start.y - T` (constant), yet the code
computes `min(start.y, Y) - (T - S)` — the anchor drifts by `+S` — and `height` omits
`S` altogether. The marquee rectangle detaches from the range it is supposed to
depict. This is reachable **today** by trackpad-scrolling during a marquee drag; it
becomes unavoidable once the drag scrolls by itself. The range endpoints themselves
are fine — `applyRange(start.id, cur.id)` takes block **ids**, which are
scroll-invariant.

### Engagement gate: only once the gesture is genuinely a drag

Auto-scroll must **not** start at pointerdown. The editor's trailing `min-h-40` empty
zone sits exactly in the bottom edge band on a full page, so a plain click there would
scroll under a stationary pointer, set `dragMovedRef`, and swallow `onEmptyClick` —
turning click-to-edit at the bottom of a page into a runaway scroll. The gate is
per-mode, and in both cases means "the gesture is already ours":

```ts
const engaged = mode === "text" ? textDragPromotedRef.current : dragMovedRef.current;
```

For `text` that is the promotion latch — pre-promotion the browser owns the gesture and
does its own selection-drag autoscroll, and the editor's documented rule is "never
intercept the text press until the boundary"
(`plugins/page/plugins/editor/CLAUDE.md`).

### Assumptions taken (flag if wrong)

- **Vertical only.** The page scrolls on one axis; a speculative `axis` option buys
  nothing today.
- **Block-reorder (dnd-kit) drag is out of scope** — it has its own autoscroll.
- **Native selection autoscroll may compound with ours** during the pre-promotion text
  window (and possibly after, depending on whether `select-none` disarms it). Worst
  case is double speed, not breakage — this is observable behavior, not readable from
  the source, so the e2e measures it (step 4 below) rather than the plan guessing.

## Approach

### 1. New primitive: `useEdgeAutoScroll`

`no-adhoc-scroll-write` bans `scrollTop =` / `scrollTo()` everywhere except an explicit
path allowlist in
[`plugins/framework/plugins/tooling/plugins/lint/plugins/scroll-safety/lint/index.ts`](../plugins/framework/plugins/tooling/plugins/lint/plugins/scroll-safety/lint/index.ts),
whose three entries are all under `primitives/auto-scroll`. That plugin is declared
"the one sanctioned home for raw scroll writes", and `scrollChildIntoView` already
shows it is not strictly stick-to-bottom. **Extend it** rather than adding a second
sanctioned home:

New file `plugins/primitives/plugins/auto-scroll/web/use-edge-auto-scroll.ts`,
exported from that plugin's `web/index.ts`, path added to
`ignores["no-adhoc-scroll-write"]`. Widen the plugin's `description` in the barrel to
name the scroll-owning role (the docs check will want it consistent).

Domain-free, gesture-agnostic:

```ts
export interface EdgeAutoScrollOptions {
  /** Any element inside the scroll viewport; the hook walks up to find the scroller. */
  anchorRef: RefObject<HTMLElement | null>;
  /**
   * Fired after each frame that actually moved the surface, with the last tracked
   * pointer position. This is where a gesture re-evaluates itself: the pointer did
   * not move, the CONTENT did.
   */
  onScroll: (clientY: number) => void;
  /** Distance from the edge at which scrolling starts, px. Default 56. */
  threshold?: number;
  /** Speed at (or past) the edge, px/sec. Default ~1000. */
  maxSpeed?: number;
}

export interface EdgeAutoScroll {
  /** Feed the gesture's current viewport clientY. Starts the loop inside a band,
   *  stops it outside. Idempotent — safe to call every frame. */
  track(clientY: number): void;
  /** End the gesture. Call from pointerup AND pointercancel; also runs on unmount. */
  stop(): void;
}

export function useEdgeAutoScroll(opts: EdgeAutoScrollOptions): EdgeAutoScroll;
```

Loop body — the only scroll write in the file:

```ts
const dt = Math.min(t - (lastT ?? t), 50) / 1000;   // clamp: tab-hidden resume
const v = velocityFor(bandRect(el), y, threshold, maxSpeed);
if (v === 0) { raf = null; lastT = null; return; }  // idle => not scheduled
acc += v * dt;
const step = Math.trunc(acc);
acc -= step;
if (step !== 0) {
  const before = el.scrollTop;
  el.scrollBy({ top: step });
  if (el.scrollTop !== before) onScrollRef.current(y);  // skip when clamped
}
raf = requestAnimationFrame(frame);
```

Implementation notes that are load-bearing:

- **Frame-rate independent, with a clamped delta.** Integrate `v * dt` from the rAF
  timestamp and carry the sub-pixel remainder, so a slow ramp still moves and a 120Hz
  display does not scroll twice as fast. Clamp `dt` to ~50ms or a tab-hidden resume
  teleports the surface.
- **Ramp:** `t = clamp01((threshold - distance) / threshold)`, where `distance` goes
  **negative past the edge** (the pointer can leave the window — window-level listeners
  keep firing). Clamped to full speed there, never extrapolated. An ease (`t * t`)
  reads better than linear.
- **Never call `setPointerCapture`.** In `text` mode pre-promotion it would retarget
  events away from the contenteditable and kill the native intra-block selection that
  `onPointerDown` deliberately preserves. A held mouse button already gives implicit
  capture, which is why the ramp only has to tolerate negative distances.
- **Resolve the scroller per gesture**, lazily on the first `track` after a `stop`,
  cached in a ref — the anchor may be unmounted when the hook runs, and the editor is
  mounted under different hosts.
- **Edge band from the viewport, not blindly from the element rect.** For a real
  scroller use `getBoundingClientRect()`; for the `document.scrollingElement` fallback
  the band is `0 … window.innerHeight` (its rect is the document's, not the viewport's).
- **Skip `onScroll` when the surface did not actually move** (already clamped at
  top/bottom) so a parked pointer at a fully-scrolled edge costs nothing. This guard is
  also what bounds `rowAtPointer`'s cost — it is a `querySelectorAll` plus a rect per
  row, now running at 60fps on top of pointermove.
- **Return a stable `useMemo`'d object of `useEventCallback`s, carrying no refs** —
  `use-block-selection.ts` (L38-43) documents that `react-hooks/refs` reads any
  post-render `obj.foo` on a ref-carrying object as a ref access. `useEffect(() => stop, [])`
  for unmount. `detached-work-safety` exempts `/web/`, so the raw rAF loop is legal;
  comment that it is a gesture-lifetime animation loop, not polling.

### 2. Consolidate `findScrollParent`

`findScrollParent` today is private to
[`plugins/primitives/plugins/virtual-rows/web/internal/virtual-rows.tsx`](../plugins/primitives/plugins/virtual-rows/web/internal/virtual-rows.tsx)
(L42-59). Move it to `auto-scroll` so "what is the scroll container" has one
definition, widening it with an explicit predicate — the current version returns the
first *style*-scrollable ancestor even when it cannot actually scroll, which for edge
auto-scroll is a silent absorbed failure (a loop that runs and moves nothing):

```ts
export function findScrollParent(
  el: HTMLElement | null,
  opts?: { axis?: "y" | "x"; requireOverflowing?: boolean },
): HTMLElement;
```

virtual-rows calls it with defaults (byte-identical to today); the hook passes
`requireOverflowing: true`. Import graph stays a DAG: `auto-scroll/web` imports only
`css/ui-kit`, so `virtual-rows → auto-scroll` is acyclic.

Runtime discovery — rather than threading a ref down from `PaneChrome` → `PaneScroll`
— is the right call for a second reason beyond not touching a load-bearing primitive:
the block editor is also mounted **outside** any pane (`apps/website/demos/editor-toy`,
the story app, `persist={false}` demos). Discovery handles every host uniformly.

### 3. Wire it into the editor

In `block-editor.tsx`'s `SelectionLayer`:

- **Extract the per-move body into one `applySelectionAt(clientY)`** (a
  `useEventCallback`), called from both `pointermove` and the hook's `onScroll`. This
  is the correctness crux: while the pointer sits still at the edge, the selection must
  keep extending as content scrolls under it. Without it, auto-scroll would move the
  document and select nothing new.
- **`track` is called from `onMove` only, never from inside `applySelectionAt`** — that
  would make the hook re-latch itself off its own callback. "The pointer moved" and
  "the surface moved" stay two distinct callers of one applier:
  ```ts
  const onMove = (ev) => { applySelectionAt(ev.clientY); if (engaged) autoScroll.track(ev.clientY); };
  // hook: onScroll: (y) => applySelectionAt(y)
  ```
- **`stop()` in `onUp`, and add a `pointercancel` listener that runs the same teardown.**
  `onUp` today only fires on `pointerup`, which currently just leaks two inert
  listeners; with an rAF loop attached it leaks a runaway scroller.
- **Fix the marquee anchor.** Keep `dragStartRef.y` (viewport — `onEmptyClick` needs
  it) and add `contentY: e.clientY - contentRect.top` captured at pointerdown. Each
  frame, derive `curContentY = ev.clientY - contentRect.top` and compute
  `top = Math.min(anchorContentY, curContentY)`,
  `height = Math.abs(curContentY - anchorContentY)`. Measure the `> 3` drag threshold
  in content coords too, so a stationary pointer over a scrolling surface correctly
  counts as a drag rather than a click.

Two things that are already correct and must stay that way — worth a comment at each
site, since both become load-bearing only now:

- **`focusContainer()` at 60fps is safe only because of `preventScroll: true`**
  (`use-block-selection.ts:149`). `focus()` on an already-focused element is a no-op and
  `releaseCaret` early-returns at `rangeCount === 0`, so the per-frame call is cheap —
  but drop `preventScroll` and focus fights the auto-scroll every frame.
- **`rowAtPointer`'s nearest-row fallback off-content is exactly what auto-scroll
  wants**: a pointer below the last block resolves to the last row, so the range keeps
  extending as new content scrolls in. Programmatic scrolling emits no focus events, so
  it can never steal focus.

### 4. Stop `SET_RANGE` re-rendering every row per frame

`SET_RANGE` in
[`plugins/primitives/plugins/multi-select/web/internal/multi-select-context.tsx`](../plugins/primitives/plugins/multi-select/web/internal/multi-select-context.tsx)
(L95-113) always mints a fresh `Set` and a fresh state object, so it never bails —
every `BlockRow` re-renders on every call. Today that fires per pointermove; with a
per-frame re-apply it becomes continuous. Return `state` unchanged when the computed
set equals the current one **and** `state.anchorId === anchorId` (the file already has
a `shallowEqual` helper to mirror). Structural fix at the reducer, so a consumer-side
"did the head id change" guard is unnecessary.

## Files

| File | Change |
|---|---|
| `plugins/primitives/plugins/auto-scroll/web/use-edge-auto-scroll.ts` | **new** — the hook |
| `plugins/primitives/plugins/auto-scroll/web/internal/find-scroll-parent.ts` | **new** — moved from virtual-rows, `+ requireOverflowing` |
| `plugins/primitives/plugins/auto-scroll/web/index.ts` | export both; widen `description` |
| `plugins/framework/.../lint/plugins/scroll-safety/lint/index.ts` | allowlist the hook's path in `ignores["no-adhoc-scroll-write"]` |
| `plugins/primitives/plugins/virtual-rows/web/internal/virtual-rows.tsx` | delete L41-59, import the shared helper |
| `plugins/page/plugins/editor/web/components/block-editor.tsx` | `contentY` on `dragStartRef`; `applySelectionAt`; the `engaged` gate; `pointercancel`; `track`/`stop` |
| `plugins/primitives/plugins/multi-select/web/internal/multi-select-context.tsx` | `SET_RANGE` identity bail |
| `plugins/page/plugins/editor/e2e/drag-autoscroll-verify.ts` | **new** — e2e spec |
| `plugins/page/plugins/editor/CLAUDE.md` | extend "A text drag becomes a block selection…": the two coordinate spaces (viewport `y` for `onEmptyClick`, content `contentY` for the marquee) and why auto-scroll engages only once the gesture is claimed |
| `plugins/primitives/plugins/auto-scroll/CLAUDE.md` | document the new role |

## Verification

**1. E2E spec** — `plugins/page/plugins/editor/e2e/drag-autoscroll-verify.ts`, built on
`@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e` (`baseUrl`, `report`,
`withBrowser`) plus `./support/blank-page` (`openBlankPage`, `editableBlocks`),
mirroring `cross-block-text-selection-verify.ts`. Header comment records the unfixed
baseline (scroll delta ≈ 0 on step 1; step 2 off by the full scroll distance).

**Fixture** — typing 40 lines is slow and flaky; instead type 8 lines, then
`Escape` → `Meta+a` → `Meta+c` → `Meta+v` ×3 for ~64 blocks, well past the 900px
default viewport. Same path as `paste-optimistic-verify.ts` (L40-80); paste is
optimistic, so it is fast.

**Scroller probe** — mirrors the resolver rather than depending on it, so the spec does
not encode the implementation:

```ts
const scrollTop = () => page.evaluate(() => {
  let n = document.querySelector("[data-block-id]")?.parentElement ?? null;
  while (n) {
    const o = getComputedStyle(n).overflowY;
    if ((o === "auto" || o === "scroll") && n.scrollHeight > n.clientHeight) return n.scrollTop;
    n = n.parentElement;
  }
  return -1;
});
```

Assertions:

0. **setup** — `scrollTop() >= 0` (a scroller exists and actually overflows).
1. **marquee scrolls under a stationary pointer** — `mouse.down` in the right gutter
   beside block 0, one move down ~120px (arms `dragMoved`), one move to `y = 888`, then
   **no further moves**; wait 1500ms → `scrollTop()` grew > 300px and the `N selected`
   count is > ~20.
2. **the anchor stayed on its block** — the marquee-drift regression, which fails on
   today's build. Record block 0's viewport centre before the drag; after auto-scrolling
   assert the marquee's (`.border-primary\\/40`) viewport top ≈ block 0's *current*
   centre ±4px.
3. **stops at the bottom, and on release** — hold another 1500ms → `scrollTop()` is at
   `scrollHeight - clientHeight` and every block is selected; `mouse.up`, wait 600ms →
   `scrollTop()` unchanged, proving the loop really stopped.
4. **text mode** — press in block 0's text, move to block 2 (promotes), then to the
   bottom edge and hold → scroll happens and selected count ≥ 20. Also record the
   `scrollTop` delta over a 1s hold during an *intra-block* drag: that is where any
   compounding with the browser's native selection autoscroll would show up.
5. **the gating control** — `mouse.down` on empty background 10px above the viewport
   bottom, hold 1000ms with **no** movement → `scrollTop()` unchanged; `mouse.up` →
   `document.activeElement` is a contenteditable (click-to-edit intact). Without the
   `dragMovedRef` gate this both scrolls and eats the click.
6. **upward** — drag from the last block to `y = topEdge + 12` and hold → `scrollTop()`
   decreased.

**2. Existing specs must still pass** — the promotion and intra-block-control cases are
the half of the feature this must not eat:

```bash
bun plugins/page/plugins/editor/e2e/cross-block-text-selection-verify.ts
bun plugins/page/plugins/editor/e2e/block-selection-verify.ts
bun plugins/page/plugins/editor/e2e/drag-autoscroll-verify.ts
```

**3. Unit** — `bun run test:dom plugins/primitives/plugins/multi-select` (and the
editor's `web/__tests__/block-selection.test.tsx`) for the `SET_RANGE` bail; add a case
asserting a repeated identical `SET_RANGE` returns the same state object.

**4. Manual** — `./equin build`, then on a long page at
`http://att-1785418929-ohmg.localhost:9000/pages`: drag from a block toward the bottom
edge and hold — the document should scroll smoothly, faster the closer to the edge,
with the highlight extending continuously and the marquee rectangle tracking it.

```bash
./equin build
./equin check
```
