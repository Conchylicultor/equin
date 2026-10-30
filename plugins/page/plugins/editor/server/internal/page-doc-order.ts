import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { PAGE_BLOCK_TYPE } from "../../core";
import { _blocks } from "./tables";
import type { BlockReadExecutor } from "./page-id";
import type { PageScope } from "./page-forest";

// One page's rank path: the ranks from a direct child of its nearest PAGE
// ancestor, down through any intervening content blocks, to the page row itself.
// Comparing two such paths element-wise IS document order within a `pageId`
// group — see the correctness note on `docOrderRows`.
type RankPath = string[];

// `path` is built with an explicit `::text` on every element, so it is a plain
// `text[]` (OID 1009) that pg decodes to a real array — not the raw `{a,b}`
// literal an uncast `rank_text`/`name` array would arrive as. Measured against
// the live cluster, and the reason the cast in the SQL is load-bearing.
const DocOrderRowSchema = z.object({
  id: z.string(),
  page_id: z.string().nullable(),
  rank: z.string(),
  doc_rank: z.string().nullable(),
  path: z.array(z.string()).nullable(),
});

/** One live page row, with what its sidebar group is ordered by. */
export interface DocOrderRow {
  id: string;
  /** Its sidebar group: the nearest page ancestor (`null` = the root group). */
  pageId: PageScope;
  rank: Rank;
  /** The stored `doc_rank`; `null` until a reconcile has placed the row. */
  docRank: Rank | null;
  /**
   * Its rank path, or `null` when the upward walk cannot resolve one (a live
   * page under a trashed row, a `parent_id` cycle) — corruption the row
   * survives: membership is never a function of the traversal.
   */
  path: RankPath | null;
}

/**
 * Every LIVE page row of the given sidebar groups (all of them when `pageIds`
 * is absent), each with its rank path — the input the `doc_rank` reconcile
 * orders a group by.
 *
 * Two relations in ONE query, kept strictly apart:
 *
 * - **Membership** is the plain select of live `type="page"` rows, and must
 *   NEVER become a function of the traversal. A page whose ancestor chain
 *   cannot resolve still gets a row (with `path: null`): otherwise it would
 *   never be given a `doc_rank` and would leak a NULL into the sidebar.
 * - **Order** is an **upward** recursive CTE from those rows: only pages plus
 *   their ancestor chains (~pages × depth), never the whole forest, LEFT-joined
 *   onto the membership. drizzle cannot emit recursive CTEs, so this is raw
 *   `sql`, mirroring the precedent in `page-id.ts` (`recomputePageIdSubtree`)
 *   and `collect-subtree.ts`.
 *
 * Partition-scoped (`pageIds`), the CTE is seeded only by those groups' pages —
 * an indexed `page_id` lookup — which is what keeps the per-write reconcile
 * cheap: a structural op in a page with no sub-pages returns no row.
 *
 * The walk stops exactly at the nearest page ancestor (`cursor = page_id`), so
 * `path` runs from a direct child of the parent page down to the page row.
 * Edge cases, all correct: a root page (`page_id` and `parent_id` both null)
 * terminates at the base with `path = [rank]`; a page whose parent IS a page has
 * `cursor = page_id` at the base, likewise terminal; a page under a root-level
 * content block walks to `parent_id IS NULL` and lands in the `null` group with
 * a content-rank prefix.
 *
 * **Correctness.** Within one `pageId` group, comparing paths element-wise is
 * DFS pre-order. No path is a proper prefix of another: if `path(X)` prefixed
 * `path(Y)`, then `Y` descends *through* `X`, making `X` a page ancestor of `Y`
 * — so `pageId(Y) = X ≠ pageId(X)`, contradicting same-group. Paths therefore
 * diverge at some index where both elements are ranks of live siblings under a
 * common parent, distinct by `page_blocks_parent_rank_live_uq` /
 * `page_blocks_root_rank_live_uq`. Total order, no ties.
 *
 * Returns the rows ONLY — **no ordering decision happens in SQL**, deliberately.
 * `rank_text` is a `TEXT COLLATE "C"` domain (byte order = rank order), but a
 * recursive CTE's column-type resolution can flatten the domain back to plain
 * `text`, silently reverting to locale collation — where `'a' < 'B'` while JS
 * `Rank.compare` says `'B' < 'a'`. The caller sorts in JS with
 * {@link compareDocOrder}; do not "optimize" the sort back into this query.
 */
export async function docOrderRows(
  executor: BlockReadExecutor = db,
  scope?: { pageIds: readonly PageScope[] },
): Promise<DocOrderRow[]> {
  const partition = scope ? partitionFilter(scope.pageIds) : sql`TRUE`;
  const rows = await executeRows(executor, {
    label: "page doc-order rank paths",
    row: DocOrderRowSchema,
    query: sql`
    WITH RECURSIVE members AS (
      SELECT b.id, b.page_id, b.parent_id, b.rank, b.doc_rank
      FROM ${_blocks} b
      WHERE b.type = ${PAGE_BLOCK_TYPE} AND b.deleted_at IS NULL
        AND ${partition}
    ),
    up AS (
      SELECT m.id AS page_row_id, m.page_id, m.parent_id AS cursor,
             ARRAY[m.rank::text] AS path
      FROM members m
      UNION ALL
      SELECT u.page_row_id, u.page_id, p.parent_id, p.rank::text || u.path
      FROM up u
      JOIN ${_blocks} p ON p.id = u.cursor AND p.deleted_at IS NULL
      -- Terminal rows leave the recursive term and are selected below: the walk
      -- stops at the tree root (cursor IS NULL) or at the nearest PAGE ancestor
      -- (cursor = page_id).
      WHERE u.cursor IS NOT NULL
        AND u.cursor IS DISTINCT FROM u.page_id
        -- Cycle guard. A parent_id cycle would recurse forever and pin a pool
        -- connection — on a path that runs inside every structural write.
        -- Real nesting is far below the cap; a cycle simply terminates here.
        AND array_length(u.path, 1) < 64
    ),
    done AS (
      SELECT page_row_id, path FROM up WHERE cursor IS NULL OR cursor = page_id
    )
    SELECT m.id, m.page_id, m.rank::text AS rank, m.doc_rank::text AS doc_rank,
           d.path
    FROM members m
    LEFT JOIN done d ON d.page_row_id = m.id
  `,
  });
  return rows.map((r) => ({
    id: r.id,
    pageId: r.page_id,
    rank: Rank.from(r.rank),
    docRank: r.doc_rank === null ? null : Rank.from(r.doc_rank),
    path: r.path,
  }));
}

/**
 * The `page_id` predicate for a set of sidebar groups. The root group is
 * `IS NULL`, which `= ANY` cannot express, so it is a separate arm — and the
 * named groups stay one indexed `= ANY` however many there are.
 */
function partitionFilter(pageIds: readonly PageScope[]): SQL {
  const named = pageIds.filter((p): p is string => p !== null);
  const arms: SQL[] = [];
  if (named.length > 0) {
    arms.push(sql`b.page_id = ANY(${sql.param(named)}::text[])`);
  }
  if (pageIds.includes(null)) arms.push(sql`b.page_id IS NULL`);
  if (arms.length === 0) return sql`FALSE`;
  return sql`(${sql.join(arms, sql` OR `)})`;
}

/**
 * Rank path per live page row, keyed by page row id — {@link docOrderRows}
 * reduced to the rows whose path resolves, for a caller asking only "where
 * does each page sit".
 */
export async function docOrderPaths(
  executor: BlockReadExecutor = db,
  scope?: { pageIds: readonly PageScope[] },
): Promise<Map<string, RankPath>> {
  const paths = new Map<string, RankPath>();
  for (const row of await docOrderRows(executor, scope)) {
    if (row.path !== null) paths.set(row.id, row.path);
  }
  return paths;
}

// Element-wise rank-path comparison. Sorting in JS with `Rank.compare` is
// deliberate and load-bearing: see the collation note on `docOrderRows`. A
// shorter path can never be a proper prefix of a longer one within a group
// (same note), so the length tiebreak is unreachable defence.
function comparePaths(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = Rank.compare(Rank.from(a[i]!), Rank.from(b[i]!));
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/**
 * THE document-order comparator over one sidebar group's rows — what `doc_rank`
 * must agree with (invariant I-DR).
 *
 * A row whose path cannot resolve sorts LAST in its group, by raw `rank`, then
 * by id. That completes the total order for a degenerate input (a live page
 * whose ancestor chain is broken) — the row is kept and deterministically
 * placed, not absorbed. Provably dead code: `resolveLiveParent` (page-id.ts)
 * 404s a trashed/missing destination parent, which was the sole way to mint a
 * dangling pointer.
 */
export function compareDocOrder(a: DocOrderRow, b: DocOrderRow): number {
  if (a.path && b.path) return comparePaths(a.path, b.path);
  if (a.path) return -1;
  if (b.path) return 1;
  return (
    Rank.compare(a.rank, b.rank) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
