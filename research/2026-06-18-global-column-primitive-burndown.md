# Column Primitive Burndown — 6 Layout Surfaces

**Date:** 2026-06-18  
**Category:** global  
**Status:** Plan

## Context

The `Column` primitive (`@plugins/primitives/plugins/css/plugins/column/web`) bakes the
`rigid header | flex-fill scroll body | rigid footer` fill policy into a single named-slot
component. Callers write roles (`header=`, `body=`, `footer=`), never raw mechanics
(`flex flex-col`, `min-h-0 flex-1`, `overflow-y-auto`, `shrink-0`).

The `layout/no-adhoc-layout` lint rule enforces this — all banned classes are in a
**burndown allowlist** (`plugins/primitives/plugins/css/lint/index.ts`). Six surfaces that
pre-date the rule still hand-roll the column-fill pattern and sit in that list. Migrating
them removes them from the allowlist and prevents any future reintroduction.

The six surfaces:
1. `PaneChrome` — `plugins/primitives/plugins/pane/web/components/pane-chrome.tsx`
2. `defineTabbedView` — `plugins/primitives/plugins/tabbed-view/web/internal/define-tabbed-view.tsx`
3. `DataView` — `plugins/primitives/plugins/data-view/web/components/data-view.tsx`
4. `PagesSidebar` — `plugins/apps/plugins/pages/plugins/page-tree/web/components/pages-sidebar.tsx`
5. `FavoritesSidebar` — `plugins/apps/plugins/pages/plugins/starred/web/components/favorites-sidebar.tsx`
6. `StoryEditor` — `plugins/apps/plugins/story/plugins/shell/web/components/story-editor.tsx`

## Column / Scroll / Stack APIs (quick reference)

```tsx
// Column: vertical rigid|flex|rigid fill
<Column
  header={ReactNode}       // auto-wrapped in shrink-0 div; omit to render nothing
  body={ReactNode}         // wrapped in <Scroll axis="y" fill> (default) or <div min-h-0 flex-1> if scrollBody=false
  footer={ReactNode}       // auto-wrapped in shrink-0 div; omit to render nothing
  fill={boolean}           // adds min-h-0 flex-1 to root (default false)
  scrollBody={boolean}     // true=Scroll wrapper, false=plain flex-fill div (default true)
  gap={SpaceStep}          // spacing-ramp gap between regions
  className={string}       // appended to root
/>
// Root always gets: flex flex-col [gap] [min-h-0 flex-1 if fill] [className]

// Scroll: scroll container + optional flex-fill
<Scroll axis="y" fill hideScrollbar className="...">
// Emits: min-h-0 flex-1 overflow-y-auto overflow-x-hidden [no-scrollbar if hideScrollbar] [className]

// Stack: vertical flex + gap
<Stack gap="xs" className="...">
// Used for stacking items inside a Column header slot
```

Import paths:
```tsx
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
```

## Per-line disable (sanctioned escape for genuinely complex layouts)

When no primitive models the layout (horizontal measurement rows, named-slot toolbars with
variable content, horizontal split panels), use:
```tsx
// eslint-disable-next-line layout/no-adhoc-layout -- <reason>
```

This travels with the code and keeps the file out of the allowlist without a global
exemption.

---

## Migration plan (ordered simplest → most complex)

### 1. `pages-sidebar.tsx` — replace scroll div with `<Scroll fill>`

Only one layout occurrence. No header/footer from this component's perspective —
`SidebarPaneSection` owns the section header. This surface just provides the
scrollable body.

**Before (line 72):**
```tsx
<div className="min-h-0 flex-1 overflow-y-auto py-xs">
  {result.pending ? <Loading variant="rows" /> : <DataView<Block> .../>}
</div>
```

**After:**
```tsx
<Scroll fill className="py-xs">
  {result.pending ? <Loading variant="rows" /> : <DataView<Block> .../>}
</Scroll>
```

`py-xs` is a semantic spacing-ramp token — NOT banned by `no-adhoc-layout`.
`Scroll fill` emits `min-h-0 flex-1 overflow-y-auto overflow-x-hidden` and passes
`className` last. Zero per-line disables needed.

**Imports:** Add `Scroll` from scroll/web.

---

### 2. `favorites-sidebar.tsx` — identical pattern to pages-sidebar

**Before (line 64):**
```tsx
<div className="min-h-0 flex-1 overflow-y-auto py-xs">
  <SortableList ...>...</SortableList>
</div>
```

**After:**
```tsx
<Scroll fill className="py-xs">
  <SortableList ...>...</SortableList>
</Scroll>
```

**Imports:** Add `Scroll` from scroll/web.

---

### 3. `define-tabbed-view.tsx` — full Column migration (zero disables)

**Before (lines 61–87):**
```tsx
<div className={cn("flex min-h-0 flex-1 flex-col", className)}>
  {(header || ordered.length > 1) && (
    <div className="flex shrink-0 flex-col gap-xs px-sm pb-xs">
      {header}
      {ordered.length > 1 && activeView && <ViewSwitcher .../>}
    </div>
  )}
  <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
    {activeView && renderIsolated(...)}
  </div>
</div>
```

**After:**
```tsx
<Column
  fill
  className={className}
  header={
    (header != null || ordered.length > 1) ? (
      <Stack gap="xs" className="px-sm pb-xs">
        {header}
        {ordered.length > 1 && activeView && (
          <ViewSwitcher
            options={ordered.map((v) => ({ id: v.id, title: v.title, icon: v.icon }))}
            activeId={activeView.id}
            onSelect={selectView}
          />
        )}
      </Stack>
    ) : undefined
  }
  scrollBody={false}
  body={
    <Scroll fill hideScrollbar>
      {activeView &&
        renderIsolated(
          View.id,
          activeView as unknown as Contribution,
          viewProps as ViewProps,
        )}
    </Scroll>
  }
/>
```

**Key decisions:**
- `fill` → maps `flex min-h-0 flex-1 flex-col` to Column root.
- `className={className}` → passes the Host's `className` prop through.
- Header: `<Stack gap="xs" className="px-sm pb-xs">` — Stack stacks the optional external
  `header` node above the ViewSwitcher (vertical flex + gap). Column wraps this in `shrink-0`
  automatically, so `shrink-0` is removed from the inner div. `px-sm pb-xs` are spacing-ramp
  tokens (not banned by `no-adhoc-layout`).
- `scrollBody={false}` + explicit `<Scroll fill hideScrollbar>` preserves the original
  `no-scrollbar` behavior. `hideScrollbar` is a `Scroll` prop that emits the `no-scrollbar`
  class. The Column body wrapper (`div.min-h-0 flex-1`) + Scroll (`min-h-0 flex-1 overflow-y-auto`)
  double-nesting is harmless in a flex-col context.
- If `header` is undefined and `ordered.length <= 1`, the `header` prop is `undefined` →
  Column renders no header slot (no phantom wrapper or gap).

**Imports:** Add `Column`, `Scroll`, `Stack`. Remove `cn` if the only remaining usage was
this `cn(...)` call (check: `className` is now passed to Column directly, not via `cn`).

---

### 4. `story-editor.tsx` — Column for outer shell, per-line disables for horizontal split

`StoryEditor` wraps: rigid `<StoryToolbar.Host />` + flexible `<StoryEditorBody />`.
`StoryEditorBody` is a **horizontal** split (two side-by-side panels) — Column doesn't
apply to horizontal layouts.

**`StoryEditor` — before (lines 19–24):**
```tsx
<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
  <StoryToolbar.Host />
  <StoryEditorBody />
</div>
```

**`StoryEditor` — after:**
```tsx
<Column
  className="h-full min-h-0 bg-background text-foreground"
  scrollBody={false}
  header={<StoryToolbar.Host />}
  body={<StoryEditorBody />}
/>
```

`h-full` and `min-h-0` are not banned by `no-adhoc-layout`. `bg-background` and
`text-foreground` are token classes, also not banned. `scrollBody={false}` is critical:
`StoryEditorBody` manages its own scroll per-panel; wrapping it in `overflow-y-auto` would
break the horizontal split layout.

**`StoryEditorBody` — before (lines 31–52):**
```tsx
<div className="flex min-h-0 flex-1">
  {split ? (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto border-r border-border">...</div>
      <div className="min-h-0 flex-1 overflow-y-auto">...</div>
    </>
  ) : view === "author" ? (
    <div className="min-h-0 flex-1 overflow-y-auto">...</div>
  ) : (
    <div className="min-h-0 flex-1 overflow-y-auto">...</div>
  )}
</div>
```

**`StoryEditorBody` — after (per-line disables, not Column):**
```tsx
// eslint-disable-next-line layout/no-adhoc-layout -- horizontal split row; no Column/Frame/Grid primitive models a flex-fill row of independent y-scroll panels
<div className="flex min-h-0 flex-1">
  {split ? (
    <>
      {/* eslint-disable-next-line layout/no-adhoc-layout -- left split panel: fills half-row with independent y-scroll */}
      <div className="min-h-0 flex-1 overflow-y-auto border-r border-border">
        <BlockEditor pageId={pageId} />
      </div>
      {/* eslint-disable-next-line layout/no-adhoc-layout -- right split panel: fills half-row with independent y-scroll */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <StoryRender pageId={pageId} rendererId={activeRendererId} />
      </div>
    </>
  ) : view === "author" ? (
    // eslint-disable-next-line layout/no-adhoc-layout -- single-panel fill: fills the row with y-scroll
    <div className="min-h-0 flex-1 overflow-y-auto">
      <BlockEditor pageId={pageId} />
    </div>
  ) : (
    // eslint-disable-next-line layout/no-adhoc-layout -- single-panel fill: fills the row with y-scroll
    <div className="min-h-0 flex-1 overflow-y-auto">
      <StoryRender pageId={pageId} rendererId={view} />
    </div>
  )}
</div>
```

**Imports:** Add `Column` from column/web.

---

### 5. `data-view.tsx` — Column for root + body; per-line disables for toolbar row

The `embedded` prop splits the layout mode. `Column fill={!embedded}` handles the
root; `scrollBody={!embedded}` handles the body:

- Surface mode (`!embedded`): Column root = `flex min-h-0 flex-1 flex-col`, body =
  `<Scroll axis="y" fill>`.
- Embedded mode: Column root = `flex flex-col`, body = `<div className="min-h-0 flex-1">`.
  The `min-h-0 flex-1` on the body wrapper is inert in an auto-height context (the host pane
  scrolls, not the DataView) — safe.

The toolbar div (`flex shrink-0 items-center gap-sm ...`) is a horizontal row of controls
(title, search, filter, actions, view-switcher). No named-slot primitive applies cleanly
to a variable-content toolbar row → per-line disable.

**Empty-instance fast-return — before (lines 112–128):**
```tsx
<div className={cn("flex flex-col", !embedded && "min-h-0 flex-1")}>
  <div className="flex items-center gap-sm px-sm pb-sm">
    {title ? <Text ...>{title}</Text> : null}
    {actions ? <div className="ml-auto">{actions}</div> : null}
    <div className={actions ? undefined : "ml-auto"}>
      <CreatorsControl creators={creators} />
    </div>
  </div>
</div>
```

**Empty-instance fast-return — after:**
```tsx
<Column
  fill={!embedded}
  header={
    // eslint-disable-next-line layout/no-adhoc-layout -- horizontal toolbar row; no named-slot primitive maps to a variable-content control set
    <div className="flex items-center gap-sm px-sm pb-sm">
      {title ? <Text as="div" variant="label">{title}</Text> : null}
      {actions ? <div className="ml-auto">{actions}</div> : null}
      <div className={actions ? undefined : "ml-auto"}>
        <CreatorsControl creators={creators} />
      </div>
    </div>
  }
/>
```

Note: no `body` prop — Column renders nothing for absent slots.

**Main render — before (lines 157–204):**
```tsx
<div className={cn("flex flex-col", !embedded && "min-h-0 flex-1")}>
  <div
    // eslint-disable-next-line spacing/no-adhoc-spacing -- pr-14 reserves the fixed ~44px floating-action-bar gutter
    className={cn("flex shrink-0 items-center gap-sm pb-sm pl-sm", !embedded && "pr-14")}
  >
    {/* toolbar controls */}
  </div>
  <div className={cn(!embedded && "min-h-0 flex-1 overflow-y-auto")}>
    {renderIsolated(...)}
  </div>
</div>
```

**Main render — after:**
```tsx
<Column
  fill={!embedded}
  scrollBody={!embedded}
  header={
    // eslint-disable-next-line layout/no-adhoc-layout -- horizontal toolbar row; no named-slot primitive maps to a variable-content control set
    <div
      // eslint-disable-next-line spacing/no-adhoc-spacing -- pr-14 reserves the fixed ~44px floating-action-bar gutter, a layout dimension the ramp can't express
      className={cn("flex shrink-0 items-center gap-sm pb-sm pl-sm", !embedded && "pr-14")}
    >
      {/* toolbar controls — unchanged */}
    </div>
  }
  body={
    renderIsolated(
      DataViewSlots.View.id,
      activeInstance.viewType as unknown as Contribution,
      renderProps,
    )
  }
/>
```

The toolbar's `shrink-0` class is kept in `className` (it's on the toolbar div itself, not the
Column header wrapper). Column already wraps the header in a `shrink-0` outer div, making
the inner `shrink-0` on the toolbar div redundant — but harmless. We could remove it from
the toolbar's className, but leaving it does not violate any rule (only the outer Column-level
`shrink-0` div is in the primitive; the inner one is in a per-line-disabled context anyway).

**Imports:** Add `Column` from column/web.

---

### 6. `pane-chrome.tsx` — Column for outer shell; per-line disables for helper components

Most complex surface. The outer `PaneChrome` structure migrates cleanly to Column.
The helper components (`PaneActionsSlot`, `OverflowActionsBar`) use horizontal flex for
measurement and overflow — these get per-line disables.

**Main `PaneChrome` return — before (lines 71–130):**
```tsx
<div className="flex h-full flex-col">
  <Bar tier="pane" overflow={...} ...>
    {/* title, actions, expand, close */}
  </Bar>
  <div className="min-h-0 flex-1 overflow-y-auto">
    <ContentScope>{children}</ContentScope>
  </div>
</div>
```

**Main `PaneChrome` return — after:**
```tsx
<Column
  className="h-full"
  header={
    <Bar
      tier="pane"
      overflow={headerSpill ? "visible" : "hidden"}
      endSafeArea={reserveEnd}
      className={layoutCtx?.dragHandleProps ? "cursor-grab active:cursor-grabbing" : undefined}
      onDoubleClick={layoutCtx?.onDoubleClickHeader}
      {...layoutCtx?.dragHandleProps}
    >
      {showLeading && leadingControl}
      {resolvedTitle != null && resolvedTitle !== "" &&
        (typeof resolvedTitle === "string" ? (
          <Text as="span" variant="label" className="min-w-0 truncate">
            {resolvedTitle}
          </Text>
        ) : (
          // eslint-disable-next-line layout/no-adhoc-layout -- node title needs inline-flex baseline alignment for breadcrumb-style multi-segment compositions
          <Text as="div" variant="label" className="flex min-w-0 items-center">
            {resolvedTitle}
          </Text>
        ))}
      <PaneActionsSlot pane={pane} position="left" />
      {hideRightActions ? (
        // eslint-disable-next-line layout/no-adhoc-layout -- explicit flex-grow spacer to push expand/close buttons to far right inside Bar's flex row
        <div className="flex-1" />
      ) : (
        <OverflowActionsBar pane={pane} extraActions={actions} />
      )}
      {chrome.promote && doPromote && (
        <Button variant="ghost" size="sm" onClick={doPromote} aria-label="Promote">
          <MdOpenInFull className="size-4" />
        </Button>
      )}
      {chrome.close && doClose && (
        <Button variant="ghost" size="sm" onClick={doClose} aria-label="Close">
          <MdClose className="size-4" />
        </Button>
      )}
    </Bar>
  }
  body={<ContentScope>{children}</ContentScope>}
/>
```

**Why `className="h-full"` not `fill`?** PaneChrome is rendered inside pane columns sized
with `h-full`, not a flex-fill context. `fill` would emit `min-h-0 flex-1` which is wrong
for an explicit `h-full` host. `h-full` is not banned by `no-adhoc-layout`.

**Remaining per-line disables in helper components:**

`PaneActionsSlot` (line ~154):
```tsx
// eslint-disable-next-line layout/no-adhoc-layout -- horizontal chip row of action contributions inside Bar; Frame needs named slots but this is a dynamic list
<div className="flex items-center gap-xs">
```

`OverflowActionsBar` container (line ~286):
```tsx
// eslint-disable-next-line layout/no-adhoc-layout -- flex-1 measurement container for overflow detection; Row/Frame can't model a right-aligned flex-1 measurement region
<div
  ref={containerRef}
  className="flex min-w-0 flex-1 items-center justify-end gap-xs overflow-hidden whitespace-nowrap"
>
```

`OverflowActionsBar` popover content (line ~309):
```tsx
// eslint-disable-next-line layout/no-adhoc-layout -- flex column of overflow action items inside Popover; Column needs named slots but this is a flat list
<div className="flex flex-col">
```

**Imports:** Add `Column` from column/web.

---

## Burndown list removals (`lint/index.ts`)

Remove these 6 entries from the `ignores["no-adhoc-layout"]` array:

```
"plugins/primitives/plugins/pane/web/components/pane-chrome.tsx",
"plugins/primitives/plugins/tabbed-view/web/internal/define-tabbed-view.tsx",
"plugins/primitives/plugins/data-view/web/components/data-view.tsx",
"plugins/apps/plugins/pages/plugins/page-tree/web/components/pages-sidebar.tsx",
"plugins/apps/plugins/pages/plugins/starred/web/components/favorites-sidebar.tsx",
"plugins/apps/plugins/story/plugins/shell/web/components/story-editor.tsx",
```

---

## Trade-offs and risks

| Surface | Trade-off |
|---------|-----------|
| `define-tabbed-view` | `scrollBody=false` + explicit `<Scroll hideScrollbar>` adds one extra `min-h-0 flex-1` wrapper (harmless double-nesting in flex-col context). Preserves `no-scrollbar` behavior exactly. |
| `data-view` embedded | Column body with `scrollBody=false` emits `min-h-0 flex-1` wrapper even in embedded mode. In an auto-height host, `flex-1` is inert (no remaining space to fill) — behaviorally equivalent. |
| `story-editor` split | `StoryEditorBody` can't migrate to Column (horizontal layout). Per-line disables are the sanctioned escape and travel with the code. |
| `pane-chrome` helpers | `OverflowActionsBar` and `PaneActionsSlot` use horizontal measurement/flex layout that no primitive models. Per-line disables with precise reasons. |

---

## Verification

After implementing, run:
```bash
./equin build         # runs migration checks, rebuilds frontend
./equin check type-check   # runs tsc + ESLint including no-adhoc-layout
```

Visual checks (screenshot or Playwright):
1. Open a task pane — PaneChrome header + scrolling body still works.
2. Open task list (tree / recent tabs) — defineTabbedView tabs switch, content scrolls.
3. Open the Pages app — pages tree scrolls, sidebar sections are correct height.
4. Open Favorites sidebar — favorite pages scroll normally.
5. Open the Story Builder — split/author/render views all display correctly.
6. Open any DataView surface (task list, agents, pages) in surface mode — toolbar +
   scrollable content. Open a DataView in embedded mode (e.g., story sections) — auto-height.

Implementation order: pages-sidebar → favorites-sidebar → tabbed-view → story-editor →
data-view → pane-chrome → lint/index.ts removal.
