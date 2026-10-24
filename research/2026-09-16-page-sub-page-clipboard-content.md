# Cut / copy / paste / duplicate of a sub-page carries its content

## Context

The user cut a sub-page ("[Planned] Chord trainer app") with Ctrl+X and pasted
it into another page. The pasted page was empty. The original, with its 36
blocks, went to the trash.

Cause: a sub-page's content is stored in its own partition (`page_id = <sub-page
id>`). The editor only loads the rows of the page on screen. So
`serializeForest` (`editor/web/serialize-blocks.ts`) turns a sub-page into a
title-only node with `children: []`. Paste then mints a new, empty page from
that node. Duplicating a sub-page has the same bug, because it goes through the
same serializer.

The behaviour we want (user decision, 2026-09-16, same as Notion):

- **Cut, then paste** moves the original page. It keeps its id, so its URL,
  backlinks, history and nested sub-pages all come along.
- **Copy then paste, a second paste of the same cut, and Duplicate** each make a
  deep copy: new ids, all content included, nested sub-pages copied too.

## Design

### 1. A page node says where it came from (`core/serialized-block.ts`)

`SerializedBlock` / `IdentifiedBlock` get an optional, schema-declared field.
It sits next to `ref`, and like `ref` the pure reducer ignores it:

```ts
origin?: { kind: "copy"; pageId: string } | { kind: "cut"; pageId: string; cutId: string };
```

- `serializeForest` stamps `{kind:"copy", pageId: block.id}` on every
  `type="page"` node.
- Cut sites (`block-editor.tsx` `onCut`, `BlockForestCopyPlugin` `CUT_COMMAND`)
  pass `gesture: "cut"` to `writeForestToClipboard`, which rewrites page nodes
  to `{kind:"cut", pageId, cutId}`. `cutId` is one nonce for the whole gesture.
- Both schemas declare the field. Zod strips undeclared keys, so without this
  it would never reach the server.

### 2. The client decides move vs copy when the paste happens (`web/block-editor-context.tsx` `paste`)

The optimistic overlay needs the client and the server to agree on every row
id. So the decision is made once, on the client, before dispatch.

- A new `withPasteIds(forest)` sits beside `withMintedIds` (which stays
  unconditional for everything else). It has one exception: a `cut` node whose
  `cutId` has not been consumed keeps `id = origin.pageId`. Every other node is
  minted, and its origin becomes `copy`.
- Consumed cut ids live in a small localStorage-backed set (try/catch, bounded
  in size), so a second paste in any tab makes a copy. The first paste marks the
  id as consumed.
- Duplicate (`bulkDuplicate`) keeps `withMintedIds`. Its page nodes carry `copy`
  origins, so it deep-copies.

### 3. The server executes it (`server/internal/handle-apply-block-op.ts`, `paste` / `duplicate`)

**Move ("reclaim")**, for a node with `id === origin.pageId`:

- Prelude, outside the lock: read row S. Resolve its trash entry and the page
  partitions under S (S plus any nested pages). Add them to the lock set, so the
  handler runs `withPageForest([destPage, ...])` the way `handle-move-block.ts`
  already does.
- Inside the lock, re-read S. **As built:** if S is live somewhere else (the
  cut was undone, or it was restored from the trash), the paste moves it from
  there. The client already rendered the paste under S's id, so refusing would
  leave the paste stuck on an error. A 409 is kept only for moving S into its
  own content. A purged S is simply created fresh under that id.
- New writer capability in `forest-writer.ts`, "reclaim a trashed subtree". For
  S's subtree only (S and every row in its partitions), clear
  `deleted_at`/`trash_entry_id`. Then UPDATE S's `parent_id`, `page_id`, `rank`
  and `expanded` from the reducer's planned node, instead of INSERTing it. If
  the entry has no rows left, consume it. If rows remain (a cut of
  `[paragraph, page]` puts the paragraph into the page's entry, per
  `deleteBlocksSubtree`'s partitioning), the entry stays for them.
- The restore primitives are factored out of `untrashBlocks`
  (`trash-blocks.ts`): clearing the row flags, consuming the entry, and the
  after-commit `OnRestore` hooks. `untrashBlocks` also repairs the old slot; the
  paste places the row itself, so it skips that.
- This works the same way for a page nested under a cut toggle. The toggle is
  re-minted, and S reclaims into it.

**Deep copy**, for a node with a `copy` origin and a fresh id N, in the same
transaction, after the forest write:

- Read S's live content, recursively through nested sub-pages. Mint new ids for
  every row, and new page ids for nested pages (their content re-keyed to
  match). Insert the rows. This is allowed by the rule that
  `applyPageBlockPatch`'s closed-world guard already states: a write may create
  rows in a page partition that the same write creates.
- Text comes from the block's `page_block_docs` state when there is one, read
  with the server's existing doc→runs reader. Otherwise it comes from
  `data.text`, which is the projection and can lag by about a second. New rows
  seed their Yjs docs from `data.text`, as every paste does.
- Side tables keyed by block id are copied through a new `BlockLifecycle.OnCopy`
  hook, run in the transaction. `editor-collab` copies the Yjs doc, which makes
  the text exact without reading the projection. `authorship` copies which
  conversations wrote the block, so an agent page's creator chip survives a
  copy. Not copied: origin marker, star, todo-task binding. The
  derived ones (`page_links`, attachments, reminders) rebuild on the
  `blocksChanged` that `notifyStructuralChange` already fires per
  `createdPageIds`. Nested page ids have to be added to that list.
- If S is gone (purged), the copy is an empty page with the title, and a warning
  is logged. That is still a valid copy.

### 4. Undo

These need no new mechanism, but must be verified.

- Undo of a move-paste is a patch that deletes S in the destination page, so S
  is trashed again. Undoing the cut after that restores S to its old spot. Redo
  of the paste is a create of S, which the patch prelude (`restoreEntryById`)
  brings back.
- Undo of a copy-paste trashes N and its copied content.

## Out of scope / follow-ups

- Reminder tokens `[[reminder:<id>:…]]` inside copied text keep the same token
  id, which is the `page_reminders` primary key. Ordinary block copy/paste
  already has this problem. File it as a task and don't fix it here.
- A cut shared between different browsers or devices falls back to the server's
  409, then a copy.

## Critical files

- `plugins/page/plugins/editor/core/serialized-block.ts`: `origin`, `withPasteIds`
- `plugins/page/plugins/editor/web/serialize-blocks.ts`, `web/internal/clipboard-write.ts`,
  `web/components/block-editor.tsx`, `web/components/block-forest-copy-plugin.tsx`
- `plugins/page/plugins/editor/web/block-editor-context.tsx`: `paste`, consumed-cut store, 409 toast
- `plugins/page/plugins/editor/server/internal/handle-apply-block-op.ts`: lock set, reclaim, copy
- `plugins/page/plugins/editor/server/internal/forest-writer.ts`: reclaim-subtree write
- `plugins/page/plugins/editor/server/internal/trash-blocks.ts`: factor out untrash primitives
- New `server/internal/copy-page-content.ts`: recursive content clone
- `plugins/page/plugins/editor/CLAUDE.md`: document the clipboard page-origin rule

## Verification

- Unit (`./equin test plugins/page/plugins/editor`):
  - `serializeForest` stamps `copy` origins.
  - `withPasteIds`: an unconsumed cut keeps its id; a consumed cut or a copy mints.
  - DB-backed handler tests (the `db-test-fixture`):
    1. Cut and paste a page with nested content and a nested sub-page, across
       pages. The id is the same, all rows are live, the trash entry is
       consumed, and the old page no longer lists it.
    2. The same when the cut also held a paragraph. The paragraph's rows stay
       trashed.
    3. Copy-paste: new ids, content equal, nested page copied, source untouched.
    4. Reclaiming a live S returns 409.
    5. Duplicate of a sub-page makes a deep copy.
- E2E: extend `e2e/copy-paste-verify.ts` with a sub-page cut→paste into another
  page. Open the pasted page and see its content at the same URL. Paste again
  and get a copy with content. Undo each step. Extend `e2e/duplicate-verify.ts`
  with duplicating a sub-page.
- `./equin build`, then repeat the user's gesture by hand on the worktree
  deploy.
