# Page editor — block creation affordances

## Context

The block-based page editor (`plugins/page/plugins/editor`) can render and reorder
blocks, but the only way to *create* a block is pressing **Enter** to split a text
block, and the only type picker is the bottom-of-document **Add block** menu. There
is no way to:

- insert a block inline (a Notion-style **`/` slash menu** or a gutter **`+`** button),
- **turn an existing block into another type**,
- see a **placeholder prompt** in an empty block.

This plan adds those four affordances. The server already supports everything we need
for conversion (`PATCH /api/blocks/:id` applies both `type` and `data` —
`handle-update-block.ts:12-13`); the only server change is letting `createBlock`
position a new block *after* an existing one.

### Decisions (confirmed with user)

- **Slash menu:** inline-filter, Notion-style — focus stays in the editor, the `/query`
  text drives the menu, arrows/Enter navigate, the text is stripped on select.
- **Turn-into:** lives in a **block-actions menu** opened by clicking the existing
  gutter drag handle (drag still reorders; a click without drag opens the menu).
- **Scope:** affordances only — wire against the existing `text` and `page-link`
  block types. No new block types.

## Architecture notes (from exploration)

- Block types are registered via the `Editor.Block` **dispatch slot**
  (`editor/web/slots.ts`), keyed by `block.type`. Each contribution carries a
  `BlockHandle` (`block.type`, `label?`, `icon?`, `empty?`) — `editor/core/define-block.ts`.
- Insertable types = `Editor.Block.useContributions().map(c => c.block).filter(b => b.label)`
  (exactly what `add-block-menu.tsx` does today).
- Per-block actions go through `BlockEditorAPI` (`editor/web/types.ts`), implemented in
  `makeBlockAPI` (`editor/web/block-editor-context.tsx`). Focus-after-mutation uses the
  `pendingFocusRef` + `registerFocusHandle` pattern.
- Rank is fractional-indexing (`@plugins/primitives/plugins/rank`). The split handler
  already computes "rank between this block and its next sibling"
  (`handle-split-block.ts:31-51`) — the same logic we need for "insert after".
- Text blocks own their Lexical instance; keyboard handling is in the `text` plugin's
  `KeyboardPlugin` (`text/web/components/keyboard-plugin.tsx`). The `text` plugin already
  imports from `@plugins/page/plugins/editor/web`, so it may consume new editor exports.

## Design

Reusable decomposition (all in `editor/web`, exported from its barrel) so the slash
menu, the `+` button, the turn-into menu, and the bottom Add-block menu share one
implementation of "list of block types + filter + row rendering":

- **`useInsertableBlocks()`** — hook returning the insertable `BlockHandle[]`.
- **`filterBlockTypes(handles, query)`** — substring match on `label` (tiny list).
- **`BlockTypeList`** — presentational rows (icon + label, active-row highlight),
  props: `blocks`, `activeIndex`, `onSelect(handle)`, `onHoverIndex`.
- **`BlockTypeMenu`** — uncontrolled popover wrapper: `InlinePopover` trigger +
  `SearchInput` + arrow/Enter/Esc nav, renders `BlockTypeList`. Used by the `+` gutter
  button and the (refactored) bottom Add-block menu.

The **slash menu** does *not* use `BlockTypeMenu` (it needs focus to stay in the editor),
but reuses `useInsertableBlocks` + `filterBlockTypes` + `BlockTypeList`.

### 1. Server — "insert after" (`editor`)

- `editor/core/endpoints.ts` — add `afterId: z.string().optional()` to `CreateBlockBodySchema`.
- `editor/server/internal/handle-create-block.ts` — when `body.afterId` is set, load that
  block; set `parentId = after.parentId` and `rank = Rank.between(after.rank, nextSibling.rank ?? null)`
  using the same next-sibling query as `handle-split-block.ts:31-51`. (No DB/schema change → no migration.)

### 2. Editor API — `convertTo` + `insertAfter` (`editor`)

- `editor/web/types.ts` — extend `BlockEditorAPI`:
  - `convertTo(type: string, data: unknown): void`
  - `insertAfter(type: string, data: unknown): void`
- `editor/web/block-editor-context.tsx` — implement in `makeBlockAPI` (add `documentId` to its deps):
  - `convertTo` → `fetchEndpoint(updateBlock, { id: blockId }, { body: { type, data } })`.
  - `insertAfter` → `createBlock` with `{ type, data, afterId: blockId }`, then focus the
    created block via the existing `pendingFocusRef` pattern.

### 3. Shared block-type UI (`editor`)

- New `editor/web/components/block-type-list.tsx` (`BlockTypeList`).
- New `editor/web/components/block-type-menu.tsx` (`BlockTypeMenu`) — `InlinePopover` +
  `SearchInput` (`@plugins/primitives/plugins/search/web`) + `useTextFilter` (or
  `filterBlockTypes`) + activeIndex keyboard nav (pattern from the command-palette dialog).
- Refactor `editor/web/components/add-block-menu.tsx` to render `BlockTypeMenu` (calls
  `insert(type, empty())` on select — unchanged behavior).
- Export `useInsertableBlocks`, `filterBlockTypes`, `BlockTypeList`, `BlockTypeMenu` from
  `editor/web/index.ts`.

### 4. Gutter `+` button + block-actions menu (`editor`)

In `editor/web/components/block-row.tsx`:

- Add a **`+`** `IconButton`/button in the gutter (left of the drag handle, e.g.
  `left: depth*INDENT - 40`, both `opacity-0 group-hover/row:opacity-60`). It opens a
  `BlockTypeMenu`; on select → `api.insertAfter(type, block.empty?.() ?? {})`.
- Make the **drag handle** also clickable: add `onClick` opening a new
  **`BlockActionsMenu`** popover. dnd-kit `PointerSensor` uses `activationConstraint
  distance: 4` (`block-editor.tsx:103`), so a click without movement won't start a drag.
- New `editor/web/components/block-actions-menu.tsx` (`BlockActionsMenu`): an
  `InlinePopover` listing a **Turn into** section (`BlockTypeList` → `api.convertTo(type, empty())`)
  and a **Delete** item (`api.remove()`).

### 5. Slash menu + placeholder (`text`)

In the `text` plugin (consumes editor exports):

- **Placeholder:** pass a `placeholder` to `PlainTextPlugin` in `text-block.tsx`, shown when
  the block is empty and focused (`isFocused` from `BlockRendererProps`): *"Type '/' for commands"*.
  (Verify the installed `@lexical/react` `PlainTextPlugin` placeholder prop signature.)
- **New `text/web/components/slash-menu-plugin.tsx`** — a Lexical plugin (sibling of
  `KeyboardPlugin`) that:
  - derives open-state + `query` from the block text: active when text starts with `/`
    (query = text after `/`); a `dismissed` ref (set on Esc) suppresses until the `/`-prefix
    is removed. (Mid-line `/` is out of scope — note as a limitation.)
  - renders a floating, block-anchored dropdown (absolute, `top-full left-0`, inside a
    `relative` wrapper around `ContentEditable`) containing
    `BlockTypeList` over `filterBlockTypes(useInsertableBlocks(), query)`. Menu items use
    `onMouseDown` + `preventDefault` so clicking doesn't blur the editor first.
  - registers Lexical commands at `COMMAND_PRIORITY_CRITICAL` (above `KeyboardPlugin`'s
    `HIGH`) for ArrowUp/ArrowDown/Enter/Escape that act on the menu **only when open**
    (otherwise return `false` so split/focus-nav still work).
  - **on select:** if `type === block.type` → clear the `/query` text (set field/editor to `""`);
    else → `editor.convertTo(type, handle.empty?.() ?? {})` (which replaces `data`, dropping
    the `/query`). Close menu.
- Wire `SlashMenuPlugin` into `text-block.tsx` inside a `relative` wrapper; it needs the
  `editor` (`BlockEditorAPI`) and `block` props.

## Critical files

| File | Change |
|---|---|
| `editor/core/endpoints.ts` | `afterId?` on `CreateBlockBodySchema` |
| `editor/server/internal/handle-create-block.ts` | honor `afterId` (rank between sibling) |
| `editor/web/types.ts` | `BlockEditorAPI.convertTo`, `.insertAfter` |
| `editor/web/block-editor-context.tsx` | implement `convertTo`, `insertAfter` |
| `editor/web/components/block-type-list.tsx` | **new** presentational list |
| `editor/web/components/block-type-menu.tsx` | **new** popover wrapper |
| `editor/web/components/block-actions-menu.tsx` | **new** turn-into / delete |
| `editor/web/components/add-block-menu.tsx` | refactor onto `BlockTypeMenu` |
| `editor/web/components/block-row.tsx` | gutter `+` + clickable handle menu |
| `editor/web/index.ts` | export new shared symbols |
| `text/web/components/text-block.tsx` | placeholder + mount slash plugin |
| `text/web/components/slash-menu-plugin.tsx` | **new** inline slash menu |

## Reused primitives

- `InlinePopover` — `@plugins/primitives/plugins/popover/web`
- `SearchInput`, `useTextFilter` — `@plugins/primitives/plugins/search/web`
- `IconButton` — `@plugins/primitives/plugins/icon-button/web`
- `Rank` (`Rank.between`) — `@plugins/primitives/plugins/rank/{core,server}`
- `Editor.Block.useContributions()`, `BlockHandle`, `BlockEditorAPI` — editor plugin
- react-icons/md (`MdAdd`, `MdDragIndicator`, `MdDelete`, `MdSwapHoriz`, …)

## Verification

1. `./equin build` (regenerates nothing DB-wise; confirm no new migration is produced).
2. `./equin check` — boundaries, lint, docs-in-sync.
3. Open the Pages app: `http://<worktree>.localhost:9000/pages` (create/select a page), or the
   page debug pane.
4. Manual / scripted (`bun e2e/screenshot.mjs`) checks:
   - Empty focused block shows *"Type '/' for commands"*.
   - Typing `/` opens the menu; typing filters it; ArrowUp/Down move selection; Enter selects;
     Esc closes leaving the text; selecting converts the block (e.g. text → Link to page) and
     strips the `/query`.
   - Hovering a row shows the gutter `+`; clicking it + selecting a type inserts a new block
     **immediately below** (correct rank/position) and focuses it.
   - Clicking the drag handle (no drag) opens the actions menu; **Turn into** converts the
     block; **Delete** removes it. Dragging the handle still reorders.
   - Bottom **Add block** still works (refactored path).
```
