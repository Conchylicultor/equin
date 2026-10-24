# Open any block as a page

## Context

An agent called `read_page` on a TODO card (`block-956d…`, inside the page
"Plugin system"). The conversation's **Artifacts** button did not show it
usefully. The page kind only knows pages: a block id is looked up in the pages
list, isn't found, and the row is greyed out with a "not in this instance"
message. A content block has no view of its own to open anyway. The editor can
show a whole page, but not part of one.

What we want:

1. A way to open any block (a card, a heading with its nested lines, a toggle)
   as a page of its own, showing just that block and what's nested under it.
   It stays **editable**, and edits save to the original page. The user chose
   this over a read-only view.
2. An **Open as page** item in the block's ⋮⋮ menu.
3. The Artifacts panel lists such blocks as real rows. Clicking one opens that
   view.

## Design

### 1. Editor: `rootId` (editable zoom) — `plugins/page/plugins/editor`

`BlockEditor`'s persistent arm gets `rootId?: string`, and so does the memory
arm, for tests. The value is threaded through `BlockEditorProvider` →
`CompositeServerProviderHost` → `BlockEditorProviderInner`, and exposed on the
context as
`scope: { rootId: string | null; contentParentId: string /* rootId ?? pageId */ }`.

**Data stays whole, the view is scoped.**
- The store, endpoints and reducer are unchanged. They still work on the full
  page, so the client's predicted forest matches the server's.
- `BlockEditorInner` builds a flat list from the zoomed subtree:
  `flattenVisible(rootId ? subtreeOf(tree, rootId) : tree)`. The root block
  renders at depth 0.
- `setRows` keeps the FULL page rows. `setFlatOrder` gets the scoped list.
  Arrow keys, Cmd+A and crossing to `caretBefore`/`caretAfter` are then scoped
  for free.
- If the root is missing once the rows have loaded (deleted, or moved to
  another page), the view shows a "this block no longer exists" empty state.

**Structural backstop: an admission rule.** New pure file
`web/internal/zoom-scope.ts` with `scopeAdmits(before, after, rootId)`. It
refuses a write when any of these is true:
- the root's parent or rank changes;
- a block that was inside the subtree ends up outside it;
- a new block lands outside it;
- any block outside the subtree changes.

It is checked at every structural write: `dispatchOp`, `applyOverlay`, the
mounted-merge dispatch and `commitRows`. It runs next to the existing
`written.length === 0` refusal. Undo/redo patches are exempt, because they
restore states that were already recorded. `admits(op)` (predict, then check)
is exposed on the context for affordances to use. With this in place,
"escape the zoom" can't happen from anywhere, including op kinds added later.

**Mapping gestures to in-scope ops** (the UX layer on top of the backstop):
- Top-level inserts use `scope.contentParentId` instead of `pageId`. This
  applies to `insert`, `insertFirst` and the paste default in
  `block-editor-context.tsx`. It fixes:
  - clicking the empty space below: the new block becomes the root's last child;
  - external drop;
  - top-level paste;
  - `insertFirst`: the new block becomes the root's first child.
- A paste, a rail `+` or an `insertAfter` whose anchor is the root becomes
  "first child of the root".
- Dragging relative to the root:
  - "before the root" is refused;
  - "after the root" becomes its first child;
  - the root has no drag handle;
  - the root is stripped from bulk drags.
- Keystroke resolver (`internal/keystroke-intent.ts`). `IntentContext` gets
  `scopeRootId`, and `nodes` is the scoped projection (root's
  `parentId := null`). `isIndented` treats the root's children as top level.
  As a result:
  - Backspace at the root's start does nothing;
  - Backspace on its first child merges into the root line;
  - Delete at the end of the last line doesn't reach outside the view;
  - Shift+Tab on a root child is not offered;
  - Enter on the root splits with `asChild` (the tail becomes its first child).
- Selection bar: `indentable` and `outdentable` also check `admits`. A
  selection delete that includes the root clears the root's children instead
  of deleting the root.
- The root's own ⋮⋮ menu hides the moves it can't make: indent, outdent, move,
  unwrap, duplicate and wrap. A plain type conversion is fine, since the id is
  kept.

### 2. Pane: `blockDetailPane` — `plugins/apps/plugins/pages/plugins/page-tree`

- New route `blockDetailRoute = defineRoute({ id: "block-detail", segment: "block/:blockId" })`
  in `core/routes.ts`, and `blockDetailPane` next to `pageDetailPane` in
  `web/panes.tsx`.
- `getBlockPage` (`page/editor/core/endpoints.ts` + `handle-get-block-page.ts`)
  also returns the block's `type` on its found arm, so the view can name the
  block before its page loads.
- The pane resolves the block with `getBlockPage`:
  - not found → the pane's not-found state;
  - the id is itself a page → renders the ordinary page body;
  - otherwise → the body below.
- Body:
  - `PaneChrome` title: the page's `PageBreadcrumb`, plus a trailing crumb for
    the block. The crumb uses the block type's label from the block-handle
    registry, e.g. "TODO", or the block's text when it has any.
  - `<BlockEditor pageId={pageId} rootId={blockId} />` on the same reading
    measure.
  - No cover and no title header.
  - The same `PageNavigationProvider` wiring as the page pane.
- Shared piece: the page body's navigation `useMemo` and layout constants are
  pulled into one helper, so the two panes can't drift.

### 3. Navigation seam — `plugins/page/plugins/page-reference`

`PageNavigation` gets `openBlock?(blockId: string): void`. It's optional, like
`openAside`: a host that has nowhere to put a block view shows no affordance.
`pageDetailPane` and `blockDetailPane` both supply it, using `push` to open
beside the current column.

### 4. Block menu item — new slot + new plugin

- `Editor.BlockMenuItem = defineRenderSlot<{ component: ComponentType<{ block; close }> }>()`
  in `page/editor/web/slots.ts`. `BlockActionsMenu` renders it in the last
  section, ahead of Copy block ID, in both arms (ordinary and container). It's
  gated on `serverSync`, the same way `TurnInto` is. Copy block ID stays
  hard-coded.
- New plugin `plugins/page/plugins/open-as-page`. It contributes
  `Editor.BlockMenuItem({ id: "open-as-page", component })`, an
  **Open as page** row that calls `usePageNavigation()?.openBlock(block.id)`.
  The row is hidden when:
  - the host has no `openBlock`;
  - the block is a `page` row (those already open);
  - the block is the current zoom root (`scope.rootId`).

### 5. One resolver for "open this block id" — page-tree web

`useBlockTarget(blockId)` answers one of:
- `pending`
- `missing`
- `{ kind: "page", pageId }`
- `{ kind: "block", pageId, blockId, type }`

It checks `pagesResource` first and falls back to `getBlockPage` on a miss,
which is the tiering the page-link chip already uses. `useOpenBlockTarget()`
opens the right pane.

It has two consumers:
- **Artifacts page section**
  (`conversations/…/artifacts/plugins/page/web/components/page-section.tsx`).
  Each row resolves its key through `useBlockTarget`. A block row is titled
  with its page's title and the block's type label ("Plugin system › TODO"),
  and opens `blockDetailPane` with `push`. Only a truly `missing` id stays
  inert. The row is a small per-item component, so each row can call the hook.
  The "Known seam" note in `extract.ts` and the plugin's CLAUDE.md are updated.
- **Page-link chip** (`active-data/plugins/page-link`). A content-block id now
  opens the block view instead of the whole page. It swaps its inline two-tier
  lookup for the shared hook.

## Critical files

- `plugins/page/plugins/editor/web/block-editor-context.tsx`,
  `web/components/block-editor.tsx`, `web/internal/keystroke-intent.ts`,
  `web/internal/flatten-blocks.ts`, new `web/internal/zoom-scope.ts`,
  `web/components/block-actions-menu.tsx`, `web/slots.ts`
- `plugins/page/plugins/editor/core/endpoints.ts`,
  `server/internal/handle-get-block-page.ts`
- `plugins/page/plugins/page-reference/web/internal/navigation.tsx`
- new `plugins/page/plugins/open-as-page/`
- `plugins/apps/plugins/pages/plugins/page-tree/{core/routes.ts,web/panes.tsx}`
  and a new `web/internal/block-target.ts`
- `plugins/conversations/plugins/conversation-view/plugins/artifacts/plugins/page/web/*`
- `plugins/active-data/plugins/page-link/web/components/page-link-chip.tsx`

## Verification

- Unit tests, run with `./equin test plugins/page/plugins/editor`:
  - `subtreeOf` flatten cases, plus a fuzz check that the subtree's flat list
    equals the matching run of the full flatten;
  - `zoom-scope.test.ts`, one case per op kind: an admitted op never shrinks
    the subtree;
  - `keystroke-intent.test.ts` with `scopeRootId`: Enter on the root, Backspace
    at the root and at its first child, Delete at the end, Shift+Tab;
  - a zoomed memory-editor test: empty-click insert, `insertFirst`, top-level
    paste, and the gone state after deleting the root.
- The artifacts `extract.test.ts` stays green, plus a section test for block
  rows if a jsdom harness exists there.
- `./equin build`, then screenshot `--path /block/<id>` for a TODO card
  in the worktree DB. Then click the ⋮⋮ menu → **Open as page** on a page, and
  check that a column opens beside it showing only that block, and that an
  edit there shows up on the full page.
- Open this conversation's Artifacts popover. The "Plugin system › TODO" row is
  live and opens the block view.
