import { and, asc, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db, type DbExecutor } from "@plugins/database/server";
import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import { Rank, withRank } from "@plugins/primitives/plugins/rank/core";
import { PAGE_BLOCK_TYPE } from "../../core/schemas";
import { blockLocations, pagesTree, pageBlocks } from "../../core/resources";
import type { Block, PageRow } from "../../core/schemas";
import { liveBlocks } from "./live-blocks";
import { pageEditedAtSql, pageRowsServeOptions } from "./page-rows";
import { _pageContentEditedAt } from "./rollup-table";
import { _blocks } from "./tables";
import { BLOCK_WIRE_COLUMNS } from "./wire-columns";

/**
 * A page row's edit time as a select field: {@link pageEditedAtSql} over the
 * row's own `updated_at` and the LEFT-joined `page_content_edited_at` rollup —
 * the expression the `pagesTree` set's `editedAt` field compiles.
 */
const editedAtOf = () =>
  pageEditedAtSql(liveBlocks.updatedAt, _pageContentEditedAt.editedAt).mapWith(
    _pageContentEditedAt.editedAt,
  );

/**
 * All live pages (`type="page"` blocks), each carrying its stored `docRank`,
 * ordered by `(page_id, doc_rank)` — so **array order ≡ `docRank` order**
 * within every sidebar sibling group. The read behind `GET /api/pages` (D8);
 * the live set is `pagesTree`, served below over the same column.
 *
 * A plain select: membership is the live page rows, order is the
 * `(page_id, doc_rank)` the structural-write chokepoint maintains
 * (`withPageForest` → `doc-rank.ts`, invariant I-DR), so there is no second
 * derivation of document order here to disagree with it. `doc_rank` is a
 * `rank_text` column, so `ORDER BY` sorts it by byte order — `Rank.compare`'s.
 *
 * A live page with no `doc_rank` is a writer that bypassed the marks (or an old
 * backend writing during a hot-swap) — THROWN, naming the row, never minted
 * over: the boot reconcile repairs and reports it.
 *
 * `executor` is injectable for the db-fixture tests; production passes `db`.
 */
export async function loadPages(
  executor: NodePgDatabase = db,
): Promise<PageRow[]> {
  const rows = await executor
    .select({
      ...BLOCK_WIRE_COLUMNS,
      docRank: liveBlocks.docRank,
      editedAt: editedAtOf(),
    })
    // Trashed pages are not pages any reader lists (`liveBlocks`).
    .from(liveBlocks)
    .leftJoin(
      _pageContentEditedAt,
      eq(_pageContentEditedAt.pageId, liveBlocks.id),
    )
    .where(eq(liveBlocks.type, PAGE_BLOCK_TYPE))
    .orderBy(asc(liveBlocks.pageId), asc(liveBlocks.docRank));
  return rows.map(({ docRank, ...row }) => {
    if (docRank === null) {
      throw new Error(
        `[page-editor] live page ${row.id} (group ${row.pageId ?? "root"}) has no doc_rank — a structural write bypassed the doc-order marks`,
      );
    }
    return { ...withRank(row), docRank: Rank.from(docRank) };
  });
}

// Every live page and its `:rows` point sibling, routed over the `page_blocks`
// table and the `page_content_edited_at` rollup (`./page-rows.ts`): a page-row
// write is that row's refill, a content block's write — the typing projection
// included — the refill of its page's one row (its `editedAt` moved).
export const pagesTreeServed = serveCollection(pagesTree, pageRowsServeOptions);

// A page's content forest: EVERY block whose nearest page ancestor is `pageId`,
// sub-page rows included. There is no type filter, and there must not be — the
// server's reducer (`loadPageBlocks`) has always run over exactly this set, so
// filtering here made client and server mint fractional-index ranks over
// different sibling sets, which is how two siblings ended up sharing `"a0"`.
//
// A sub-page row is automatically a LEAF of this forest: its own content carries
// `page_id = <the sub-page's id>`, a different partition. So `(parent_id, rank)`
// is one real, rendered ordering — the sidebar's page tree is a filtered
// subsequence of it, not a separate ordering space.
//
// A db-arm value: the loader's read-set (`page_blocks`, through the `liveBlocks`
// subquery) is captured at the pool chokepoint, so every structural write, text
// projection and trash/restore recomputes the subscribed pages; push drops a
// byte-identical result.
export const pageBlocksServed = serveValue(pageBlocks, {
  source: "db",
  unbounded: {
    reason:
      "one page's content forest — the reducer, the optimistic overlay and document order need every block of the page, never a window",
  },
  loader: async ({ pageId }): Promise<Block[]> => {
    const rows = await db
      .select(BLOCK_WIRE_COLUMNS)
      .from(liveBlocks)
      .where(eq(liveBlocks.pageId, pageId))
      .orderBy(asc(liveBlocks.rank), asc(liveBlocks.createdAt));
    return rows.map(withRank);
  },
});

/**
 * When a page was last edited: the newest `updated_at` over the page row AND
 * its live content blocks — the page row alone moves only on a rename, a cover
 * or a kind change, never on a content edit. `null` when `pageId` names no live
 * page.
 *
 * The same definition as the `pagesTree` row's `editedAt` (one expression,
 * {@link pageEditedAtSql}, over the same rollup), read by `markdown-apply`'s
 * `<page-meta>` header — so the header, the page's "Edited" label and the
 * Recent lists can never state different times.
 */
export async function readPageEditedAt(
  pageId: string,
  executor: DbExecutor = db,
): Promise<{ editedAt: Date } | null> {
  const [row] = await executor
    .select({ editedAt: editedAtOf() })
    .from(liveBlocks)
    .leftJoin(
      _pageContentEditedAt,
      eq(_pageContentEditedAt.pageId, liveBlocks.id),
    )
    .where(and(eq(liveBlocks.id, pageId), eq(liveBlocks.type, PAGE_BLOCK_TYPE)))
    .limit(1);
  return row ?? null;
}

// Where any live block lives (`blockLocations`, lookup-only `:rows`): its
// `id` / `type` / `pageId` bound to `page_blocks` by name. The base membership
// is the predicate `liveBlocks` writes for every other reader (a routed compile
// reads the base TABLE, never the subquery), so a trashed block reads not
// found. The point route reads only the projected columns and `deleted_at`, so
// a content write (the ~1s typing projection) refills nothing.
export const blockLocationsServed = serveCollection(blockLocations, {
  from: _blocks,
  where: isNull(_blocks.deletedAt),
});
