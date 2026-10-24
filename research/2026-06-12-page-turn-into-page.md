# Turn into → Page (block actions menu)

## Context

In the Pages app block editor, the drag-handle "block actions" menu offers a
**Turn into** section (convert to text / bulleted-list / to-do / …) and a
**Delete** item. We want to add a **Turn into → Page** action that "collapses"
a block and its entire descendant subtree into a **new sub-page**, using the
block's text content as the page title.

Per the chosen UX (confirmed with the user): the block is **replaced in place by
a clickable `page-link`** pointing at the new sub-page (Notion-style). So after
the action:

- A new sub-page appears in the sidebar tree, nested under the current page.
- The block's children move into that sub-page (they become its content).
- Where the block sat in the body, a clickable "link to page" row remains.

### Why this shape

A `page` block (`type="page"`) is deliberately filtered out of the content
editor (`ne(_blocks.type, PAGE_BLOCK_TYPE)` in `resources.ts` / `handle-list-blocks.ts`)
— sub-pages live only in the sidebar. So we cannot simply `convertTo("page")`
in place: the block would vanish from the body and (if deeply nested) would also
orphan in the sidebar tree because its `parentId` would point at a content block.
Leaving a `page-link` in place sidesteps both problems and matches the requested
UX.

The whole operation composes **existing public editor endpoints** — no new
server code, no DB/schema changes:

1. `createBlock` → new `page` block, `parentId = currentPageId` (→ sub-page of
   the open page; `computePageId` stamps `pageId = currentPageId`).
2. `bulkMoveBlocks` → reparent the block's **direct children** under the new
   page. `handleBulkMoveBlock` already calls `recomputePageIdSubtree` per moved
   root, so each child subtree's `pageId` re-scopes to the new page automatically
   (verified in `handle-bulk-move-block.ts`).
3. `updateBlock` (via `api.convertTo`) → turn the original block into a
   `page-link` whose `data = { pageId: <newPage> }`, keeping its parent + rank
   (so it stays exactly where it was, now as a link).

If the block has **no children**, seed the new page with one empty `text` block
(same reason as `createPageWithSeed`: an empty page has nothing typeable).

## Plugin boundaries (DAG)

The feature spans three plugins, so it lives in a **new dedicated sub-plugin**
that depends on all of them (acyclic):

- `page/editor` — `PAGE_BLOCK_TYPE`, `createBlock`, `childrenOf`, `textOf`,
  `Block`, `useBlockEditor`, `BlockEditorAPI`, and the new menu slot.
- `page/page-link` — `pageLinkBlock` (the replacement block's type + schema).
- `page/text` — `textBlock` (the seed block), mirroring `createPageWithSeed`.

The editor must **not** import `page-link`/`text` (would form a cycle), so the
orchestration cannot live in the editor. The editor only exposes a generic slot;
the new plugin contributes the item and owns the composition. This mirrors the
existing rationale documented in `create-page-with-seed.ts`.

## Changes

### 1. `plugins/page/plugins/editor` — expose an extension point + helper

- **`core/index.ts`**: add `export { textOf } from "./block-ops";` (currently
  internal; needed by the new plugin to derive the title). `childrenOf` is
  already exported.
- **`web/slots.ts`**: add a render slot alongside `Editor.Block`:
  ```ts
  TurnInto: defineRenderSlot<{
    component: ComponentType<{ block: Block; api: BlockEditorAPI; close: () => void }>;
  }>("page.editor.turn-into"),
  ```
  (Mirror `PageTree.RowActions` in `page-tree/web/slots.ts`. Import `Block`
  from `../core`, `BlockEditorAPI` from `./types`.)
- **`web/components/block-actions-menu.tsx`**: accept a new `block: Block` prop;
  render `<Editor.TurnInto.Render>` **inside the "Turn into" section**, right
  after `<BlockTypeList>` and before the hairline separator:
  ```tsx
  <Editor.TurnInto.Render>
    {(a) => <a.component block={block} api={api} close={() => setOpen(false)} />}
  </Editor.TurnInto.Render>
  ```
- **`web/components/block-row.tsx`**: pass `block={block}` to `<BlockActionsMenu>`
  (line ~103). The `block` is already in scope.

### 2. New plugin `plugins/page/plugins/turn-into-page` (web only)

Files:
- `package.json` — standard plugin manifest (copy a sibling like `page-link`).
- `web/index.ts` — barrel; `export default definePlugin(...)` contributing the
  `Editor.TurnInto` item:
  ```ts
  Editor.TurnInto({ id: "page", component: TurnIntoPageItem })
  ```
- `web/components/turn-into-page-item.tsx` — a `<Row icon={<MdDescription/>}>Page</Row>`
  styled to match `BlockTypeList` rows (icon `size-4 text-muted-foreground`,
  `onMouseDown` + `preventDefault`). On select: run the orchestration, then
  `close()`.
- `web/internal/turn-block-into-page.ts` — the orchestration helper:
  ```ts
  async function turnBlockIntoPage({ block, api, pageId, blocks, bulkMove }) {
    const title = textOf(block);
    const childIds = childrenOf(blocks, block.id).map((c) => c.id);
    const page = await fetchEndpoint(createBlock, {}, {
      body: { parentId: pageId, type: PAGE_BLOCK_TYPE, data: { title, icon: null } },
    });
    if (childIds.length > 0) {
      bulkMove({ ids: childIds, parentId: page.id, afterId: null });
    } else {
      await fetchEndpoint(createBlock, {}, {
        body: { parentId: page.id, type: textBlock.type,
                data: textBlock.schema.parse({ text: "" }) },
      });
    }
    api.convertTo(pageLinkBlock.type, pageLinkBlock.schema.parse({ pageId: page.id }));
  }
  ```
  `pageId`, `blocks`, `bulkMove` come from `useBlockEditor()` inside the item
  component (it renders within the editor provider). `bulkMove` moves only the
  **direct** children — their subtrees follow (parentId chain) and `pageId` is
  recomputed server-side per root.
- Register the plugin in `web/src/plugins.ts` (the only place default-export
  plugin imports are allowed).

## Notes / edge cases

- **Title source**: `textOf(block)` returns `data.text` for text-bearing types
  and `""` for void blocks (divider/image) → empty title, acceptable.
- **Ordering**: create the page first (awaited, needed for `page.id`); the
  `bulkMove` + `convertTo` calls then issue in order. Final state converges via
  the live-state push even though they aren't a single transaction (same
  multi-call pattern as `createPageWithSeed`).
- **No server changes**: `handleBulkMoveBlock` already recomputes `pageId`
  subtrees and notifies the source page; `createBlock` notifies the sidebar
  (`pagesLiveResource`) and the source page editor. The converted block's
  `convertTo` notifies the source page so the link renders in place.
- Leave `handle-update-block.ts` untouched — the page-id recompute concern is
  handled by `bulkMove`, not by the in-place `convertTo` (which only flips the
  block to `page-link`, a same-page operation).

## Critical files

- `plugins/page/plugins/editor/web/components/block-actions-menu.tsx` (add slot)
- `plugins/page/plugins/editor/web/components/block-row.tsx` (pass `block`)
- `plugins/page/plugins/editor/web/slots.ts` (new `Editor.TurnInto` slot)
- `plugins/page/plugins/editor/core/index.ts` (export `textOf`)
- `plugins/page/plugins/turn-into-page/**` (new plugin)
- `web/src/plugins.ts` (register new plugin)
- Reference: `plugins/apps/plugins/pages/plugins/page-tree/web/internal/create-page-with-seed.ts`
  (seed pattern + boundary rationale), `handle-bulk-move-block.ts` (recompute).

## Verification

1. `./equin build`, open `http://<worktree>.localhost:9000/pages`.
2. Create a page; add a block with text and a couple of indented children.
3. Hover the block, click the drag handle → **Turn into → Page**.
4. Expect: the block becomes a clickable "link to page" row in the body; a new
   sub-page named after the block's text appears in the sidebar nested under the
   current page; the children are gone from the body.
5. Click the link → opens the new sub-page; its body shows the moved children.
6. Repeat with a **childless** block → new page opens with one empty, typeable
   text block.
7. Scripted check with `e2e/screenshot.mjs` (`--click "Page"`) for before/after.
8. `./equin check` (plugin-boundaries, type-check) must pass.
