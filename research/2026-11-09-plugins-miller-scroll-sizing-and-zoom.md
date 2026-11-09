# Miller columns: scroll sizing and zoom

## Context

The Miller layout (`plugins/layouts/plugins/miller`) sized the leaf as the
residual (`flex-1`), split the leaf 50/50 the first time a child opened — and
persisted that split as if the user had dragged it, so nested opens kept halving
(1096 → 548 → 274 at 1400 px). A column's width depended on history, and the
new column could land squeezed or off-screen. Double-click maximize never
cleared on a route change: opening a link from a maximized column drew the new
column as a 32 px bar, and closing the maximized column collapsed every column.

Reference: prototype `proto-1794189254-saewzy`, `open=scroll` + `dblclick=zoom`
(reviewed and liked by the user).

## Design

**One pure layout function** (`web/layout.ts`), tested beside it:

- `layoutColumns(columns, rowWidth, zoomId)` — each column `{ id, width, collapsed }`
  (width = dragged ?? `pane.width` ?? 400) → boxes `{ id, width, bar, handle }`.
  - Normal: a collapsed non-leaf is a 32 px bar; if the sum is narrower than the
    row the leaf grows to fill (never below its own width); wider overflows.
  - Zoom (only when `zoomId` is in the columns): every other column is a bar,
    the zoomed one is `max(own, row − bars)`. No dividers while zoomed.
- `scrollTarget(...)` — end of the row (`max(0, total − row)`); 0 while zoomed;
  `min(end, scrollBeforeZoom)` when leaving a zoom on the same route.
- Zoom state reducer: `{ id, routeKey, scrollFrom }`, effective only while
  `routeKey` (the route's uuids in order) is unchanged and `id` is in the
  route — so any route change ends zoom by construction and a stale id can never
  collapse everything (fixes both maximize bugs at the type/derivation level, no
  clearing effect).

**Render** (`MillerColumns` owns the layout; `Column` draws one box):

- Each column is ONE box (inside the sortable wrapper) whose `width` is set in
  px; bar ↔ pane is a swap of its content, so un-collapsing grows the bar.
- During a motion (route / zoom / collapse change — a "motion key"), the box
  wears `transition: width 280ms cubic-bezier(.33,1,.68,1)`; drags and row
  resizes change no motion key, so they follow instantly.
- The pane box inside has an explicit inner width: the target width, or —
  while a column narrows — its previous width (clipped) until the motion ends.
- The row's scroll glides per frame on the same curve and duration — a new
  `glideScroll` in `primitives/dom/auto-scroll` (the sanctioned scroll writer;
  announces a navigation).
- Bars fade in 160 ms ease-out, a pane coming back from a bar 200 ms ease-out.
- `prefers-reduced-motion`: no width transition, no hold, instant scroll.
- Esc (surface shortcut, registered only while zoomed) leaves zoom; clicking a
  bar while zoomed moves the zoom to that column.

**Widths store**: only a divider drag writes. New owner key
`miller.column-widths.v2`; the old `miller.column-widths` entries (polluted by
the auto split, indistinguishable from real drags) are dropped via `legacy`.
The stored width is the whole column (its 4 px divider included).

**ColumnMotion**: enter/leave/swap kept; its own smooth scroll-back on leave is
removed (the row glide now owns every scroll). A newcomer mounts at its final
width (no width transition), so only its content slides, as before.

## Verification

- `./equin test plugins/layouts/plugins/miller` (layout, scroll target, zoom
  reducer incl. both maximize regressions).
- `./equin check`, `./equin build`, then the agent manager in `browser_*`:
  widths/scroll on open, zoom, switch, unzoom, link from zoom, close zoomed;
  per-50 ms rect samples during transitions.
