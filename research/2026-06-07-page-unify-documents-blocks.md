# Unify `page_documents` and `page_blocks` — "a page is a block"

**Date:** 2026-06-07
**Category:** page
**Scope:** Substrate only · Destructive recreate · Clean endpoint reshape

## Context

The `page` plugin currently splits its data across two tables: `page_documents` (the
page, with `title`/`icon`) and `page_blocks` (content within a page, with `type`/`data`).
They share ~80% of their shape (`id`, `parentId`, `rank`, `expanded`, timestamps) — a
document is essentially a degenerate block. The split forces a parallel API surface
(`createDocument`/`createBlock`, two live resources, document-vs-block routes) and makes
"a page" a privileged citizen instead of a uniform node.

This change collapses the two into a single `page_blocks` table where **a page is a block
of `type = "page"`** whose payload (`title`, `icon`) lives in `data` like every other block
type — keeping the table uniform (matches Notion: `properties.title` / `format.page_icon`,
no dedicated title column). This is the substrate the project vision wants: one tree, one
type system, every node a block. It directly unlocks inline sub-pages / pages-as-blocks as
a fast follow, but **this plan intentionally preserves today's UX** (pages live top-level in
the sidebar tree; the content editor shows only non-page blocks). No inline sub-page card
rendering yet — that is the deferred "full Notion behavior" phase.

**Decisions (from the user):**
- **Substrate only** — no inline `page` block renderer; sidebar + PageHeader unchanged in behavior.
- **Destructive recreate** — existing page data is disposable; the migration truncates rather than backfills.
- **Reshape cleanly** — `/api/documents*` → `/api/pages` + `/api/blocks`; document endpoints collapse into block ops with `type="page"`.

## Core model

Single table `page_blocks`:
- `parentId` — self-FK, the one tree (pages and content in the same adjacency list). Root pages: `parentId = null`.
- `pageId` — **denormalized nearest `type="page"` ancestor** (NEW; replaces `documentId`). Used to scope a page's content cheaply and to partition the live resource.
- `type` — `"page"` for pages; existing types for content.
- `data` — page payload is `{ title, icon }`; content payload unchanged.

**The single `pageId` rule** (insert + recompute):
```
computePageId(parent) =
  parent == null            -> null
  parent.type === "page"    -> parent.id
  otherwise                 -> parent.pageId
```
This is correct for both page children (a sub-page's nearest page ancestor is its parent page)
and content children. There is **no existing precedent** in the repo for a maintained
denormalized ancestor pointer — this is a new (small) pattern.

**Two resources stay, as filtered views over one table:**
- `pagesResource` = `WHERE type = 'page'` ordered by rank → sidebar tree (built by `parentId`). Replaces `documentsResource`.
- `blocksLiveResource({ pageId })` = `WHERE pageId = :pageId AND type <> 'page'` → a page's content. Replaces `blocksLiveResource({ documentId })`. The `type <> 'page'` filter is what keeps sub-pages out of the content editor (preserves current UX under substrate-only).

## Phase 1 — Schema + migration

**`plugins/page/plugins/editor/server/internal/tables.ts`**
- Delete `_documents`.
- `_blocks`: drop `documentId`; add `pageId: text("page_id").references(() => _blocks.id, { onDelete: "cascade" })` (nullable self-FK). Keep `parentId` self-FK cascade.
- Replace indexes `page_blocks_doc_parent_rank_idx` / `page_blocks_document_id_idx` with `(pageId, parentId, rank)` and `(pageId)`.

**`plugins/page/plugins/links/server/internal/tables.ts`**
- `page_links.sourceDocumentId` / `targetDocumentId` now `.references(() => _blocks.id, …)` (block→block; semantics: both are `type="page"` blocks). Optionally rename to `sourcePageId` / `targetPageId`.

**`plugins/page/plugins/editor/server/internal/tables-events.ts`**
- `blocksChanged` filter `document_id` → `page_id`; payload `{ documentId }` → `{ pageId }`.

**Migration** (destructive): run `./equin build` to auto-generate the DDL (drop table, drop/add column, re-FK, index swap), then hand-edit the generated `.sql` to prepend a `TRUNCATE page_blocks CASCADE;` so no rows survive with a now-meaningless `pageId = NULL`. Combined DDL+DML in one schema migration is allowed — the `snapshot-chain-intact` check compares the snapshot to `tables.ts` schema, not the SQL statements (precedent: `20260503_090000_..._migrate_category_to_extension.sql`). Re-run `./equin build`; `migrations-in-sync` must pass.

> NEVER run `drizzle-kit generate` or the runner directly — only `./equin build`.

## Phase 2 — Server: helpers, endpoints, resources, jobs

**New helper — `pageId` maintenance** (`editor/server/internal/page-id.ts`):
- `computePageId(parentId)` — one lookup of the parent row, applies the rule above.
- `recomputePageIdSubtree(rootId, tx?)` — raw `WITH RECURSIVE` over `page_blocks.parent_id` (drizzle can't emit recursive CTEs — use `db.execute(sql\`…\`)`, mirror `collect-subtree.ts`). Propagates `pageId` top-down from the moved root. Called after any `parentId` change (`moveBlock`, `bulkMoveBlock`, `indent`/`outdent`, `paste`/`duplicate` into a new parent). For within-page moves `pageId` is unchanged, but recompute is cheap and keeps it unconditional/correct.

**`editor/core/schemas.ts`**
- Delete `DocumentSchema` / `Document`. `BlockSchema`: replace `documentId` with `pageId: z.string().nullable()`.
- Add `PAGE_BLOCK_TYPE = "page"`, `PageDataSchema = z.object({ title: z.string(), icon: z.string().nullable() })`, and `pageData(block): { title, icon }` parse helper (used by web). No `Editor.Block` contribution/renderer — pages aren't rendered inline in substrate-only scope.

**`editor/core/endpoints.ts`** — reshape:
| Old | New |
|---|---|
| `GET /api/documents` `listDocuments` | `GET /api/pages` `listPages` → `Block[]` (type=page) |
| `GET /api/documents/:documentId/blocks` `listBlocks` | `GET /api/pages/:pageId/blocks` `listBlocks` |
| `POST /api/documents` `createDocument` + `POST /api/documents/:documentId/blocks` `createBlock` | `POST /api/blocks` `createBlock` — body `{ parentId?, type, data?, rank?, afterId? }`; server computes `pageId`. Top-level page = `{ parentId: null, type: "page", data: { title, icon } }` |
| `PATCH /api/documents/:id` `updateDocument` | folded into `PATCH /api/blocks/:id` `updateBlock` (`{ type?, data?, expanded? }`) |
| `DELETE /api/documents/:id` `deleteDocument` | folded into `DELETE /api/blocks/:id` `deleteBlock` |
| `getDocument` | drop (read from `pagesResource`) |
| bulk `/api/documents/:documentId/blocks/bulk-*`, `/paste` | `/api/pages/:pageId/blocks/bulk-*`, `/paste` |
| per-block `/api/blocks/:id/{move,split,merge,indent,outdent}` | unchanged routes |

**Handlers** (`editor/server/internal/handle-*.ts`) — rewrite the document handlers away; for every block write path:
- Set `pageId` on insert via `computePageId(parentId)` (create, split, paste/duplicate forest inserts).
- Call `recomputePageIdSubtree` after any `parentId` change.
- Replace `blocksLiveResource.notify({ documentId })` → `.notify({ pageId })`. For moves that change `pageId` (page reparent, cross-page bulk move) notify **both** old and new `pageId`, and `pagesResource.notify()` when a `type="page"` block changes/moves/is created/deleted.
- `blocksChanged.emit({ pageId })` (was `{ documentId }`).
- Delete `handle-create/update/delete/get/list-document.ts`; `listPages` loads `WHERE type='page'`.

**`editor/server/internal/resources.ts`**
- `pagesResource` (key `"page-documents"` → rename `"pages"`): `WHERE type='page' ORDER BY rank`.
- `blocksLiveResource({ pageId })`: `WHERE pageId = :pageId AND type <> 'page' ORDER BY rank`.

**`editor/server/internal/collect-subtree.ts`** — `collectDocumentSubtree` → `collectBlockSubtree(rootId)` over `page_blocks.parent_id` (for the delete hook snapshot).

**`editor/server/internal/document-hooks.ts`** — `DocumentLifecycle.BeforeDelete` → block-scoped delete hook fired from `deleteBlock` when the target is a page subtree (snapshot via `collectBlockSubtree`, re-push affected backlinks after cascade). Keep the generic hook slot.

**Links + image jobs** (already keyed by the event payload):
- `reindex-job` / `reconcile-job`: `event: { pageId }`; `reindexDocument` → `reindexPage(pageId)` scans `WHERE pageId = :pageId` for `page-link` blocks. `Trigger({ on: blocksChanged, … })` wiring unchanged.
- `links/server/internal/resources.ts` `backlinksResource({ pageId })`: join `page_links` → `page_blocks WHERE type='page'`, read `title`/`icon` from `data->>'title'` / `data->>'icon'`. `BacklinkRow` shape (`{ id, title, icon }`) unchanged, so `Backlinks` web component is untouched.

**Barrel** `editor/server/index.ts` — drop `_documents`, `DocumentSchema`/`Document`; export `pagesResource`; routes per the table above.

## Phase 3 — Web consumers (all in `apps/pages/page-tree`, plus page-link)

Read `title`/`icon` from `data` via `pageData(block)`; swap document endpoints for block ops; `documentsResource` → `pagesResource`.

- **`create-page-with-seed.ts`**: `createBlock({ parentId, type: "page", data: { title: "", icon: null }, rank })`, then `createBlock({ parentId: page.id, type: "text", data: { text: "" } })` (server computes `pageId`).
- **`pages-sidebar.tsx`**: `useResource(pagesResource)`; rows read `pageData(node).title/.icon`; rename → `updateBlock({ id, data: { ...current, title: next } })` (merge); expand → `updateBlock({ id, expanded })`; move → `moveBlock({ id, parentId, rank })`.
- **`page-header.tsx`**: title edit → `updateBlock` data merge; icon from `pageData`.
- **`delete-page-action.tsx`**: `deleteBlock({ id })`; descendant count from `pagesResource`.
- **`panes.tsx`**: `pagesResource` find; `<BlockEditor pageId={pageId} />`.
- **`page-link-block.tsx`** (`plugins/page/plugins/page-link/web`): picker + resolved target read from `pagesResource`, `pageData(d).title/.icon`. `pageId` data field unchanged (now references a `type="page"` block id). Navigation unchanged.
- **`editor/web/components/block-editor.tsx`** (`BlockEditor`): prop `documentId` → `pageId`; `useResource(blocksResource, { pageId })`. Renders the same content blocks (query already excludes pages). No new renderer.

## Critical files

- `plugins/page/plugins/editor/server/internal/{tables.ts,resources.ts,tables-events.ts,collect-subtree.ts,document-hooks.ts,page-id.ts(new),handle-*.ts}`
- `plugins/page/plugins/editor/core/{schemas.ts,endpoints.ts}`, `editor/server/index.ts`, `editor/web/components/block-editor.tsx`, `editor/web/slots.ts`
- `plugins/page/plugins/links/server/internal/{tables.ts,resources.ts,reindex-job.ts,reindex.ts}`, `links/server/index.ts`
- `plugins/page/plugins/image/server/internal/{reconcile-job.ts,reconcile.ts}`
- `plugins/page/plugins/page-link/web/components/page-link-block.tsx`
- `plugins/apps/plugins/pages/plugins/page-tree/web/{panes.tsx,internal/create-page-with-seed.ts,components/{pages-sidebar,page-header,delete-page-action}.tsx}`

## Reuse

- `nextRankIn` / `nextRankUnder` / `rankText`, `computeDrop` — unchanged.
- `defineResource` / `Resource.Declare` / `notify({ pageId })` — same primitive, new param key.
- `db.execute(sql\`WITH RECURSIVE …\`)` pattern from `collect-subtree.ts` for `recomputePageIdSubtree`.
- `defineTriggerEvent` filter pattern; `Trigger({ on, do, with: {}, oneShot: false })` wiring unchanged.

## Out of scope (deferred "full Notion" phase)

- `page` `defineBlock` handle + inline renderer contributed to `Editor.Block` (sub-page cards in content flow).
- `BlockEditor` rendering nested `type="page"` blocks inline (would drop the `type <> 'page'` content filter).

## Verification

1. `./equin build` — migration generates, truncate applied, `migrations-in-sync` + `eslint` + `--plugin-boundaries` pass.
2. App at `http://att-1780846008-4jjd.localhost:9000` (Pages app):
   - `bun e2e/screenshot.mjs` — create a page (sidebar), rename it, set/observe icon, add text/to-do/code blocks, reload → content + title/icon persist.
   - Create a nested page under another in the sidebar → appears in tree, does **not** appear inside the parent's content editor (substrate-only invariant).
   - Add a `page-link` block pointing at another page → renders title/icon, navigates; open target's backlinks → source page listed with correct title/icon.
   - Delete a page with children → subtree gone; a page that linked to it shows its backlink removed (delete hook + cascade).
3. `mcp__singularity__query_db` against this worktree: confirm one `page_blocks` table, `page_documents` gone; spot-check `pageId` correctness — content rows have `pageId` = their page's id; page rows have `pageId` = parent page id (or null at root); no `type<>'page'` row with null `pageId`.
4. Move a block within a page (drag reorder, indent/outdent) → `pageId` unchanged; move a page in the sidebar tree → its `pageId` updates to the new parent page, its content keeps `pageId` = the page id.
