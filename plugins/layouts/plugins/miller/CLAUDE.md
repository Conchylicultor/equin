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
register panes with the regular `Pane.define` + `Pane.Register` flow, and
optionally set a default column width.

## Per-pane width

```ts
Pane.define({
  route: tasksRootRoute,
  app: agentManagerApp,
  component: TasksRoot,
  width: 320,
});
```

`width` is the column's default width in pixels (top-level on
`Pane.define`, separate from the `chrome` config). Defaults to 400.

## Sizing: every column has its own width ("scroll", Finder-style)

The whole row is laid out by one pure function, `layoutColumns` in
[`web/layout.ts`](web/layout.ts) (tested beside it); the components only draw
what it decides.

- **Every column, the leaf included, has its own width**: the width the user
  dragged it to ?? `pane.width` ?? 400. A width is a property of the pane, never
  the space left over — the same pane opens at the same width whatever was
  on screen before. The width is the whole column, its 4px divider included.
- **Spare room goes to the leaf.** When the columns are narrower than the row,
  the leaf grows to fill it (never below its own width). When they are wider,
  the row overflows and scrolls horizontally.
- **Nothing automatic is ever stored.** Only a divider drag writes a width
  (`miller.column-widths.v2`, localStorage, keyed by `(tabId, paneId)`, per
  surface via a `WeakMap` on the `PaneStore`). The previous owner's entries
  were mixed with the automatic 50/50 split the leaf used to persist on its
  first child, so they are dropped (`legacy`), not adopted.
- **Every change of what the row shows is one motion** — a route change (open,
  close, swap, reorder, back/forward), a zoom, a collapse. The column boxes
  transition their width (280ms `cubic-bezier(.33,1,.68,1)`), and the row's
  scroll glides on the same curve and duration, frame by frame
  (`glideScroll`, auto-scroll), to `scrollTarget`: the row's end, so the newest
  column is fully on screen. A column that narrows keeps its old inner width
  (clipped by its box) until the motion ends, so its content does not re-wrap
  every frame. A divider drag or a row resize is no motion: it follows at once.
  `prefers-reduced-motion`: no transition, the scroll lands at once. The first
  paint lands in place.
- **Enter / leave / swap** (`ColumnMotion`) ride on top: a newcomer mounts at
  its final width and only its content slides in; a closed column's ghost
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
  - Uses: 33 symbols — full list in [REFERENCE.md](./REFERENCE.md)
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
    - `apps/keyboard-party/shell`
    - `apps/mail/shell`
    - `apps/pages/shell`
    - `apps/settings/shell`
    - `apps/studio/shell`
    - `layouts/host`

<!-- AUTOGENERATED:END -->
