import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  expr,
  type ColumnRef,
} from "@plugins/network/plugins/live/plugins/query-resource/core";
import type {
  ServeCollectionOptions,
  TreeChildCountBinding,
} from "@plugins/network/plugins/live/server";
import type { PagesTreeFields } from "../../core";
import { livePageSql, pageContent, pageTreeChildren } from "./rollup-spec";
import { _pageContentEditedAt, _pageTreeChildren } from "./rollup-table";
import { _blocks } from "./tables";

// How `pagesTree` (core: the live pages as a TREE window, key `pages.tree.v2`)
// binds to the database — the ONE spelling both the served collection
// (`./resources.ts`) and the tests (`./pages-tree-oracle.test.ts`, which
// compiles it against a throwaway database and holds it equal to document
// order) read, so neither can drift from what ships.
//
// It reads the `page_blocks` TABLE, never `liveBlocks` (a routed compile reads
// a base table, and `liveBlocks` is a subquery over it): the membership is
// spelled here instead — a page row (`type = 'page'`) that is not trashed
// (`deleted_at IS NULL`, the predicate `liveBlocks` writes for every other
// reader). Both columns are mutable, so a trash is a where-flip exit, a
// restore or a turn-into-page an entrant, and a turn-into-content an exit.
//
// Every row field — the block wire fields, `pageId` (the tree's parent) and
// `docRank` (its sibling rank) — binds to its column by name. `doc_rank` is
// nullable (content rows hold NULL), and on a live page row it is always set:
// invariant I-DR, kept by the structural-write chokepoint (`withPageForest` →
// `doc-rank.ts`) and repaired at boot. A leaked NULL fails the row schema's
// `RankSchema` at load, loudly, rather than sorting the row anywhere. A level
// reads `(page_id, doc_rank)` through the partial index
// `page_blocks_page_tree_idx` (`./tables.ts`).
//
// Two fields are computed:
//
//  - `editedAt`, the page's edit time: `pageEditedAtSql` over the row's own
//    `updated_at` and the materialized `page_content_edited_at` (`pageContent`,
//    `./rollup-spec.ts`), joined on the page id. The rollup is on the change
//    feed, so a content block's write reaches exactly its page — and only when
//    the page's newest stamp moved — and a window sorted by it (Recent) moves
//    the row.
//  - `title`, the page payload's title as text (`data->>'title'`, the
//    `Untitled` a list draws for an empty one — so searching what is shown
//    finds it) — the column a picker or the sidebar's search filters by
//    (`contains`), server-side. The payload stays carried whole (`data`); this
//    is its one queryable projection.
//
// And `$childCount` (the tree's) is the materialized `page_tree_children`
// (`pageTreeChildren`), joined by the collection itself.
//
// So a write to a page row is that row's refill (every column the row reads
// is a field), a `doc_rank` re-mint the refill of exactly the re-minted pages,
// an insert an entrant in its parent's level (and the parent's recount); a
// write to a content block — the ~1s `data.text` typing projection, a toggle
// drag — is the refill of its page's ONE row (its stored edit time moved), and
// a write that moves no stored aggregate (a fold toggle) loads nothing.

/**
 * An operand of {@link pageEditedAtSql}: a drizzle column (`readPageEditedAt`'s
 * select) or a compile ref (`j.base.updatedAt` — a `ColumnRef` that renders as
 * SQL at runtime), as tasks-core's `SqlOperand`.
 */
type SqlOperand = SQLWrapper | ColumnRef;

/**
 * A page's edit time: the newest of its own row's `updated_at` and its
 * content's (the rollup's `edited_at`, NULL for a page with no content —
 * `greatest` skips a NULL). The ONE spelling, read by the `pagesTree` field
 * below and by `readPageEditedAt`.
 */
export function pageEditedAtSql(
  rowUpdatedAt: SqlOperand,
  contentEditedAt: SqlOperand,
): SQL {
  return sql`greatest(${rowUpdatedAt}, ${contentEditedAt})`;
}

const joins = [pageContent.join()] as const;

export const pageRowsServeOptions = {
  from: _blocks,
  joins,
  where: livePageSql(_blocks.type, _blocks.deletedAt),
  columns: {
    editedAt: (j) =>
      expr(pageEditedAtSql(j.base.updatedAt, j.content.editedAt), {
        decoder: _pageContentEditedAt.editedAt,
        sqlType: "timestamp with time zone",
        notNull: true,
      }),
    title: (j) =>
      expr(sql`coalesce(nullif(${j.base.data} ->> 'title', ''), 'Untitled')`, {
        decoder: String,
        sqlType: "text",
        notNull: true,
      }),
  },
  childCount: { of: pageTreeChildren, count: "count" },
} satisfies ServeCollectionOptions<
  typeof _blocks,
  PagesTreeFields,
  typeof joins
> & {
  childCount: TreeChildCountBinding<typeof _pageTreeChildren>;
};
