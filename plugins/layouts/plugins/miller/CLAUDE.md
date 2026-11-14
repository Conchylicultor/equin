# miller

Miller-columns renderer for the pane chain. Replaces `<PaneRouter/>` at the
shell's main mount: instead of mounting only the root pane and relying on
nested `<Outlet/>` calls, Miller maps `match.panes` to a flat row of
columns. Walking deeper in the URL appends a column on the right; closing
a pane removes the rightmost column.

## Mental model: the chain as a column stack

The chain is an ordered list of panes (root → leaf, left → right). It is
**the URL** — every pane is a URL segment, so the chain and the browser
URL are always in sync. Miller renders each entry as one column.

### Two ways to change the chain

**Reset** — rebuild the chain from scratch. The new chain starts at the
target pane's required ancestry (derived from its `after` declarations)
and ignores whatever was on screen. Happens when there is no valid
position for the target in the current chain.

**Extend** — keep a prefix of the current chain and splice the target in.
Always truncates everything to the right of the insertion point first.
Three sub-cases, all handled by `useOpenPane` (caller-aware):

| Case | Trigger | Result |
|---|---|---|
| **Open right** (default) | No special relationship | Truncate after caller, append target |
| **Wrap left** | Caller declares `after: [target]` | Insert target before caller, validate right |
| **Self-update** | Target is the caller | Update params in-place, truncate children |

**Opening on the right always overwrites all columns to the right of the
caller.** There is no way to open a column "beside" a sibling without
affecting the columns further right.

### Example walkthrough

```
Start:               conv1

Open task pane       conv1 │ task          (open right from conv1)
  from conv1 toolbar

Click conv link      conv1 │ task │ conv2  (open right from task)
  in task

Click file link in   conv1 │ task │ conv2 │ file   (open right from conv2)
  conv2

Click file link in   conv1 │ file          (open right from conv1 — everything
  conv1                                     right of conv1 is overwritten)

Open attempt view    attempt │ conv1 │ file (wrap left — conv1 has after:[attempt],
  from conv1                                 so attempt is inserted before conv1;
                                             right side validated and kept)
```

The last step illustrates **wrap left**: because `conversationPane` declares
`after: [attemptPane]`, `useOpenPane` detects that the caller (conv1) can
follow the target (attempt), inserts attempt before conv1, then calls
`validateChain` to keep the right side intact (`conv1 │ file` survives
because it was already valid).

### Implications for pane authors

- **Buttons in a conversation toolbar open panes to the right.** They use
  `useOpenPane` with no special options, so they always truncate the columns
  to their right.
- **To keep a pane's right context alive when inserting a parent**, declare
  `after: [parentPane]` on the child. That lets `useOpenPane` detect the
  wrap-left case and preserve the right side.
- **To force a full reset** (e.g. switching to an unrelated top-level view),
  call `openPane(target, params, { root: true })` or let the routing fall
  through to `buildFreshChain`.

## Public API

- `<MillerColumns/>` — the renderer. The shell mounts it once.

That's it. Pane authors don't import anything from this plugin. They
register panes with the regular `Pane.define` + `Pane.Register` flow. A pane
declares no width: every column takes its share of the row (below).

## Sizing: balanced, then scroll

The whole row is laid out by one pure function, `layoutColumns` in
[`web/layout.ts`](web/layout.ts) (tested beside it); the components only draw
what it decides. Prototype: `proto-1794189254-saewzy` (`open=balanced`).

- **No column is drawn before the row is measured.** The row's width is
  `null` until its first measure (`useResizeObserver`, before paint), and
  only then is `MillerRow` mounted with a `rowWidth: number` — so a column is
  never first laid out at a stand-in width and moved by the measure. Chrome
  counts that move as a layout shift even when the measure lands in the same
  frame, before paint (the cold `/agents` load scored 0.095 for it).
- **Columns that fit share the row equally**: 50/50, 33/33/33, … A column
  "fits" while every shown column gets at least `SHARE_MIN` (420px) — so a
  1470px laptop row shows three, a 1920px one four. The width is the whole
  column, its 4px divider included.
- **The leaf gets no bonus.** It is one share like the others, so opening the
  next column never snaps the previous leaf back from a wide fill.
- **Past that, new columns open on the right at the same width**: the older
  ones keep their share and sit scrolled off to the left, the row's end
  (`total − row`) putting the shown window's left edge exactly on the
  viewport's — no column half-cut.
- **A narrow row keeps a pair**: when not even two columns fit at
  `SHARE_MIN`, two still share the row down to `PAIR_MIN` (300px) each, so an
  open keeps the column it came from beside it. Only below 600px does one
  column take the row.
- **How many columns show depends on the row width alone** — a drag never
  changes it, so two drags that overshoot the row cannot push the column a
  pane was opened from off screen.
- **A column the user dragged keeps that width**; the others share what it
  leaves — and when that would leave them under the minimum, the dragged
  widths scale down in proportion. Double-click the divider to forget it.
  Every shown column dragged: the leaf shares instead.
- **A collapsed bar** is 32 fixed and leaves the rest to share.
- **A window resize re-balances live**, unanimated; a row sitting at its end
  stays at its end.
- **A divider drag** lays the row out as it was when the drag began, with the
  dragged column following the pointer (`dragLayout`; the leaf grows back if
  it would leave a gap). Re-balancing during the drag would move the columns
  around the divider and pull it away from the pointer. When the drag ends,
  the column keeps the width it was left at (stored) and the rest re-balance
  — as a motion.
- **Nothing automatic is ever stored.** Only a drag writes a width
  (`miller.column-widths.v2`, localStorage, keyed by `(tabId, paneId)`, per
  surface via a `WeakMap` on the `PaneStore`). The previous owner's entries
  were mixed with the automatic 50/50 split the leaf used to persist on its
  first child, so they are dropped (`legacy`), not adopted.

## Motion

- **Every change of what the row shows is one motion** — a route change (open,
  close, swap, reorder, back/forward), a zoom, a collapse, the re-fit at the
  end of a drag. The column boxes transition their width (280ms
  `cubic-bezier(.33,1,.68,1)`), and the row's scroll glides to `scrollTarget`
  (the row's end) on the same curve **and on the transition's own clock**
  (`glideScroll`'s `follow`): a CSS transition starts when the browser
  resolves the style change, which a long task in the same commit can push
  back or eat, so a scroll on a clock of its own would drift from the widths.
  The motion ends when the width transitions report finished.
- Every pane takes its final inner width at the motion's first frame and the
  box glides around it (a growing box uncovers it, a narrowing one closes the
  gap after it): content re-wraps once, at the start, where the eye expects
  change — never per frame, and never in a late snap after the motion looks
  done (a narrowing column used to hold its old width to the end, then jump).
- `prefers-reduced-motion`: no transition, the scroll lands at once. The first
  paint lands in place.
- **Enter / leave / swap** (`ColumnMotion`) ride on top: a newcomer mounts at
  its final width and only its content slides in (content that replaces the
  pane's first render mid-slide — a loading block giving way — joins the slide
  where it stands, never landing whole); a closed column's ghost
  fades out over the remaining columns as they grow into its place. The row's
  scroll is MillerColumns' alone.

## Collapse

Each non-leaf column has a chevron button on its divider that collapses it
to a 32px-wide vertical bar with the pane title rotated 90°. Click the bar to
expand. A bar and its pane are the SAME column box — collapsing narrows the
box around a bar fading in, expanding grows it back around the pane — never
two elements. Collapse state is **per-surface** (keyed by the column's
`PaneStore` via a `WeakMap`) and per column instance (the slot's uuid),
persisted to sessionStorage (`miller.column-collapse`, keyed by `(tabId,
uuid)`), so it survives navigation within a tab session and resets on full
reload.

When a column is collapsed, its component subtree is unmounted, unless its
pane declares `chrome.keepMountedWhenCollapsed` (kept mounted, hidden).

## Zoom (double-click a header)

- Double-click a column's header → that column expands to fill the row and
  every other one, the leaf included, collapses to a bar (no dividers).
- **A zoom's bars keep their panes mounted**, laid out at their unzoomed width
  and hidden under the bar. Leaving the zoom, or moving it to another column,
  only uncovers them: remounting a heavy pane (a conversation: >1 s measured)
  in the commit that starts the motion blocked the main thread while the
  width transition's clock ran, so the motion was already over when the next
  frame painted — and the pane lost its state.
- While zoomed, clicking a bar moves the zoom to that column.
- Double-click the zoomed header again, or press Esc (a surface shortcut,
  registered only while zoomed) → back to the exact layout and the row's
  scroll offset from before the zoom.
- **Any route change ends the zoom.** The zoom state remembers the route it
  was made on (`routeKey`: the pane instances, in order) and `effectiveZoom`
  honours it only on that route, with its column in it — so a link opened
  from a zoomed column lands as an ordinary column, and closing the zoomed
  column never leaves the others collapsed. A stale state is also dropped, so
  back/forward to the zoomed route does not zoom again.
- Per surface (per `PaneStore`). The full-pane layout's double-click is a no-op.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Miller-columns layout renderer. Maps the matched pane chain to a horizontal sequence of resizable, collapsible columns.
- Web:
  - Uses: 34 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/pane` ×12
    - `primitives/dom/auto-scroll` ×3
    - `primitives/dom/web-storage` ×3
    - `primitives/hover-reveal` ×2
    - `primitives/sortable-list` ×2
    - `layouts/route-fallback.DeferredRouteFallback`
    - `primitives/css/motion.prefersReducedMotion`
    - `primitives/css/spacing.Stack`
    - `primitives/css/theme-boundary.Theme`
    - `primitives/css/ui-kit.cn`
    - `primitives/dom/element-size.useResizeObserver`
    - `primitives/dom/scroll-reveal.REVEAL_BOUNDARY_ATTR`
    - `primitives/error-boundary.PluginErrorBoundary`
    - `primitives/scope/surface-id.useSurfaceTabId`
    - `primitives/shortcuts.useSurfaceShortcuts`
    - `primitives/ui-context.UiRegion`
    - `ui/icons.Icon`
  - Exports (values):
    - `MillerColumns`
    - `PaneOverlayHost`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --accent`
    - `ui/tokens/color-palette --background`
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-scale`
    - `ui/tokens/type-scale --font-size-2xs`
    - `ui/tokens/type-scale --font-weight-medium`
    - `ui/tokens/type-scale --line-height-2xs`
  - Imported by:
    - `apps/agent-manager/shell`
    - `apps/debug/shell`
    - `apps/events/shell`
    - `apps/file-explorer/shell`
    - `apps/isle/shell`
    - `apps/keyboard-party/shell`
    - `apps/mail/shell`
    - `apps/pages/shell`
    - `apps/settings/shell`
    - `apps/studio/shell`
    - `layouts/host`

<!-- AUTOGENERATED:END -->
