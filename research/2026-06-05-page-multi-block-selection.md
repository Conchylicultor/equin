# Multi-block selection & bulk operations for the page editor

## Context

The block-based page editor (`plugins/page/plugins/editor/`) today supports only a
single caret inside one block. Every operation (`makeBlockAPI`) is single-block:
delete, move, duplicate, copy/paste of *several* blocks at once is impossible.
This makes restructuring a document tedious — you can only act on one block per
gesture.

This change adds **multi-block selection** (shift-click, drag-select marquee,
keyboard range) and **bulk operations** on the selection: delete, move/reorder
(drag **and** keyboard), duplicate, and copy/paste — including pasting external
**markdown** (bullets, code fences, nesting) and copying blocks back out as
markdown so they paste into other apps.

The design reuses existing primitives wherever possible (`multi-select`, `tree`,
`rank`) and keeps the collection–consumer separation: the markdown paste/copy
layer is driven by each block type's `markdownPrefixes`/`marker` metadata from the
`Editor.Block` registry, never by naming individual block types.

### Decisions (confirmed with user)

- **Image blocks: full support, no special handling.** Copy/duplicate copies the
  block's `data` (the attachment *pointer*). Attachments are already
  reference-counted: `Attachments.defineLink(_blocks)` creates the many-to-many
  `page_blocks_attachments` join (composite PK `(ownerId, attachmentId)`); the
  image `reconcileDocumentImages` job creates one link row **per block** on every
  `blocksChanged`; the attachments orphan-sweep only unlinks a file when **no**
  link row references it (1h TTL). So a duplicated/pasted image block is
  automatically safe — deleting one block cascades only its own link row.
- **Move: drag + keyboard** (`Alt+Shift+ArrowUp/Down` moves the selection).
- **Paste: internal blocks + external markdown.** Copy writes markdown to
  `text/plain` so blocks paste into other apps.

## Existing architecture (verified)

- **Blocks**: `page_blocks` (`id`, `documentId`, `parentId` self-ref FK
  `ON DELETE CASCADE`, `type`, `data jsonb`, `rank` rankText, `expanded`).
  `tables.ts`.
- **Render**: `BlockEditorInner` (`web/components/block-editor.tsx`) →
  `useResource(blocksResource)` → `rows` (ALL blocks) → `buildTree` →
  `flattenTree` → `flat` (visible only). Renders `flat.map(BlockRow)` in a single
  `<DndContext>` (`@dnd-kit/core`). Single-block drag via `rowAtPointer(y)` +
  `computeDrop(rows, draggedId, zone, targetId)` → `{parentId, rank}` → `move()`.
- **State**: `BlockEditorProvider` (`web/block-editor-context.tsx`) holds
  `focusedBlockId`, `focusHandlesRef`, `flatOrderRef`, `pendingFocusRef`. No
  client-side block cache — `makeBlockAPI` ops fire `fetchEndpoint` and the UI
  updates only when the live resource refetches after `blocksLiveResource.notify`.
- **Keyboard**: per-block Lexical `KeyboardPlugin` (`web/components/keyboard-plugin.tsx`),
  Enter/Backspace/Tab/Arrow at `COMMAND_PRIORITY_HIGH`. `SlashMenuPlugin` sits at
  `CRITICAL` but returns `false` when closed. Has `isAtStart()`/`isAtEnd()`.
- **Endpoints** (`core/endpoints.ts` + `server/internal/handle-*.ts`): create
  (supports `afterId`), update, delete (cascades), move, split, merge, indent,
  outdent. Every mutation: `blocksLiveResource.notify` + `await blocksChanged.emit`.
- **Block metadata**: `BlockHandle` (`core/define-block.ts`) already carries
  `markdownPrefixes`, `marker`, `toggle.field` — reuse for markdown paste/copy.

## Reused primitives

- `multi-select` (`plugins/primitives/plugins/multi-select/web`): `MultiSelectProvider`,
  `useMultiSelect`, `useMultiSelectItem`, `SelectionBar`. Reducer already has
  additive `TOGGLE`, `SELECT_ALL`, `CLEAR_ALL`, `SET_ORDERED_IDS` (prunes stale).
- `tree` (`plugins/primitives/plugins/tree/core`): `buildTree`, `isDescendant`,
  `computeDrop`.
- `rank` (`plugins/primitives/plugins/rank`): `Rank.between/compare/from`,
  server `nextRankUnder`.
- `select-scope` `ContentScope` — scope `Cmd+A` to the editor.

---

## Implementation plan

### Phase 1 — Primitive extensions (foundation)

**`primitives/multi-select` — one new generic action.**
`web/internal/multi-select-context.tsx`: add `{ type: "SET_RANGE"; anchorId; targetId }`
→ `selectedIds` = contiguous slice of `orderedIds` between the two indices
(inclusive, **replace** not merge), `anchorId = anchorId`. No-op if either id is
absent. `web/internal/use-multi-select.ts`: expose `setRange(anchorId, targetId)`.
(We deliberately do **not** add `EXTEND_TO`/`SET_ANCHOR` — anchor lifecycle is
editor-specific and lives as a ref in the editor; additive `TOGGLE` stays untouched
for the tasks/agents list consumers.)

**`primitives/tree` — selection helpers.**
`core/internal/tree.ts` (+ export from `core/index.ts`):
- `selectionRoots<T extends {id;parentId}>(rows, selectedIds): string[]` — selected
  ids none of whose ancestors are selected.
- `subtreeIds<T extends {id;parentId}>(rows, rootId): string[]` — root + descendants.

**`primitives/rank` — N-key generation.**
`core/internal/rank.ts`: add `Rank.nBetween(prev, next, n): Rank[]` wrapping
`generateNKeysBetween` from `fractional-indexing`. **Never** loop `Rank.between`
(unbounded key growth). Export from `rank/core`.

### Phase 2 — Serialized-block contract (editor core)

**`core/serialized-block.ts`** (new, export from `core/index.ts`): recursive
`SerializedBlockSchema` = `{ type: string; data: unknown; expanded: boolean;
children: SerializedBlock[] }` + `SerializedBlock` type. Carries **no ids** (safe
cross-document).

**`core/endpoints.ts`** — add (all document-scoped so the handler notifies the
right doc; bodies via zod, `response` schema required so the client gets data back):
- `bulkDeleteBlocks` — `POST /api/documents/:documentId/blocks/bulk-delete`,
  body `{ ids: string[] }`, response `{ deleted: number }`.
- `bulkMoveBlocks` — `.../bulk-move`, body `{ ids: string[]; parentId: string|null;
  afterId: string|null }`, response `BlockSchema[]`.
- `bulkDuplicateBlocks` — `.../bulk-duplicate`, body `{ ids: string[] }`,
  response `{ rootIds: string[] }`.
- `pasteBlocks` — `.../paste`, body `{ blocks: SerializedBlock[]; afterId: string|null;
  parentId: string|null }`, response `{ rootIds: string[] }`.

### Phase 3 — Server handlers + shared helpers

All handlers: validate → `db.transaction(...)` → mutate → **single**
`blocksLiveResource.notify` + `await blocksChanged.emit` **after commit**. Guard
`ids.length === 0` as a no-op.

- **`server/internal/block-subtree.ts`** (new): `collectBlockSubtrees(tx, rootIds):
  Promise<Block[]>` — recursive CTE over `page_blocks.parent_id`
  (heed the Drizzle CTE-materialization caveat — rely on PG auto-materialization).
  Used for duplicate serialization and the descendant guard.
- **`server/internal/insert-forest.ts`** (new):
  `insertForest(tx, { documentId, parentId, rootRanks: Rank[], forest:
  SerializedBlock[] }): Promise<{ rootIds: string[] }>`. Recursive; ids via
  `crypto.randomUUID()`; child ranks via `Rank.nBetween(null,null,children.length)`.
  No notify/emit. Reused by paste + duplicate.
- **`handle-bulk-delete-block.ts`**: recompute `selectionRoots` server-side from
  `ids`, delete roots (cascade removes descendants).
- **`handle-bulk-move-block.ts`**: fetch destination siblings under `parentId`
  excluding `ids`; **reject** if `parentId` is inside any moved subtree (recursive
  descendant check); `prev`=rank(afterId)|null, `next`=rank of following sibling|null;
  `Rank.nBetween(prev,next,ids.length)`; update parentId+rank per id in given order.
- **`handle-bulk-duplicate-block.ts`**: `collectBlockSubtrees(roots)` → build
  `SerializedBlock[]` forest → for each root insert its clone in place (after the
  root, under the root's own parent) via `insertForest`.
- **`handle-paste-block.ts`**: resolve `parentId`/`afterId` → `rootRanks` via
  `Rank.nBetween` → `insertForest`.
- Register the four routes in **`server/index.ts`** (`httpRoutes`).

### Phase 4 — Editor context plumbing

**`web/block-editor-context.tsx`** — add:
- `setRows(rows)` + `rowsRef` (full block list, for `selectionRoots`/serialize).
- `registerContainerFocus(fn)` / `focusContainer()` (Lexical Escape needs to focus
  the editor container).
- Bulk op fns mirroring `move`/`insert`: `bulkDelete(ids)`, `bulkMove({ids,parentId,
  afterId})`, `bulkDuplicate(ids)`, `paste({blocks,afterId,parentId})` — each
  `fetchEndpoint` to the new endpoints.

**`web/types.ts`** (`BlockEditorAPI`) — add `enterSelectionMode()` (select this
block, blur Lexical, focus container).

### Phase 5 — Selection state, pointer, visuals

**`web/components/block-editor.tsx`** (`BlockEditorInner`):
- Wrap content in `<MultiSelectProvider orderedIds={flat.map(f=>f.block.id)}>` and
  `<ContentScope>`. Call `setRows(rows)`.
- Add a focusable `containerRef` (`tabIndex={-1}`), registered via context.
- **Marquee drag-select**: `onPointerDown` on the container *background only* (bail
  if `target.closest('[contenteditable], button')`) → set editor-local `anchorRef`
  = `rowAtPointer`; `onPointerMove` → `setRange(anchorRef, rowAtPointer)`; render a
  faint rectangle overlay; end on `pointerup`.
- **Bulk DnD**: in `onDragStart`, if `selectedIds.has(draggedId)` resolve
  `selectionRoots` into a ref → bulk mode; `DragOverlay` shows "N blocks". In
  `onDragEnd` (bulk): reject if target ∈ any moved subtree; translate `{targetId,
  zone}` → `{parentId, afterId}` (`after` → `afterId=targetId`; `before` → the
  sibling before target under that parent excluding moved ids, or `null`) → `bulkMove`.
  Non-selection drag keeps the current single-block path.
- Render `<SelectionBar actions={Duplicate / Copy / Delete}>`.

**`web/components/block-row.tsx`**:
- `useMultiSelectItem(block.id)` → selected highlight (ring/bg).
- Shift+click on the row → `setRange(anchorRef ?? focusedBlockId, block.id)`.

### Phase 6 — Keyboard

**`web/components/keyboard-plugin.tsx`** (in-text, Lexical):
- `KEY_ESCAPE_COMMAND` @ HIGH → `editor.enterSelectionMode()` (SlashMenu CRITICAL
  still wins while its menu is open).
- In the existing Arrow handlers, add `event.shiftKey && atBoundary` branch
  (`isAtEnd` for Down, `isAtStart` for Up) → `enterSelectionMode()` + extend toward
  the next/prev block. `preventDefault` + return `true`; when shift is held but
  **not** at boundary, return `false` (normal in-text shift-selection).
- (Keyboard selection entry is only available from text-bearing blocks — image /
  page-link blocks don't mount `KeyboardPlugin`; they're selected via click/marquee.
  Acceptable.)

**Container `onKeyDown`** (selection mode, editor-local — *not* the global shortcuts
registry, since behavior is fully editor-scoped):
- `ArrowUp/Down` → move single head; `Shift+ArrowUp/Down` → `setRange` extend.
- `Alt+Shift+ArrowUp/Down` → `bulkMove` selection one slot up/down (compute the new
  `afterId` among siblings).
- `Escape` → `clearAll`; `Enter` → focus the single selected block to edit.
- `Backspace`/`Delete` → `bulkDelete(selectedIds)` then `clearAll()` (optimistic).
- `Cmd/Ctrl+D` → `bulkDuplicate`; `Cmd/Ctrl+A` → `selectAll`.

### Phase 7 — Clipboard + markdown interop

Use **DOM `onCopy`/`onCut`/`onPaste`** on the focused container (synchronous
`clipboardData.setData/getData` reliably supports arbitrary MIME types — unlike the
async `navigator.clipboard.write([ClipboardItem])`).

- **`core/serialize-blocks.ts`** (new): `serializeForest(rows, rootIds):
  SerializedBlock[]` (from `rows`, includes collapsed children).
- **Copy/Cut**: serialize `selectionRoots` subtrees →
  `setData("application/x-singularity-blocks+json", json)` **and**
  `setData("text/plain", markdown)`. Cut = copy then `bulkDelete`+`clearAll`.
- **`web/markdown-blocks.ts`** (new, registry-driven):
  - `blocksToMarkdown(forest, handles)` — reconstruct markdown using each handle's
    `markdownPrefixes[0]` / `marker` / `toggle.field` and `data.text`; code blocks →
    fenced; nesting → indentation; image → `![](…)` (or skip).
  - `markdownToForest(text, handles)` — map each line to a block type by matching
    `markdownPrefixes` from `Editor.Block.useContributions()` (no hardcoded types);
    fenced ```` ``` ```` → code-block (capture language); leading indentation →
    children; default → text.
- **Paste**: prefer the custom MIME (`pasteBlocks`); else parse `text/plain` via
  `markdownToForest` → `pasteBlocks`. Insert after the focused/last-selected block.
  Cross-document paste works (document-scoped endpoint, ids regenerated).

---

## Critical files

- `plugins/primitives/plugins/multi-select/web/internal/{multi-select-context,use-multi-select}.tsx`
- `plugins/primitives/plugins/tree/core/internal/tree.ts`
- `plugins/primitives/plugins/rank/core/internal/rank.ts`
- `plugins/page/plugins/editor/core/{endpoints,serialized-block,serialize-blocks,index}.ts`
- `plugins/page/plugins/editor/server/internal/{insert-forest,block-subtree,handle-bulk-delete-block,handle-bulk-move-block,handle-bulk-duplicate-block,handle-paste-block}.ts`
- `plugins/page/plugins/editor/server/index.ts`
- `plugins/page/plugins/editor/web/block-editor-context.tsx`, `web/types.ts`
- `plugins/page/plugins/editor/web/components/{block-editor,block-row,keyboard-plugin}.tsx`
- `plugins/page/plugins/editor/web/markdown-blocks.ts`

## Verification

1. `./equin build`; open a Pages doc at `http://<worktree>.localhost:9000`.
2. **Selection**: shift-click a range; marquee-drag on empty area; `Shift+ArrowDown`
   from a text caret at block end; `Esc` to enter selection mode; `Cmd+A`.
3. **Delete**: select 3 nested blocks → Delete → exactly one refetch, no flicker,
   children cascade-removed.
4. **Move**: bulk-drag a multi-root selection to a new spot; `Alt+Shift+Arrow` to
   nudge; confirm dropping a selection into its own descendant is rejected.
   Query ranks (`query_db`): strictly increasing, bounded length (`nBetween`).
5. **Duplicate**: `Cmd+D` a subtree → clone appears in place, structure + `expanded`
   preserved, image block clone shares the attachment (verify two rows in
   `page_blocks_attachments`, file survives deleting one).
6. **Copy/paste**: copy blocks → paste in same doc and a second doc; paste external
   markdown (`- a\n- b`, fenced code, indented nesting) → correct block types; copy
   out → paste into a plain-text editor shows markdown.
7. `./equin check` (boundaries, migrations-in-sync, eslint).
