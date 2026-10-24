# Pages: backlinks index stale on page delete

## Context

The Pages app shows a **Backlinks** panel on each page listing the other pages that link to it. It is backed by the `page_links` edge table and the `backlinksResource` live-state resource (`plugins/page/plugins/links`).

When a page's *blocks* change, the working path is:
`blocksChanged` event → `reindexLinksJob` → `reindexDocument()` → diff `page_links` → `backlinksResource.notify({ pageId })` for every affected target → WS push → panel refreshes live.

**The bug:** deleting a page goes through `handleDeleteDocument` (`plugins/page/plugins/editor/server/internal/handle-delete-document.ts`), which deletes the `page_documents` row. Postgres FK cascade silently removes the page's outgoing `page_links` edges (and, recursively, those of its descendant subtree — `parent_id` is `ON DELETE CASCADE`). The handler notifies `documentsLiveResource` and `blocksLiveResource`, but **never** `backlinksResource`. So every page the deleted subtree linked *to* keeps showing the deleted page in its Backlinks panel until a manual reload or the next unrelated edit triggers a reindex.

**Goal:** when a page (and its cascade-deleted subtree) is removed, the former-target pages' Backlinks panels update live, with no reload or extra edit.

## Constraints that shape the design

1. **No cross-plugin cycle.** `links` already imports from `editor` (`_documents`, `_blocks`, `blocksChanged`). The delete handler lives in `editor`, so it **cannot** import `backlinksResource`/`_pageLinks` from `links` — that would create an `editor → links → editor` cycle (forbidden by `--plugin-boundaries`). The notify must be owned by `links`.
2. **Snapshot must precede the delete.** The affected targets are `{ targetDocumentId : sourceDocumentId ∈ deletedSubtree }`. Once the cascade fires, those rows are gone and the set is unrecoverable. An async job (runs post-commit) is therefore too late — the capture must be **synchronous, before** `db.delete`.
3. **Notify must follow the delete.** `backlinksResource` is `push` mode; its loader re-queries `page_links`. Notifying before the delete would re-push the *stale* list. So: snapshot before, notify after.

(1)+(2) rule out both an `editor`-side import and an event/job approach. The clean fit is a generic, editor-owned **document pre-delete hook slot** that `links` contributes to — mirroring the existing `PageLinks.Extractor` collection-consumer pattern. This also becomes the reusable primitive for any future document-derived index (full-text, tags, mentions).

## Approach

Add a server-side `DocumentLifecycle.BeforeDelete` contribution slot in `editor`. The delete handler computes the full subtree id set, runs each before-delete hook (which may return an after-delete callback), deletes, then runs the callbacks. `links` contributes a hook that snapshots affected backlink targets and notifies them after the delete.

### New / changed files

**1. NEW `plugins/page/plugins/editor/server/internal/document-hooks.ts`** — the slot, mirroring `links/server/internal/extractor.ts`:

```ts
import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";

// Runs synchronously inside the document delete handler, BEFORE the row and its
// FK-cascade descendant subtree are removed. `documentIds` is the full set the
// delete will wipe (root + descendants). A hook may return an after-delete
// callback, invoked once the delete commits, for notifications that must
// reflect post-delete state (e.g. backlinks panels). Collection-consumer
// separation: the handler dispatches generically and never names a contributor.
export interface DocumentDeleteHook {
  beforeDelete: (
    documentIds: string[],
  ) =>
    | Promise<(() => void | Promise<void>) | void>
    | (() => void | Promise<void>)
    | void;
}

export const DocumentLifecycle = {
  BeforeDelete: defineServerContribution<DocumentDeleteHook>(
    "page.editor.document.beforeDelete",
  ),
};
```

**2. NEW `plugins/page/plugins/editor/server/internal/collect-subtree.ts`** — recursive descendant query, mirroring the `db.execute<{...}>(sql\`...\`)` + `.rows.map()` pattern in `plugins/tasks-core/server/internal/queries/tasks.ts:120`:

```ts
import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";

// Root id plus every descendant via parent_id — the exact set ON DELETE CASCADE
// will remove. Lets delete hooks snapshot subtree-dependent state before it
// vanishes. Returns [] for a non-existent root.
export async function collectDocumentSubtree(rootId: string): Promise<string[]> {
  const result = await db.execute<{ id: string }>(sql`
    WITH RECURSIVE subtree AS (
      SELECT id FROM page_documents WHERE id = ${rootId}
      UNION ALL
      SELECT d.id FROM page_documents d JOIN subtree s ON d.parent_id = s.id
    )
    SELECT id FROM subtree
  `);
  return result.rows.map((r) => r.id);
}
```

**3. MODIFY `plugins/page/plugins/editor/server/internal/handle-delete-document.ts`** — run hooks around the delete:

```ts
const subtreeIds = await collectDocumentSubtree(params.id);
const afterCallbacks: Array<() => void | Promise<void>> = [];
for (const hook of DocumentLifecycle.BeforeDelete.getContributions()) {
  const after = await hook.beforeDelete(subtreeIds);
  if (after) afterCallbacks.push(after);
}

const [row] = await db.delete(_documents).where(eq(_documents.id, params.id)).returning();
if (!row) throw new HttpError(404, "Not found");

documentsLiveResource.notify();
blocksLiveResource.notify({ documentId: params.id });
for (const after of afterCallbacks) await after();
```

(For a non-existent doc, `subtreeIds` is `[]`, hooks no-op, then the `404` throws as before.)

**4. MODIFY `plugins/page/plugins/editor/server/index.ts`** — export the slot + type:

```ts
export { DocumentLifecycle } from "./internal/document-hooks";
export type { DocumentDeleteHook } from "./internal/document-hooks";
```

**5. NEW `plugins/page/plugins/links/server/internal/delete-hook.ts`** — the contributing hook:

```ts
import { inArray } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type { DocumentDeleteHook } from "@plugins/page/plugins/editor/server";
import { backlinksResource } from "./resources";
import { _pageLinks } from "./tables";

// A deleted subtree's outgoing page_links edges are FK-cascade-wiped. Snapshot
// the target pages BEFORE the delete, then re-push their backlinks panels AFTER
// (loader returns the fresh list, minus the deleted sources). Targets inside the
// deleted subtree are skipped — their own panels are gone.
export const backlinksDeleteHook: DocumentDeleteHook = {
  beforeDelete: async (documentIds) => {
    const deleted = new Set(documentIds);
    const rows = await db
      .select({ targetDocumentId: _pageLinks.targetDocumentId })
      .from(_pageLinks)
      .where(inArray(_pageLinks.sourceDocumentId, documentIds));
    const affected = new Set(
      rows.map((r) => r.targetDocumentId).filter((t) => !deleted.has(t)),
    );
    return () => {
      for (const pageId of affected) backlinksResource.notify({ pageId });
    };
  },
};
```

(`inArray(col, [])` is safe — drizzle compiles it to a false predicate, so a non-existent root yields no rows.)

**6. MODIFY `plugins/page/plugins/links/server/index.ts`** — register the contribution:

```ts
import { DocumentLifecycle } from "@plugins/page/plugins/editor/server";
import { backlinksDeleteHook } from "./internal/delete-hook";
// ...
contributions: [
  Resource.Declare(backlinksResource),
  Trigger({ on: blocksChanged, do: reindexLinksJob, with: {}, oneShot: false }),
  DocumentLifecycle.BeforeDelete(backlinksDeleteHook),
],
```

No new migration (no schema change). No registry edits (contributions are discovered at runtime by `collectContributions`). `links → editor` edge already exists, so no new cycle.

## Why not the alternatives

- **Notify from the editor delete handler directly** — needs `editor → links` import = forbidden cycle.
- **`documentDeleted` trigger event + job** — the job runs post-commit, after the cascade has already wiped `page_links`; the affected-target set is unrecoverable. Snapshot must be synchronous and pre-delete.
- **`backlinksResource` `dependsOn` `documentsLiveResource`** — the `map` only sees the post-delete document list, not the diff, so it would have to refresh *every* page's backlinks on any document change (N loader runs per delete). Over-broad and wasteful.

## Out of scope

- Stale `page-link` *block* references (a block still holding a now-deleted `pageId` renders a dangling link). That is a block-rendering concern, separate from backlinks-index correctness; `page_links` rows are already removed correctly by the cascade.

## Verification

1. `./equin build`, then `./equin check --plugin-boundaries` (confirm no cycle) and the full `./equin check`.
2. Scripted Playwright run at `http://att-1780525914-xm7m.localhost:9000` (Pages app):
   - Create page **A** and page **B**. In **A**, add a page-link block targeting **B**. Open **B** → Backlinks shows **A**.
   - Keep **B**'s detail open; in another tab delete **A**. **B**'s Backlinks panel clears **live** (no reload). Before the fix it keeps showing **A**.
   - Subtree case: page **A** with child **C**; **C** links to **B**. Delete **A** (cascades **C**). **B**'s Backlinks (which listed **C**) clears live.
3. DB check via `query_db`: after delete, `SELECT * FROM page_links WHERE target_document_id = '<B>'` returns no rows referencing the deleted sources (cascade), and the panel reflects it without an edit/reload.
