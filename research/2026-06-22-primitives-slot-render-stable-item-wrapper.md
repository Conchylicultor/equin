# slot-render: stable per-item wrapper element type (kill per-mount DOM teardown)

## Context

On the conversation transcript, every render-slot item app-wide tears down and
rebuilds its entire DOM subtree on each mount/remount instead of reconciling in
place. Measured **~2232–2448 childList mutations in 7s** on an *idle* transcript
(`conv-1782014757-gpnm`) via a `document.body` MutationObserver attributing to the
nearest `[data-ui-owner]=RowActions`, correlated with live-state pushes that
(re)mount rows. For the `JsonlViewer.RowAction` slot rendered ~1088× (136 rows ×
~8 actions), a single mount pass is ~2200 teardown/rebuild ops.

**Root cause (verified).** The generic `SlotRender` in
`plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx` chooses each
item's **wrapper element type from post-mount state**. It starts `horizontal=false`
and a `useLayoutEffect([])` (lines 142–156) flips it to `true` after measuring the
host's flex-direction. `renderItem` (lines 172–180) then returns a bare
`<Fragment>` when `false` and a `<div className="flex min-w-0 items-center">` when
`true`. Because `<Fragment>` and `<div>` are **different element types at the same
key**, the post-measure flip makes React destroy and rebuild every contribution
subtree below the wrapper (the element-picker marker span, the error boundary, and
the actual control). At steady idle (no remount) it reconciles fine — this is a
latent **per-mount amplifier**, independent of push rate.

**Intended outcome.** Make the per-item wrapper a *stable element type* so React
reconciles it in place across the horizontal flip. After the fix, RowActions
childList mutations on (re)mount drop to ~0.

## Approach

Render the per-item wrapper as a **stable `<div>`** whose layout switches via
`className`, never swapping the element type. `display:contents` is layout-neutral
(generates no box) so vertical lists stay pixel-identical to today's `<Fragment>`.

### The change

In `plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx`,
`renderItem` (lines 172–180), replace the `<div>`↔`<Fragment>` swap with one
stable element:

```tsx
return (
  // Stable element type across the post-measure horizontal flip so React
  // reconciles the contribution subtree in place instead of tearing it down
  // and rebuilding it on every (re)mount. Horizontal rows get the `min-w-0`
  // flex cell that relays the shrink-chain (so flexible text truncates instead
  // of wrapping); vertical lists get `display:contents`, a layout-neutral box
  // identical to the old <Fragment> — so vertical layout is byte-for-byte
  // unchanged.
  <div key={cId} className={horizontal ? "flex min-w-0 items-center" : "contents"}>
    {wrapped}
  </div>
);
```

`Fragment` is still imported and used by `defineMountSlot` (line 303), so the
import stays.

### Why this is safe (verified)

- **No host relies on items being direct children.** The element-picker marker
  middleware (`plugins/improve/plugins/element-picker/web/internal/marker-middleware.tsx`,
  priority-50 item middleware) *already* wraps every contribution in a
  `<span style="display:contents">`. So the slot host never had the contribution
  as a direct child — there is always a `display:contents` layer between. Adding
  one more `div.contents` in the vertical path changes nothing structurally.
- **`display:contents` is idiomatic and walked through everywhere it matters.**
  - reorder's `firstBoxDescendant` (`plugins/reorder/plugins/editor/web/internal/items.tsx:39-45`)
    descends past `display:contents` to arbitrary depth.
  - `CollapsibleWrap.effectiveChildren` (`plugins/primitives/plugins/collapsible-wrap/web/internal/collapsible-wrap.tsx:35-45`)
    recurses through `display:contents` to arbitrary depth.
  - `SortableReorderItem` renders `className="contents"` in non-edit mode
    (`items.tsx:135`).
- **Horizontal / CollapsibleWrap path is untouched** — it keeps
  `flex min-w-0 items-center` (a real flex box), so `effectiveChildren` still sees
  the per-item cell as a real box exactly as today.
- **Centralized fix.** `renderItem` is the single per-item wrapper for *both* the
  default render path (line 186) and the reorder list-middleware path (passed as
  the `renderItem` prop, lines 190–203). One change covers both.

## Critical files

- **Modify:** `plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx`
  (the `renderItem` callback, lines 172–180). Single-call-site change.
- No other files change. (`primitives/slot-render/CLAUDE.md`'s "Single-line
  discipline" section still describes the behavior correctly — the `min-w-0` cell
  for horizontal rows is unchanged; only the vertical wrapper's element type is
  stabilized. An optional one-line clarification could be added but isn't required.)

## Verification

1. `./equin build` from the worktree, then open
   `http://<wt>.localhost:9000/agents/c/conv-1782014757-gpnm`.
2. **Mutation count (primary signal).** In the page console, attach a
   `document.body` MutationObserver (`childList` + `subtree`) attributing each
   mutation to the nearest `[data-ui-owner]`, leave the transcript idle ~7s, and
   confirm RowActions childList mutations on (re)mount drop to **~0** (was
   ~2232–2448).
3. **Render profiler (secondary).**
   `bun e2e/render-profile.mjs --url http://<wt>.localhost:9000/agents/c/conv-1782014757-gpnm --seconds 8`
   — total commits and RowActions churn should not regress.
4. **Visual no-regression.** Vertical render slots (e.g. a sidebar section list)
   render pixel-identical to before (`display:contents` == old `<Fragment>`).
   Horizontal chrome rows (action bar, conversation header `CollapsibleWrap`) are
   unchanged — confirm chip truncation/wrapping still behaves.
5. `./equin check` (type-check + boundaries) passes.
