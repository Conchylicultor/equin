# Trash / soft-delete primitive + Pages adoption

> **Amended (2026-09-10)** by
> [`2026-09-09-page-data-based-text-undo-entries-v2.md`](./2026-09-09-page-data-based-text-undo-entries-v2.md)
> §3: **every** block delete is a trash. The "page-free subtree stays a hard
> delete" branch this doc keeps is gone — a page-free delete set is trashed
> inline under one `page-blocks` entry, the ledger invariant (entry ⇔ rows) is
> backed by a CHECK on `page_blocks`, and `untrashBlocks` consumes its own
> entry. Read the v2 plan for the current policy; the audit table below is
> historical.

## Context

On July 10 a block-selection delete in the "Website" page destroyed the full content of two
sub-pages ("Agent manager", "Plugin system"). Root cause chain:

1. The delete handlers delete only the **root** rows; `page_blocks`' self-referential FKs
   (`parent_id` AND `page_id`, both `ON DELETE CASCADE`) silently destroy each sub-page's whole
   content subtree plus its `page_block_docs` CRDT text.
2. The pages-history `BlockLifecycle.BeforeDelete` hook explicitly ran
   `deleteVersions("pages", …)` in the same operation — destroying the safety net.
3. Cmd+Z restored only the shell rows: the client undo diff (`diffBlocks` over page-scoped
   `rowsRef`) is structurally blind to cross-`page_id` content.

Fix direction (user-approved): a generic **trash** soft-delete primitive
(`plugins/infra/plugins/trash/`) + convert the pages surface in this pass. A soft delete is an
`UPDATE SET deleted_at` — FK cascades never fire, so descendants, CRDT docs, side-tables, and
history all survive; restore = clearing the flag. Hard delete happens only at **purge** (30-day
grace expired), where the cascade firing is intended.

Decisions:
- **Scope:** primitive + pages now. No repo-wide enforcement check, no follow-up task filing;
  instead an audit table (bottom) classifies the other hard-delete surfaces.
- **Purge:** 30 days, nightly, per-worktree (via `defineRetention`).
- **UI:** Trash pane in the Pages sidebar; Cmd+Z after a delete restores the full subtree.

## The chokepoint policy

> A block-delete whose cascade set contains any `type="page"` block is **trashed**.
> A page-free delete set stays a **hard delete** (today's behavior).

Rationale: same-page content deletes are already fully covered by client undo (the undo patch
carries the complete rows) *and* by page version history; trashing every paragraph merge would
create massive trash churn and break the CRDT split/merge machinery that relies on the
`page_block_docs` FK cascade. The data-loss class is exactly "cascade crosses the client's
visibility boundary" — which only `type="page"` rows do. Pages had **no** durable net (history
was deleted with them); now they get trash.

---

## Phase 1 — `plugins/infra/plugins/trash/` (new plugin)

Barrels `core/index.ts` + `server/index.ts`; internals under `server/internal/`. Registration is
automatic via `./equin build` codegen (never author `id`).

### 1a. `server/internal/tables.ts` — operation ledger

```ts
export const _trashEntries = pgTable("trash_entries", {
  id: text("id").primaryKey(),                    // crypto.randomUUID()
  sourceId: text("source_id").notNull(),          // e.g. "pages"
  rootEntityId: text("root_entity_id").notNull(), // the trashed root (a page id)
  label: text("label").notNull(),                 // display label captured at trash time
  deletedAt: timestamp("deleted_at", { withTimezone: true }).defaultNow().notNull(),
  meta: jsonb("meta").notNull().default({}),
}, (t) => [index("trash_entries_source_deleted_idx").on(t.sourceId, t.deletedAt)]);
```

One row per trashed **root** (a bulk delete of two sub-pages = two independently-restorable
entries). No FKs — mirror of `entity_versions`' deliberate decoupling.

### 1b. `server/internal/registry.ts` — `defineTrashSource`

Mirror `defineHistorySource` (`plugins/history/plugins/engine/server/internal/registry.ts`):
module-level `Map`, `Registration` consumed in the plugin's `register()` phase.

```ts
export interface TrashSource {
  id: string;
  restore: (entry: TrashEntry) => Promise<void>;   // clear domain deleted_at flags
  purge: (entries: TrashEntry[]) => Promise<void>; // run destroy hooks + hard-delete roots
}
export function defineTrashSource(source: TrashSource): TrashSource & Registration;
export function getTrashSource(id: string): TrashSource | undefined;
```

### 1c. `server/internal/record-entry.ts`

`recordTrashEntry(tx, { sourceId, rootEntityId, label, meta? }): Promise<string>` — called by the
domain **inside the same tx** as its `deleted_at` UPDATE so ledger and flags cannot disagree.

### 1d. Endpoints (`core/endpoints.ts` via `defineEndpoint`, `server/` via `implement()`)

- `GET  /api/trash/:sourceId` → `TrashEntry[]`
- `POST /api/trash/:sourceId/:entryId/restore` → looks up entry (**`HttpError(404)` if gone** —
  failure is a type, never a silent no-op), calls `source.restore(entry)`, deletes the entry row.
- `POST /api/trash/:sourceId/:entryId/purge` → same shape, calls `source.purge([entry])`.
- Unknown `sourceId` in the registry = loud throw (config error), not 404.

### 1e. Live resource

Push `defineResource` (two-arg descriptor form) `trash.entries` scoped by `sourceId`, loader
`select … where source_id order by deleted_at desc` — mirror `blocksLiveResource`'s per-param
scoping. Push mode broadcasts the whole array, so the mutable-predicate membership concern from
`query-resource` does not apply. The L4 change-feed on `trash_entries` covers out-of-process
writes; mutation paths also `.notify()`.

### 1f. Purge scheduler — extend `defineRetention` with `beforeDelete`

Edit `plugins/infra/plugins/retention/server/internal/define-retention.ts`:

```ts
export interface RetentionSpec {
  /* …existing… */
  /** Runs in the same transaction over the rows about to be swept, before the DELETE. */
  beforeDelete?: (rows: Record<string, unknown>[]) => Promise<void>;
}
```

When set: `SELECT` expired rows → `await beforeDelete(rows)` → `DELETE`, in one
`db.transaction`. When unset, the existing bare-delete path is unchanged. Retention stays
generic (never imports the trash registry).

Then in `trash/server/internal/purge.ts` (mounted in `register: [...]`):

```ts
export const trashPurge = defineRetention({
  table: _trashEntries, column: "deletedAt", ttlDays: 30, perWorktree: true,
  beforeDelete: async (rows) => {
    for (const [sourceId, entries] of groupBySource(rows)) {
      const source = getTrashSource(sourceId);
      if (!source) throw new Error(`[trash] purge: no source "${sourceId}"`);
      await source.purge(entries);
    }
  },
});
```

Growth bound (`{kind:"ttl"}`) records automatically at mount — both `trash_entries` and the
trashed domain rows are thereby bounded.

---

## Phase 2 — Pages adoption (`plugins/page/plugins/editor/`)

### 2a. Schema (`server/internal/tables.ts`)

Add to `page_blocks`:

```ts
deletedAt: timestamp("deleted_at", { withTimezone: true }),  // NULL = live
trashEntryId: text("trash_entry_id"),                        // correlation to trash_entries.id
```

Replace the rank uniqueness constraint. **Verified:** drizzle-orm 0.36.4's `uniqueIndex` builder
supports `.where()` but NOT `nullsNotDistinct` — so the current
`unique("page_blocks_parent_rank_uq").on(parentId, rank).nullsNotDistinct()` becomes **two
partial unique indexes** to preserve root-page rank uniqueness (`parent_id IS NULL` rows):

```ts
uniqueIndex("page_blocks_parent_rank_live_uq").on(t.parentId, t.rank)
  .where(sql`deleted_at IS NULL AND parent_id IS NOT NULL`),
uniqueIndex("page_blocks_root_rank_live_uq").on(t.rank)
  .where(sql`deleted_at IS NULL AND parent_id IS NULL`),
```

Plus `index("page_blocks_trash_entry_idx").on(t.trashEntryId)`. Migration is generated by
`./equin build` (never drizzle-kit by hand); inspect the generated SQL for the two
`CREATE UNIQUE INDEX … WHERE …` statements before committing.

### 2b. Lifecycle split (`server/internal/document-hooks.ts`)

```ts
export const BlockLifecycle = {
  BeforeDelete: …, // unchanged — now fires on HARD delete and PURGE only
  OnTrash:  defineServerContribution<{ onTrash:  (blockIds: string[]) => Promise<void> | void }>("page.editor.block.onTrash"),
  OnRestore: defineServerContribution<{ onRestore: (blockIds: string[]) => Promise<void> | void }>("page.editor.block.onRestore"),
};
```

Consumers:
- `apps/pages/content-search/server/internal/delete-hook.ts`: page deindex moves to `OnTrash`;
  add `OnRestore` reindex; keep `BeforeDelete` (idempotent deindex at purge).
- `page/links/server/internal/delete-hook.ts`: deindex trashed pages' edges on `OnTrash`,
  reindex on `OnRestore`; purge still relies on the FK cascade.
- `apps/pages/history/server/internal/delete-hook.ts`: **unchanged** — `deleteVersions` stays on
  `BeforeDelete`, i.e. runs only at purge. This is the core of the fix.

### 2c. The chokepoint — new `server/internal/trash-blocks.ts`

```ts
export async function deleteBlocksSubtree(rootIds: string[]): Promise<{ trashed: boolean }>;
export async function untrashBlocks(entry: TrashEntry): Promise<void>;
export async function purgeTrashedPages(entries: TrashEntry[]): Promise<void>;
```

`deleteBlocksSubtree` (every delete path funnels through it):
1. `collectBlockSubtrees(rootIds)` (existing, `collect-subtree.ts` — deliberately unfiltered so
   it sees trashed rows too), load rows.
2. No `type="page"` in the set → today's hard path (BeforeDelete hooks + `DELETE` roots).
3. Otherwise, in one tx: per `type="page"` root, `recordTrashEntry` (label = page title) then
   `UPDATE … SET deleted_at = now(), trash_entry_id = :entry WHERE id IN (that root's subtree)
   AND deleted_at IS NULL`; non-page roots selected alongside are flagged under the first entry
   so undo restores them too. Fire `OnTrash(subtreeIds)`.

`untrashBlocks(entry)`:
1. `UPDATE … SET deleted_at = NULL, trash_entry_id = NULL WHERE trash_entry_id = :entry.id` —
   exact subtree, no re-walk, never over-restores an independently-trashed nested page.
2. **Rank-collision repair, roots only** (subtree-internal ranks are safe): if a live sibling
   holds the root's `(parent_id, rank)`, mint a fresh rank (`rankAfterSibling`/`nextRankUnder`
   from `@plugins/primitives/plugins/rank/server`).
3. **Vanished parent:** if the root's `parent_id` is purged or itself trashed, reparent to the
   workspace root (`parentId = null, pageId = null`, fresh root rank) so it is reachable.
4. Fire `OnRestore`, notify `blocksChanged` + the trash resource.

`purgeTrashedPages(entries)`: per entry, `collectBlockSubtrees([rootEntityId])`, fire
`BeforeDelete` hooks (→ `deleteVersions`, deindex), then `DELETE` the root — cascade reclaims
content, `page_block_docs`, `page_links`, ext side-tables, attachment links.

Register in `server/index.ts`:
`defineTrashSource({ id: "pages", restore: untrashBlocks, purge: purgeTrashedPages })`.

### 2d. Wire the four delete handlers

- `handle-delete-block.ts` (also the sidebar "Delete page" — same endpoint) →
  `deleteBlocksSubtree([params.id])`; keep 404 probe + `blocksChanged` fan-out.
- `handle-bulk-delete-block.ts` (the incident path) → keep the page-scope root guard, then
  `deleteBlocksSubtree(rootIds)`.
- `handle-apply-block-op.ts` — reducer deletes (merge, etc.) stay hard, **but** if the computed
  delete set contains a `type="page"` row, route through `deleteBlocksSubtree` (defensive: a
  silently cascading page here is the exact bug).
- `handle-patch-blocks.ts` — see 2e.

### 2e. Undo/redo symmetry (`handle-patch-blocks.ts`) — zero client changes

- **Un-trash-on-upsert.** `loadPageBlocks` now excludes trashed rows, so a trashed id would be
  misclassified as an insert → PK conflict. Partition upserts three ways: `update` (live),
  `untrash` (id matches a trashed row → clear flags + apply row data; if it's a `type="page"`
  row, call `untrashBlocks(itsEntry)` for the whole flagged subtree and drop the entry), `insert`
  (neither). Cmd+Z after a page delete thereby restores the full subtree — including CRDT docs,
  which survived untouched (better than the fresh-id re-seed path).
- **Re-trash-on-redo.** `deleteIds` containing a `type="page"` root routes through
  `deleteBlocksSubtree` (new entry); page-free stays hard. Symmetric with undo.

### 2f. Reader exclusion (`isNull(deletedAt)`)

All pages resources are push-mode, so adding the predicate is membership-correct by construction
(the change-feed re-runs the loader on the UPDATE). Sites:

- `server/internal/resources.ts` — `pagesLiveResource`, `blocksLiveResource` loaders.
- `server/internal/handle-list-pages.ts`, `handle-list-blocks.ts`.
- `server/internal/forest.ts` — `loadPageBlocks` (feeds op/patch reducers AND rank-window math;
  required for consistency with the partial unique indexes).
- `server/internal/page-content.ts` — `serializePageContent` (via `loadPageBlocks`).
- `page/attachment-block/server/internal/reconcile.ts`,
  `page/inline-date/server/internal/{reconcile,fire-job}.ts`.
- `apps/pages/content-search/server/internal/{reindex-page,backfill-job}.ts`,
  `page/links/server/internal/reindex.ts`.
- `apps/pages/starred` join, `apps/pages/welcome/recent-pages`, any breadcrumb/ancestor reader.

Sweep with `rg -n "from(_blocks)|_blocks\)" plugins/` during implementation to catch stragglers;
`collectBlockSubtrees` is the one deliberate exception.

### 2g. `replacePageContent` — same bug class, fixed here

`page-content.ts:133` wipes `WHERE page_id = :pageId`, which includes **sub-page shell rows** —
the cascade guts each sub-page's own content, which the snapshot never captured (a history
restore of a page with sub-pages silently destroys them). Fix: scope the wipe to
`ne(_blocks.type, PAGE_BLOCK_TYPE)` so sub-page rows (and their content trees) survive a
version restore. No trash entry here — the pinned "Before restore" version is the net, and the
fresh-id content-doc invariant (comment at lines 112–124) must hold.

---

## Phase 3 — Trash pane (new sub-plugin `plugins/apps/plugins/pages/plugins/trash/`)

Own sub-plugin (modularity convention; mirror `content-search`'s shape):

- `web/index.ts`: `Pages.Sidebar({ id: "trash", title: "Trash", icon: MdDeleteOutline,
  component: PagesTrash })` — same contribution shape as
  `plugins/apps/plugins/pages/plugins/content-search/web/index.ts:10`.
- `web/components/pages-trash.tsx`: pane listing
  `useResource(trashEntriesResource, { sourceId: "pages" })` — rows show label +
  `<RelativeTime date={deletedAt}/>`, a **Restore** button (`useEndpointMutation(restoreTrash)`),
  and **Delete permanently** behind a confirm dialog (reuse the pattern in
  `apps/pages/plugins/page-tree/web/components/delete-page-action.tsx`). List updates live via
  the push resource; restored pages reappear via `pagesResource`.

---

## Edge cases

| Case | Resolution |
|---|---|
| Trashed row keeps its rank; new sibling collides | Partial unique indexes exclude trashed rows (2a) |
| Restore rank collision | Re-rank restored **roots** only (2c) |
| Restore into purged/trashed parent | Reparent to workspace root (2c) |
| Concurrent `projectText` flush during trash | Harmless: writes `data.text` only; row survives to restore. `updateOnly` gate still covers content-block hard-deletes |
| Double Restore / Purge (multi-tab) | Second call gets typed `404` on the entry — never a silent no-op |
| Bulk delete mixing pages + plain blocks | Whole selection trashed under the operation's entries so undo restores everything |
| Nested trash (trash sub-page, then trash its parent) | `deleted_at IS NULL` guard in the flag UPDATE keeps the inner entry's `trash_entry_id` ownership; restoring the outer entry leaves the inner one trashed |

## Verification

**bun:test** (co-located `*.test.ts`, use the db-test-fixture):
- `trash-blocks.test.ts` — incident shape: subtree with two sub-pages → all descendant rows +
  `page_block_docs` survive with `deleted_at` set, two entries created, `entity_versions`
  untouched; page-free set → hard delete unchanged. `untrashBlocks` rank-collision and
  vanished-parent paths. Purge → `deleteVersions` fires, cascade cleans.
- `define-retention.test.ts` — `beforeDelete` gets exactly the expiring rows, runs pre-DELETE,
  aborting throw leaves rows in place.
- Patch-handler partition: trashed-id upsert → untrash (not insert); page-root redo → re-trash.

**e2e (scripted, `e2e/screenshot.mjs` style, then `mcp__singularity__query_db` to assert rows):**
1. Delete a sub-page via block selection → content gone from UI → **Cmd+Z** → sub-page AND full
   content subtree back (assert `page_blocks` rows for the sub-page's `page_id` live again).
2. Delete a page from the sidebar → Trash pane shows it → Restore → back in sidebar with
   content. Delete again → **Delete permanently** → rows + versions hard-gone.
3. Backdate a `trash_entries.deleted_at` past 30d → run the retention job → purged.
4. History-restore a page containing sub-pages → sub-page content survives (2g).

Then `./equin build` and drive the flows on `http://<worktree>.localhost:9000/pages`.

## Audit — other hard-delete surfaces (classification only, per scope decision)

**Same bug class possible (user content, destructive cascade or no recovery net):**

| Surface | Path | Risk |
|---|---|---|
| Conversation delete | `tasks-core/server/internal/mutations/conversations.ts:150` via `conversations/server/internal/handle-delete.ts` | Cascades user **notes**, category, queue rank, active-data bindings, group membership. No undo, no history. Prime future trash adopter |
| Attempt delete | `tasks-core/…/mutations/attempts.ts:16` | Cascades conversations → pushes (2 levels), same class |
| Workflow definition delete | `workflows/plugins/engine/server/internal/mutations.ts:61` | Cascades the **entire execution history** of the workflow |
| Sonata song delete | `sonata/plugins/library/server/internal/handle-delete-song.ts` | Cascades all `songs_ext_*` (playback, transpose, chord grid, …) + attachment links |
| Attachment delete | `infra/attachments/server/internal/operations.ts:45` | Deletes the DB row **and unlinks the disk file** — irreversible even with DB trash; adoption would need purge-deferred unlink |
| Custom-column delete | `data-view/plugins/custom-columns/…/handle-delete-custom-column-values.ts` | Dropping a column destroys every row's user-entered values |
| History restore (`replacePageContent`) | `page/editor/server/internal/page-content.ts:133` | **Fixed in this pass** (2g) |
| `entity_versions` 30-day TTL sweeps **pinned** rows | `history/plugins/engine/server/internal/retention.ts` | The "Before restore" safety net itself expires; related weakness worth noting |

**Lower severity (single user-authored row, explicit confirm, easily recreated):** browser
bookmarks, custom agents (409-guarded if children), deploy servers (+SSH secret), tweakcn
themes, task-dependency edges, staged-config discard.

**Safe (derived / rebuildable / mirrored / already soft):** tasks (`droppedAt` soft-drop — the
in-repo precedent), mail tables (Gmail is the source of truth), `page_links`, search index,
notifications, traces/reports/boot-traces, job bookkeeping, `mail_labels.parent_id` is
`set null`.

## Critical files

- New: `plugins/infra/plugins/trash/{core,server}/…` (tables, registry, record-entry,
  endpoints, resource, purge)
- New: `plugins/page/plugins/editor/server/internal/trash-blocks.ts`
- New: `plugins/apps/plugins/pages/plugins/trash/web/…` (sidebar entry + pane)
- Edit: `plugins/page/plugins/editor/server/internal/{tables,document-hooks,forest,resources,
  page-content,handle-delete-block,handle-bulk-delete-block,handle-apply-block-op,
  handle-patch-blocks,handle-list-pages,handle-list-blocks}.ts`
- Edit: `plugins/infra/plugins/retention/server/internal/define-retention.ts` (+ types)
- Edit: `plugins/apps/pages/{content-search,history}` + `page/links` delete hooks
