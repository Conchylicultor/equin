import { planDocRanks, type DocRankChange } from "../../core";
import {
  compareDocOrder,
  docOrderRows,
  type DocOrderRow,
} from "./page-doc-order";
import { writeDocRanks } from "./forest-writer";
import { takeDocOrderDirty } from "./doc-order-dirty";
import type { PageForestTx, PageScope } from "./page-forest";

/** A planned `doc_rank` change, with the sidebar group it belongs to. */
export interface PartitionDocRankChange extends DocRankChange {
  pageId: PageScope;
}

/**
 * The `doc_rank` changes that make every group in `rows` satisfy invariant
 * I-DR: ordering a group's live page rows by `doc_rank` equals ordering them by
 * {@link compareDocOrder} (rank-ordered DFS pre-order, stopping at nested
 * pages). Groups by `pageId`, sorts each in JS — the collation note on
 * `docOrderRows` is why it is never SQL — and hands each to the pure,
 * LIS-minimal `planDocRanks`, so only rows that moved change.
 */
export function planPartitionDocRanks(
  rows: readonly DocOrderRow[],
): PartitionDocRankChange[] {
  const groups = new Map<PageScope, DocOrderRow[]>();
  for (const row of rows) {
    const group = groups.get(row.pageId);
    if (group) group.push(row);
    else groups.set(row.pageId, [row]);
  }
  const changes: PartitionDocRankChange[] = [];
  for (const [pageId, group] of groups) {
    group.sort(compareDocOrder);
    for (const change of planDocRanks(group))
      changes.push({ ...change, pageId });
  }
  return changes;
}

/**
 * Re-mint `doc_rank` for every sidebar group `tx` wrote something structural
 * into — `withPageForest`'s last step before it reads its watermark, so the
 * re-mint commits atomically with the write that made it necessary, under the
 * same locks.
 *
 * Cost is the point of the design: a data-only write (typing, rename, icon,
 * fold) marked nothing and issues NO query here; a structural op in a page with
 * no sub-pages issues one indexed CTE returning no row; a drag that reorders
 * sub-pages writes only the rows `planDocRanks` re-minted, in one statement.
 * After that, a reorder is an ordinary row write, which is what lets a routed
 * collection refresh exactly the rows that moved.
 *
 * Returns what it wrote.
 */
export async function reconcileDocRanks(
  tx: PageForestTx,
): Promise<PartitionDocRankChange[]> {
  const scopes = takeDocOrderDirty(tx);
  if (scopes.length === 0) return [];
  const changes = planPartitionDocRanks(
    await docOrderRows(tx, { pageIds: scopes }),
  );
  await writeDocRanks(
    tx,
    changes.map((c) => ({ id: c.id, docRank: c.to.toJSON() })),
  );
  return changes;
}
