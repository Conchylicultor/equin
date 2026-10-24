# Data-view row virtualization

## Context

The `data-view` primitive rendered every row through a plain `.map` with no
windowing. The Tasks **Recent** tab (a `data-view` list seeded with the full
task set, ~3000 rows) rendered all rows synchronously on open and tripped the
**"Slow operations detected"** warning. This affects *any* large data-view
consumer, not just tasks.

### Why this trips the slow-op warning

The slow-op "element appearance" signal is the `useResource` **mount→settle**
duration (`plugins/primitives/plugins/live-state/web/use-resource.ts:198,245`):
`startRef` is stamped on first render, and the duration is reported from a
post-commit `useEffect` the first time `pending` flips false. That window
**includes the synchronous render of every row** — so a ~3000-row `.map`
inflates the measured duration past the 1000ms `elementMs` threshold
(`plugins/debug/plugins/slow-ops/core/config.ts`). Windowing the render shrinks
the work (and the window) and makes large surfaces pleasant to scroll.

## Approach: self-discovering virtual-rows primitive (mode-agnostic)

Virtualization (not a forced default filter) is the right fix: it changes no
semantics, hides no data, and helps every consumer transparently.

### The real obstacle: nested scroll containers

The data-view's `"surface"` mode body is `min-h-0 flex-1 overflow-y-auto`
(`data-view.tsx`) and is *meant* to own the scroll. But the Tasks pane mounts the
Recent view inside `defineTabbedView`'s host, which **already** wraps tab content
in a bounded `no-scrollbar min-h-0 flex-1 overflow-y-auto` scroller
(`tabbed-view/.../define-tabbed-view.tsx:78`). Because that wrapper is a `block`
(not `flex`), the surface-mode data-view's `flex-1` root never bounds — the
data-view's own `overflow-y-auto` body grows to full content height (~140000px)
and the *tabbed-view* scroller is what actually scrolls. A virtualizer windowing
against the data-view's own body therefore measures a ~140000px viewport and
renders **everything**. This nested-scroll defect *is* the original bug.

Threading the host's own scroll ref down would window against that broken,
unbounded body. The fix targets the **real** scroller by discovering it.

### Changes (as implemented)

1. **Dependency.** Added `@tanstack/react-virtual` (`^3.13`) to
   `plugins/primitives/plugins/data-view/package.json` (React-19 compatible;
   none existed before). Installed by `bun install` during `./equin build`.

2. **Reusable `<VirtualRows>` component** — new
   `web/components/virtual-rows.tsx`, exported from the data-view web barrel so
   every flat view child (and future ones) share one windowing implementation. It
   **self-discovers** the scroll container at runtime rather than being handed
   one: `findScrollParent` walks up from the sizer to the nearest ancestor with
   `overflow-y: auto|scroll|overlay` (fallback: the document scroller). This is
   mode-agnostic — surface mode resolves to the data-view's own bounded body;
   embedded inside another scroller resolves to that outer scroller. Because the
   list usually starts below a toolbar / tab strip, it measures `scrollMargin`
   (sizer top − scroller top + scrollTop, in a layout effect) and offsets each
   row by it (the standard TanStack "scroll element is an ancestor" recipe).
   Props: `items`, `estimateSize`, `overscan?` (8), `getKey`, `itemClassName?`,
   `children`. Dynamic row measurement via `measureElement` (variable heights
   supported). The relative sizer + absolute rows carry per-site
   `layout/no-adhoc-layout` escapes — windowing has no positioning-primitive
   equivalent; this is the sanctioned escape pattern (~21× repo-wide).

3. **List view adopts it** (`plugins/list/web/components/list-view.tsx`). The row
   JSX is factored into one `renderRow` closure shared by both branches.
   `const virtualize = rows.length > VIRTUALIZE_THRESHOLD` (100). When false, the
   **exact current** `.map` runs (small lists byte-for-byte unchanged — no
   absolute-positioning / observer overhead). `estimateSize` is keyed off
   `options.size` (sm→36, md→44).

4. **Tasks Recent tab → embedded mode**
   (`tasks/.../recent/web/internal/tasks-recent-view.tsx`): added `mode="embedded"`
   so the data-view stops nesting a second (shadowing) scroller inside the
   tabbed-view surface. `VirtualRows` then discovers the tabbed-view scroller and
   windows against it — a single, correctly-bounded scroll owner.

## Verification

Playwright against the live worktree (2991 tasks): the Recent tab renders **~30
windowed rows** (was 3198), advancing to indices 133–170 on scroll, against the
real ancestor scroller (`clientHeight 791`, `scrollHeight 140472`). Rows align
correctly at top and mid-scroll; no console errors; no
`ERR_INSUFFICIENT_RESOURCES` (which the all-rows render caused).

## Scope & follow-ups

Implemented for the **list view** — the reported, reproducible case (Tasks
Recent), DnD-free, so windowing is safe. `<VirtualRows>` is built reusable so the
remaining views adopt it without rework. Follow-up tasks:

- **Table view / `data-table` primitive** — `data-table` owns the row map and is
  shared by other consumers (studio explorer, debug profiling); it uses a CSS
  subgrid with a sticky header. Virtualizing needs absolute-positioning that
  coexists with subgrid — a larger, cross-consumer change.
- **Gallery view** — responsive auto-fill grid needs lane-aware
  (columns-per-row) virtualization keyed off measured container width.
- **Tree view / `primitives/tree`** — renders via recursive component nesting
  (`RowChrome` recurses on expanded children) with `@dnd-kit` DnD. Virtualizing
  requires a pre-flattened visible-node list (the existing `orderedIds` DFS is a
  starting point) integrated with drag/drop overlays. The Tasks tree tab is the
  motivating large consumer.
- **`scrollMargin` is measured once** (mount). If content above the list changes
  height after mount, the offset would drift. Fine for today's fixed toolbars; a
  `ResizeObserver` re-measure is the durable hardening if a dynamic-height header
  ever sits above a virtualized list.

## Critical files

- `plugins/primitives/plugins/data-view/package.json` — dep
- `plugins/primitives/plugins/data-view/web/components/virtual-rows.tsx` — new
- `plugins/primitives/plugins/data-view/web/index.ts` — export `VirtualRows`
- `plugins/primitives/plugins/data-view/plugins/list/web/components/list-view.tsx` — adopt
- `plugins/tasks/plugins/task-list/plugins/recent/web/internal/tasks-recent-view.tsx` — embedded
</content>
