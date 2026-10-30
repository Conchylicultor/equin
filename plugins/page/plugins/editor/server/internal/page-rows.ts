import { and, eq, isNull, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  BASE_RELATION,
  expr,
  type ColumnRef,
  type RollupJoin,
} from "@plugins/infra/plugins/query-resource/core";
import type { ServeAllCollectionOptions } from "@plugins/network/plugins/live/server";
import { PAGE_BLOCK_TYPE, type PageRow } from "../../core";
import { pageContentEditedAt } from "./rollup-spec";
import { _pageContentEditedAt } from "./rollup-table";
import { _blocks } from "./tables";

// How `pagesTree` (core: every live page, key `pages.tree`) binds to the
// database — the ONE spelling both the served collection (`./resources.ts`)
// and the tests (`./pages-tree-oracle.test.ts`, which compiles it against a
// throwaway database and holds it equal to document order) read, so neither
// can drift from what ships.
//
// It reads the `page_blocks` TABLE, never `liveBlocks` (a routed compile reads
// a base table, and `liveBlocks` is a subquery over it): the membership is
// spelled here instead — a page row (`type = 'page'`) that is not trashed
// (`deleted_at IS NULL`, the predicate `liveBlocks` writes for every other
// reader). Both columns are mutable, so a trash is a where-flip exit, a
// restore or a turn-into-page an entrant, and a turn-into-content an exit.
//
// Every row field — the block wire fields and `docRank` — binds to its column
// by name. `doc_rank` is nullable (content rows hold NULL), and on a live page
// row it is always set: invariant I-DR, kept by the structural-write
// chokepoint (`withPageForest` → `doc-rank.ts`) and repaired at boot. The
// binding cannot state that claim — the `all` compiler refuses an `expr` that
// is exactly one column, and a base column's nullability is not checked — so it
// is enforced where it lands: a leaked NULL fails the row schema's
// `RankSchema` at load, loudly, rather than sorting the row anywhere.
//
// `editedAt` is the page's edit time: `pageEditedAtSql` over the row's own
// `updated_at` and the `page_content_edited_at` rollup (`./rollup-spec.ts`,
// the newest `updated_at` over the page's live content), LEFT-joined on the
// page id. The rollup is routed through its source — `page_blocks` itself,
// carrying `page_id` — so a content block's write reaches exactly its page.
//
// So a write to a page row is that row's refill (every column the row reads
// is a field), a `doc_rank` re-mint the refill of exactly the re-minted pages
// (the order is `createdAt`, which never moves), an insert one refill and one
// `orderOf`; a write to a content block — the ~1s `data.text` typing
// projection, a toggle drag — is the refill of its page's ONE row (its
// `updated_at` moves the rollup), and a write that moves no column the rollup
// reads (a fold toggle, a re-mint) loads nothing.

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

const content = {
  kind: "rollup",
  alias: "content",
  rollup: pageContentEditedAt,
  on: { from: BASE_RELATION, col: _blocks.id },
} as const satisfies RollupJoin;

const joins = [content] as const;

export const pageRowsServeOptions = {
  from: _blocks,
  joins,
  where: and(eq(_blocks.type, PAGE_BLOCK_TYPE), isNull(_blocks.deletedAt))!,
  columns: {
    editedAt: (j) =>
      expr(pageEditedAtSql(j.base.updatedAt, j.content.editedAt), {
        decoder: _pageContentEditedAt.editedAt,
        sqlType: "timestamp with time zone",
        notNull: true,
      }),
  },
} satisfies ServeAllCollectionOptions<typeof _blocks, PageRow, typeof joins>;
