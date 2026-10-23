# auto-scroll

The **scroll-owning** primitive: the one sanctioned home for driving a scroll
container. `no-adhoc-scroll-write` (see
[`scroll-safety`](../../../../../framework/plugins/tooling/plugins/lint/plugins/scroll-safety/CLAUDE.md))
bans `scrollTop =` / `scrollTo()` / `scrollBy()` repo-wide except in this
plugin's own files, so a new scroll behavior belongs *here*, not in the consumer
that wants it. Today that is six roles:

- **stick-to-bottom streaming** — `useStickyScroll` + `JumpToBottomButton`, and `announceNavigation` (every navigating scroll writer calls it)
- **container-scoped positioning** — `scrollToBottom`, `scrollChildIntoView`
  (scroll only THIS container; never an ancestor, unlike `scrollIntoView`; it
  honours the child's CSS `scroll-margin` as `scrollIntoView` does, so a
  section under a pinned header declares the bar's height once)
- **gesture edge auto-scroll** — `useEdgeAutoScroll`
- **scroll kept across a wholesale swap** — `KeepScrollAcross`
- **the reader's anchor kept across a resize above it** — `KeepAnchorAcross`
- **scroll carried to a new document** — `captureDocumentScroll` /
  `restoreDocumentScroll`
- **scroll-container discovery** — `findScrollParent`

## `KeepAnchorAcross` — content resized above the reader must not move them

The engine-independent twin of browser scroll anchoring, for a region that
knows when it resizes content above the viewport (data-view's paged reads
swap far rows for a height-keeping placeholder and back). On a `changeKey`
change, `getSnapshotBeforeUpdate` takes the first element marked with
`anchorAttr` that is visible in the scroller (one also carrying `weakAttr` —
a placeholder about to be replaced — only when nothing else is) and its top;
`componentDidUpdate` finds the element of the same `anchorAttr` VALUE (content
identity: it may be re-created) and scrolls by how far it moved. Acts only
on a key change, so ordinary updates force no layout.

**It is the only anchoring inside its region.** It renders the region's box
itself (a plain block `div`, handed to the caller through `hostRef`) with
`overflow-anchor: none`, so browser scroll anchoring never acts there. The two
are NOT idempotent: each picks its own anchor, and the browser picks whatever
box is on screen — inside a windowed list, a spacer or a row the window is
about to recycle, and it then scrolls by how far THAT moved (measured: a
released page's full height, skipping whole pages of rows). Owning the box
makes the opt-out impossible to forget (a `display: contents` box would draw
nothing for the property to apply to).

**`browserAnchoring` keeps the browser's anchoring on** — only for a region of
real rows (no spacers, placeholders or recycled rows), where the browser picks
a real row and agrees with the correction here. The conversation transcript
sets it: without it nothing held a parked reader still while images and code
highlighting settled above them, and a restored reading position drifted by
hundreds of px. A windowed list must keep the default.

**A following scroller is anchored to its bottom, not a row.** While a
`useStickyScroll` follows, it claims the scroller's bottom pin
(`internal/bottom-pin.ts`, toggled with its `overflow-anchor`), and
`KeepAnchorAcross` on that scroller re-pins the bottom through the owner's own
write instead of keeping a row. Keeping a row there scrolled the follower up by
whatever a commit released above it — a paged transcript's window sliding as a
new event lands — which the follower read as the reader leaving, and parked.

## `useStickyScroll` — only reader evidence stops following

You follow until **you** scroll away: reader input (wheel, touch, a pointer
down in the scroller, a scroll key) or a navigation you asked for, and your
scroll settles away from the bottom. Stopping within `threshold`, or coming
back to it, follows again. Content settling, reflow and new messages only
*carry out* that standing intent. **A scroll no reader input explains is put
back at the bottom.** That covers the browser clamping as content below
shrinks, its scroll anchoring, `KeepAnchorAcross` keeping a row across a
window slide, and a `focus()`. Consumers render the returned `bottomSentinel`
as the scroll container's last child (asserted at mount) and signal nothing.

This replaced "a scroll we did not write is the reader leaving", an inference
by elimination: every layout effect that moved the offset (a card collapsing,
the paged window sliding, stand-ins folding) was one more way to park, fixed
one exception at a time
([`research/2026-10-23-global-sticky-scroll-input-driven-intent.md`](../../../../../../research/2026-10-23-global-sticky-scroll-input-driven-intent.md)).
No effect produces reader input, so none can park a follower, and
`sticky-scroll-machine.test.ts` enumerates every sequence of non-reader signals
to hold that.

**Modes** (`step` in `internal/sticky-scroll-machine.ts`, the hook is wiring):
`following` (the hook owns the offset), `driving` (the reader is moving it, so
nothing is written and anchoring is the browser's), `anchored` (parked).
Input *arms* the scroller for `SETTLE_MS`. A scroll that lands armed, and that
the hook did not write, is the reader's: arriving at the bottom follows at
once, anything else drives. While driving every scroll is the reader's (momentum
after the input). On settle (no input or scroll for `SETTLE_MS`, the pointer
up), the distance **at the reader's last scroll** decides. Content that
streamed in meanwhile is not their displacement. Arming without a scroll (a
click on a card) changes nothing.

**Every sanctioned scroll funnel announces a navigation.**
`announceNavigation(target)` arms the owner of `target` and of every ancestor
scroller. It is called by `scrollChildIntoView`, `scrollToBottom`/`scrollToTop`,
`useEdgeAutoScroll` and scroll-reveal's `revealElement`, so an outline jump or a
`StickyUserHeader` expand moves the reader and is never undone. A new
*navigating* scroll writer must call it. A *compensation* that keeps the reader
in place (`KeepAnchorAcross`, `KeepScrollAcross`, `keepInPlace`) must not.
Lint already forces every programmatic scroll through these two plugins, so
the set is complete. The remaining unannounced moves are browser-native:
find-in-page has no page-visible input, so ⌘F / Ctrl+F parks explicitly.

**Do not reintroduce a size observer.**
[`research/2026-05-25-global-sticky-scroll-redesign.md`](../../../../../../research/2026-05-25-global-sticky-scroll-redesign.md)
removed one because a size delta is *sign-blind*: opening the file pane rewraps
text taller, which is indistinguishable from new content. Watching the sentinel
(`useInView`, from [`primitives/dom/in-view`](../in-view/CLAUDE.md)) is instead
*sign-asymmetric* — a taller reflow can only make the bottom **less** visible —
so it can exclusively un-follow, and a signal like that cannot drag anyone
downward. Asserted in
`internal/sticky-scroll-machine.test.ts`. The guarantee is narrower than it
sounds: while following, reflow *does* write. It is "no observation-driven writes
**while not following**".

**"Ours" = the offset we last wrote** (read back after writing, so clamping
counts). **Every own write must be instant, including `jumpToBottom`**: a
smooth scroll's intermediate offsets never match the recorded one, so they
would count as nobody's and be re-pinned.

**`followKey` means "the user just acted"** — never ambient state. `isWorking`
also rises when a background agent resumes, which must not move a reading user.

**Sentinel geometry, both load-bearing** (the observer is `in-view`'s; the
geometry and the follow policy stay here): the pin `threshold` becomes bottom
`rootMargin` (a zero-height node at `threshold: 0` means a 0px pin distance), and
the root is widened hugely left/right so horizontal scroll on an `axis="both"`
surface can't carry the sentinel out of view.

**`persist: { key, anchorAttr }`** (opt-in): `key` must identify the *surface
instance* (compose `useSurfaceTabId()`) — two panes can show one conversation at
different positions. `anchorAttr`'s value must be content identity: use
`data-event-key`, never `data-event-index`, which indexes the *filtered* array and
re-points whenever an `EventFilter` resolves. A saved anchor whose row is gone
returns `missing`, distinct from `none`, so a key-scheme regression can't read as
"first visit".

## `KeepScrollAcross` — a swap must not move the reader

A commit that replaces a region's content wholesale (the tree switching between
its plain and its windowed render) removes every child before inserting the
replacement. Anything that forces a layout in between — a blur handler of the
removed focused node, scroll anchoring re-selecting from a vanished anchor —
sees short content and the browser clamps the scroller, so the list jumps to the
top although its full height is back before paint. No hook runs before React's
mutations, which is why this one is a class: `getSnapshotBeforeUpdate` reads the
offset, `componentDidUpdate` writes it back. It acts only when `swapKey`
changes, so ordinary updates force no layout. Restoring in the layout phase also
lands before a child's state-driven follow-up render — `useVirtualRows` attaches
its virtualizer there and reads the restored offset as its `initialOffset`.

## `captureDocumentScroll` / `restoreDocumentScroll` — a reload keeps the place

For a same-origin iframe whose new document replaces the old one (the prototype
canvas swaps a loaded twin in on every live edit): capture every scroll offset
of the outgoing document, restore them into the incoming one, matched by id or
else DOM path. A client-rendered page is not tall enough at `load`, so the
restore re-tries on every DOM mutation and sub-resource load until each offset
is reached, the reader acts (wheel / touch / key / pointer — never `scroll`,
which our own writes fire), or 5 s pass; the returned function cancels it.
Script state is not carried — it lives in the old document.

## `useEdgeAutoScroll` — the gesture contract

While a gesture's pointer sits in the top or bottom edge band of its scroll
viewport, the surface scrolls, ramping up the closer to the edge. The hook knows
nothing about the gesture: the consumer feeds it a viewport `clientY` (`track`)
and ends it (`stop`, from pointerup **and** pointercancel). Vertical only,
deliberately — a speculative `axis` option would be an untested path.

**`onScroll` is the gesture's second clock, not a notification.** While the
pointer is parked at an edge it is the ONLY thing driving the consumer forward —
the pointer did not move, the *content* did — so a gesture re-evaluating only on
`pointermove` would scroll the document and select nothing new. Extract the
per-move body into one applier called from both places. Mirror rule: **`track` is
called from the pointer handler only, never from that applier**, or the hook
re-latches off its own callback. (It fires only on a frame that actually moved the
surface: at a clamped edge the consumer's per-frame work must not run for nothing.)

**What it scrolls is an `EdgeScrollSurface`** — an edge band plus a
`scrollBy(px)` that says whether anything moved. `anchorRef` builds the usual one
from a DOM scroll container (carrying the sub-pixel remainder, since `scrollBy`
moves in whole px). A surface whose scroll is not a `scrollTop` passes its own
via `surface` instead: the Sonata piano roll scrolls by moving the playhead, so
its surface's `scrollBy` is a seek (see `apps/sonata/progress/loop`).

**The surface is resolved per gesture** — lazily on the first `track` after
a `stop`, never at mount: the anchor may be unmounted when the hook first runs,
and a host may re-parent the surface between gestures.

**`requireOverflowing: true`** (the `anchorRef` form) is what keeps failure loud. The plain walk returns
the first *style*-scrollable ancestor even when its content currently fits, and
the loop would then run at 60fps writing a `scrollTop` that never budges —
indistinguishable from "parked at the bottom". Callers that merely *read* a scroll
offset (windowing) want the opposite default, since the styled ancestor is right
even before enough rows arrive to overflow it. Hence an opt-in, not one behavior.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The scroll-owning primitive: the one sanctioned home for driving a scroll container. Stick-to-bottom streaming (useStickyScroll + JumpToBottomButton; content stamped FOLLOW_MOTION_ATTR is followed frame by frame while it animates), container-scoped scrollToBottom / scrollChildIntoView, gesture-agnostic edge auto-scroll (useEdgeAutoScroll), scroll kept across a wholesale DOM swap (KeepScrollAcross), the reader's anchor kept on screen across a commit that resizes content above it (KeepAnchorAcross), an element kept at its screen position across a re-layout (keepInPlace), scroll carried from one document to the next (captureDocumentScroll / restoreDocumentScroll, for a reloaded same-origin iframe), and the shared findScrollParent discovery.
- Web:
  - Uses:
    - `primitives/css/ui-kit.Button`
    - `primitives/css/ui-kit.cn`
    - `primitives/dom/in-view.useInView`
    - `primitives/dom/web-storage.defineStore`
    - `primitives/latest-ref.useEventCallback`
    - `primitives/latest-ref.useLatestRef`
    - `ui/icons.Icon`
  - Exports (types):
    - `DocumentScroll`
    - `EdgeAutoScroll`
    - `EdgeScrollSurface`
    - `FindScrollParentOptions`
    - `JumpToBottomButtonProps`
    - `JumpToBottomView`
    - `KeepAnchorAcrossProps`
    - `KeepScrollAcrossProps`
    - `ScrollAlign`
    - `ScrollChildIntoViewOptions`
    - `ScrollToBottomOptions`
    - `StickyScrollHandle`
    - `StickyScrollPersist`
    - `UseEdgeAutoScrollOptions`
    - `UseStickyScrollOptions`
  - Exports (values):
    - `announceNavigation`
    - `captureDocumentScroll`
    - `findScrollParent`
    - `FOLLOW_MOTION_ATTR`
    - `JumpToBottomButton`
    - `KeepAnchorAcross`
    - `keepInPlace`
    - `KeepScrollAcross`
    - `restoreDocumentScroll`
    - `scrollChildIntoView`
    - `scrollToBottom`
    - `scrollToTop`
    - `useEdgeAutoScroll`
    - `useStickyScroll`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/density --space-xs`
    - `ui/tokens/shape --spacing`
  - Imported by:
    - `apps/prototypes/canvas`
    - `apps/sonata/progress/loop`
    - `apps/sonata/rich/chord-progression`
    - `apps/website/pages/foundations`
    - `conversations/agent-thread`
    - `conversations/conversation-view/jsonl-viewer`
    - `conversations/conversation-view/jsonl-viewer/background-shells`
    - `conversations/conversation-view/jsonl-viewer/outline`
    - `layouts/miller`
    - `page/editor`
    - `primitives/data-view`
    - `primitives/dom/scroll-reveal`
    - `primitives/log-channels`
    - `primitives/outline/scroll-spy`
    - `primitives/overlay/image-viewer`
    - `primitives/virtual-rows`
- Exemptions:
  - Exempts itself from: `scroll-safety/no-adhoc-scroll-write` — `web` (sanctioned)

<!-- AUTOGENERATED:END -->
