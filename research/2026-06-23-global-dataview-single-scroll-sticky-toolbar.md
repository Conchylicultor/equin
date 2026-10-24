# DataView: one pane scroll, sticky toolbar, no `mode`

## Context

The Studio Explorer pane (`/studio/explorer`) cannot scroll — a wheel/trackpad
gesture triggers the `overscroll-hint` rubber-band bounce instead of scrolling.

**Diagnosis.** The DOM scroll chain has no scrollable element. The explorer wraps
its `<DataView>` (default `mode="surface"`, which owns its own
`overflow-y-auto` body) in two nested `Column scrollBody={false}` layers. A
`Column` with `scrollBody={false}` renders its body as a plain **`display:block`**
`<div className="min-h-0 flex-1">`. The surface DataView's root is `min-h-0 flex-1`
and depends on a **flex** parent to clamp its height — but the block wrapper
severs the flex context, so the DataView (and its inner `Scroll`) balloons to the
full 24,834px content height and never reaches `scrollHeight > clientHeight`.
Nothing scrolls → every gesture is "wasted" → bounce.

This is a symptom of a deeper inconsistency: `<DataView mode>` has two placement
modes — `surface` (DataView owns its scroll; needs a bounded flex parent) and
`embedded` (DataView is natural-height; the host pane scrolls). The split is the
source of per-pane divergence (task-list scrolls fine, explorer bounces) and the
implicit "surface needs a flex-bounded parent" contract is what explorer got
wrong, silently.

**Decision (with the user).** Collapse the two modes onto a single behavior:

1. **DataView is always natural-height and never owns a scroller** (today's
   `embedded` semantics). The old surface-mode footgun is eliminated *by
   construction* — there is no code path left that renders a scroll inside DataView.
2. **The DataView toolbar becomes a `<Sticky>` header** pinning against the pane's
   scroll ancestor — so it stays visible in both single-pane and stacked-section
   contexts, and gives the "sticky headers everywhere" future for free.
3. **The pane owns exactly one scroll**, through a single sanctioned scaffold
   (`PaneScroll`). With sticky headers, the model unifies: *a pane body is one
   `PaneScroll` viewport; every header within it is a `<Sticky>`.*

This fixes the explorer bug, makes all DataView panes behave identically, and
removes the whole class of nested/severed-scroll bugs.

## Target architecture

```
Pane host (Miller column / full-pane)  →  bounded h-full box
  └─ PaneChrome header  (Bar, OUTSIDE the scroll — already reserves the FAB gutter)
  └─ PaneScroll         (THE one scroll viewport: Scroll axis="y" fill h-full)
       └─ <Sticky> DataView toolbar </Sticky>   ← pins at scroll-viewport top
       └─ view body (gallery/table/list/tree) — natural height, flows & scrolls
```

- **Single scroll owner.** `PaneScroll` is the only `overflow-y` in the pane.
  `VirtualRows.findScrollParent` binds to it; `scrollMargin` (sizer offset within
  it) correctly includes the sticky toolbar height — this is the already-supported
  "toolbar sits above the list" case.
- **Stacked DataViews hand off automatically.** DataView wraps its
  `<Sticky>` + body in its **own block box** (`<Stack gap="none">`), so each
  DataView is its own sticky *containing block*. When a section scrolls out, its
  sticky toolbar un-pins with it — no `active` toggling or computed `top` offsets
  (unlike queue-view/jsonl-pane). This makes cluster-view (2 DataViews) and
  Profiling (N sections) correct with zero consumer ceremony.

## Changes

### 1. New primitive: `PaneScroll`

`plugins/primitives/plugins/pane/web/` (or a small leaf under `primitives/css`) —
a dead-thin sanctioned scaffold:

```tsx
// PaneScroll = the pane's single vertical scroll viewport.
export function PaneScroll({ className, ...rest }: PaneScrollProps) {
  return <Scroll axis="y" fill className={cn("h-full", className)} {...rest} />;
}
```

Reuses `Scroll` (`primitives/css/scroll`) — no new mechanics. Its value is one
idiom + a grep/lint/doc target. Export from the pane web barrel.

### 2. PaneChrome routes its body through `PaneScroll`

`plugins/primitives/plugins/pane/web/components/pane-chrome.tsx`: the body is
currently `Column scrollBody={true}` (→ `Scroll axis="y" fill`). Swap that inner
scroll for `PaneScroll` so PaneChrome and bespoke hosts share one scaffold.
Behavior is identical (PaneScroll *is* that Scroll). The header `Bar` stays
outside the scroll and keeps `endSafeArea` (the FAB gutter — see §5).

### 3. DataView host + types

**`plugins/primitives/plugins/data-view/core/internal/types.ts`**
- Delete `DataViewProps.mode` (line ~374) and `DataViewRenderProps.embedded` (line ~208).

**`plugins/primitives/plugins/data-view/web/components/data-view.tsx`**
- Remove `mode = "surface"` (line 79), `const embedded = …` (line 82),
  `embedded` from `renderProps` (line 198).
- Stop rendering `<Column>`. Return a single block box wrapping a sticky toolbar
  and the natural-height body (both main path lines 202-272 and the
  placeholder path lines 147-172):

```tsx
return (
  <Stack gap="none">                          {/* per-DataView sticky containing block */}
    <Sticky edge="top" className={cn(
      "bg-background flex items-center gap-sm pb-sm pl-sm",
    )}>
      {/* title, SearchInput(ml-auto), Sort, Filter, actions, Creators, ViewSwitcher — UNCHANGED */}
    </Sticky>
    <ControlSizeProvider size="xs">
      {renderIsolated(DataViewSlots.View.id, activeInstance.viewType as …, renderProps)}
    </ControlSizeProvider>
  </Stack>
);
```

- `Stack gap="none"` = `flex flex-col`, no `min-h-0 flex-1` → a block box that
  establishes the sticky containing block and lets the body grow naturally
  (does NOT clamp height).
- Toolbar: keep the horizontal `flex items-center gap-sm pb-sm pl-sm`; **add
  `bg-background`** (rows must not show through the pinned bar — tree-list
  precedent `<Sticky className="bg-background …">`); **drop `shrink-0`** (no flex
  column parent) and **drop `pr-14`** (§5). Default `Sticky` `layer="raised"`.
  Keep the existing `eslint-disable layout/no-adhoc-layout, spacing/no-adhoc-spacing`.
- **Dev-mode scroll-ancestor assertion (the structural guard).** On mount, walk
  up from the DataView root for an ancestor with `overflow-y ∈ {auto,scroll,overlay}`
  *before* hitting `document.scrollingElement`/`body`. If none, `console.error`/throw
  a clear message naming `storageKey` ("DataView <id> has no scroll ancestor — its
  pane must provide a `<PaneScroll>`"). Catches the Home/file-tree omission loudly,
  dev-only. (Mirror the tiny walk in
  `virtual-rows/web/internal/virtual-rows.tsx:52` `findScrollParent`.)

### 4. View children: drop `props.embedded` (collapse to natural-height branch)

- **`…/data-view/plugins/gallery/web/components/gallery-view.tsx`**: line 155
  `props.embedded ? "py-xl" : "h-full p-xl"` → `"py-xl"`; lines 289 & 311
  `!props.embedded && "p-xl"` → `"p-xl"`.
- **`…/data-view/plugins/list/web/components/list-view.tsx`**: line 70 →
  `"py-xl"`; line 188 `!props.embedded && "p-sm"` → `"p-sm"`.
- table-view, tree-view: no `embedded` usage — no change.

### 5. FAB gutter (`pr-14`): drop it

The sticky toolbar pins *inside* the scroll body, **below** the PaneChrome header.
The floating-action-bar (`fixed top-2 right-3`) overlaps the header band, and
PaneChrome already reserves that safe area pane-aware via
`reserveEnd = contentOwnsTopChrome && atSurfaceEnd` → `Bar endSafeArea`
(`pane-chrome.tsx:71,79`). So `pr-14` on the DataView toolbar is redundant for
PaneChrome panes. Drop it. **Follow-up to verify:** bespoke `chrome:false` hosts
without a header (story-gallery, song-library, code-explorer left panel) — if the
ViewSwitcher lands under the FAB on the rightmost surface, give that host its own
top reservation, do NOT resurrect `pr-14` (which would wrongly indent every
stacked DataView).

### 6. Consumer migration (18 sites)

**Already `mode="embedded"` — just delete the now-invalid prop (type error forces it):**
runtime-section.tsx, cluster-view.tsx (×2), tasks-recent-view.tsx,
tasks-list.tsx, community-browser-section.tsx.

**Surface, inside a PaneChrome scroll — no edit beyond confirming PaneChrome host:**
servers-list.tsx, prototype-gallery.tsx, reports-view.tsx.

**Remove redundant fill/scroll wrappers (PaneChrome / existing Scroll takes over):**
- `explorer-view.tsx` + `plugin-tree.tsx` — **THE BUG.** Drop the outer
  `Column fill h-full scrollBody={false}` in plugin-tree (render `<DataView>`
  directly in `PluginTreeProvider`). In explorer-view, drop both nested
  `scrollBody={false}` Columns; make the stats header a `<Sticky>` and let the
  DataView flow under it inside the single PaneChrome `PaneScroll`:
  `<><Sticky>stats</Sticky><PluginTree/></>`.
- `config-nav.tsx` — drop the `Stack gap="none" h-full min-h-0` wrapper.

**Bespoke hosts that LACK a scroll — add `PaneScroll` (these relied solely on the
surface DataView's scroll; verified):**
- `home-layout.tsx` — body `Column scrollBody={false}` → wrap `Home.Section.Render`
  in `PaneScroll` (or flip to `scrollBody={true}`).
- `code-explorer/web/components/file-tree-view.tsx` — left `ResizablePanel`'s
  `Stack h-full min-h-0 border-r` → `PaneScroll className="border-r"`; delete the
  stale "No outer Scroll" comment.
- `song-library.tsx`, `story-gallery.tsx` (`chrome:false`, no PaneChrome) — their
  `Column fill scrollBody={false}` was the only scaffold; route the body through
  `PaneScroll` (e.g. `Column scrollBody={true}` or a `PaneScroll` body).

**Pane already owns an explicit scroll — drop reliance on surface scroll only:**
- `agents-list.tsx` (AgentsRoot `<Scroll axis="both" h-full p-lg>`) — no edit;
  sticky toolbar pins against it.
- `pages-sidebar.tsx` (`<Scroll fill className="py-xs">`) — no edit.
- `slow-ops-view.tsx` (tabbed-view Column body Scroll) — no edit.

**`file-tree.tsx`** — remove the `mode?` prop, the `mode="surface"` default, and
`mode={mode}`. Host 1 (code-explorer pane) gains `PaneScroll` (above); Host 2
(plugin-meta `file-tree-section.tsx`, `<Scroll max-h-96>`) just drops `mode="embedded"`.

**Documented scroll-owning exceptions (NOT migrated):** terminal, screenshot
canvas, studio graph — they own their viewport (`overflow-hidden`/canvas) and host
no flowing DataView.

### 7. Docs / lint

- **`data-view/CLAUDE.md`** — rewrite the "Placement mode" section: DataView is
  always natural-height; toolbar is `<Sticky>`; the pane owns one scroll via
  `PaneScroll`. Delete the "Mode caveat — avoid nested scrollers / use
  mode=embedded" paragraph in "Row virtualization" (obsolete) and the
  `!props.embedded` "View contract" paragraph.
- **gallery/list `CLAUDE.md`** — drop `embedded` mentions.
- **pane `CLAUDE.md`** — document `PaneScroll` as the sanctioned pane-body scroll
  and the "headers are `<Sticky>` inside it" model.
- No bespoke static lint (can't trace render trees → false positives); the dev
  assertion in §3 is the structural guard.

## Sequencing (build green at each step)

1. View children (§4) — still compile while `embedded` is passed (ignored).
2. `PaneScroll` primitive (§1) + PaneChrome routing (§2).
3. DataView host + types (§3) — atomic core. Now every `mode=…` is a **type error**.
4. Consumer prop removals + wrapper/scroll fixes (§6) — clears the type errors;
   the scroll-ownership fixes (explorer, home, file-tree, song/story) are the
   manual, non-type-driven core.
5. Docs (§7).
6. `./equin build` then `./equin check`.

## Verification

- `./equin build`; open `http://<worktree>.localhost:9000/studio/explorer`
  and confirm the tree **scrolls** (no bounce), stats header sticky above.
- Scripted Playwright (`e2e/screenshot.mjs`) — assert the explorer scroll
  container has `scrollHeight > clientHeight` and a wheel delta changes `scrollTop`.
- **Stacked sticky hand-off — cluster-view** (`/debug` → Slow Ops → Cluster): two
  DataViews; verify toolbar #2 takes over from #1 as you scroll (per-DataView
  containing-block boxes). Make-or-break test for §3's `Stack gap="none"` choice.
- **Scroll added** — Home app grid and code-explorer file-tree pane: confirm they
  scroll and row virtualization still windows (findScrollParent binds to PaneScroll).
- **Dev assertion** — temporarily mount a DataView in a scroll-less pane; confirm
  the named error fires.
- Spot-check: agents-list, pages-sidebar, reports, slow-ops Local, sonata library,
  prototypes, story gallery, tasks Recent/Tree, file-tree plugin-meta section
  (sticky toolbar inside `max-h-96`).

## Critical files

- `plugins/primitives/plugins/data-view/web/components/data-view.tsx`
- `plugins/primitives/plugins/data-view/core/internal/types.ts`
- `plugins/primitives/plugins/data-view/plugins/{gallery,list}/web/components/*-view.tsx`
- `plugins/primitives/plugins/pane/web/components/pane-chrome.tsx` + new `PaneScroll`
- `plugins/apps/plugins/studio/plugins/explorer/web/components/{explorer-view,plugin-tree}.tsx` (the bug)
- `plugins/apps/plugins/home/plugins/shell/web/components/home-layout.tsx` (needs scroll)
- `plugins/code-explorer/web/components/file-tree-view.tsx` (needs scroll) + `file-tree.tsx`
- `plugins/apps/plugins/sonata/plugins/library/web/components/song-library.tsx`,
  `plugins/apps/plugins/story/plugins/shell/web/components/story-gallery.tsx`
- `config_v2/plugins/settings/web/components/config-nav.tsx` + the `mode="embedded"` consumers
- `plugins/primitives/plugins/data-view/CLAUDE.md`, gallery/list/pane `CLAUDE.md`
