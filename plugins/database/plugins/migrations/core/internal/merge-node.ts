/**
 * A merge node's snapshot body as a pure function of its parents
 * (research/2026-10-22-global-single-live-migration-snapshot.md §6).
 *
 * The body is the parents' bodies folded pairwise by the 3-way merge
 * (`./snapshot-merge`), each step against the nearest common ancestor of what
 * was folded so far and the next parent, then stamped with the node's id, its
 * last parent as drizzle's `prevId`, and an empty `_meta`. The CLI's tip join
 * writes it with this function, and the body resolver (`./snapshot-bodies`)
 * recomputes it with this function — so a merge node's body never has to be
 * committed anywhere (a push carrying a merge node AND a schema migration on
 * top of it commits only the latter's body as the tip).
 *
 * The fold order changes no byte: the merge is symmetric in its two sides and
 * orders keys independently of them. Recomputing recurses only through
 * parents, which a DAG checked acyclic (`analyzeSnapshotDag`) bounds; the
 * resolver also refuses re-entry on an id it is still computing.
 */
import { snapshotAncestors, type SnapshotDag } from "./snapshot-dag";
import {
  EMPTY_SNAPSHOT_META,
  mergeSnapshots,
  type Snapshot,
  type SnapshotConflict,
} from "./snapshot-merge";

/** The outcome of folding a merge node's parents. */
export type MergeFold =
  | { ok: true; merged: Snapshot }
  | {
      ok: false;
      kind: "conflict";
      conflicts: SnapshotConflict[];
      /** The parent ids folded before the failing step ("ours"). */
      ours: readonly string[];
      theirs: string;
      base: string;
    }
  | {
      ok: false;
      kind: "ancestor";
      /** How many nearest common ancestors there were (0, or a criss-cross ≥ 2). */
      nearest: number;
      ours: readonly string[];
      theirs: string;
    };

/** The nearest common ancestors of two ancestor sets (each including its tip). */
function nearestCommonAncestors(
  dag: SnapshotDag,
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): string[] {
  const common = [...a].filter((id) => b.has(id));
  // Nearest = not a strict ancestor of another common ancestor.
  const strict = new Set<string>();
  for (const c of common) {
    for (const x of snapshotAncestors(dag, c)) if (x !== c) strict.add(x);
  }
  return common.filter((c) => !strict.has(c));
}

/**
 * Fold `order` (snapshot ids, at least two) into one merged schema. `body`
 * resolves a snapshot id's body. Never throws for a conflict or a missing
 * single ancestor — those are results the caller words.
 */
export async function foldMergeParents(
  dag: SnapshotDag,
  order: readonly string[],
  body: (id: string) => Promise<Snapshot>,
): Promise<MergeFold> {
  if (order.length < 2)
    throw new Error(
      `a merge folds at least two snapshots, got ${order.length}`,
    );
  let ours = await body(order[0]!);
  let oursAncestors = snapshotAncestors(dag, order[0]!);
  for (const [i, theirs] of order.slice(1).entries()) {
    const folded = order.slice(0, i + 1);
    const theirsAncestors = snapshotAncestors(dag, theirs);
    const nearest = nearestCommonAncestors(dag, oursAncestors, theirsAncestors);
    if (nearest.length !== 1)
      return {
        ok: false,
        kind: "ancestor",
        nearest: nearest.length,
        ours: folded,
        theirs,
      };
    const base = nearest[0]!;
    const result = mergeSnapshots(await body(base), ours, await body(theirs));
    if (!result.ok)
      return {
        ok: false,
        kind: "conflict",
        conflicts: result.conflicts,
        ours: folded,
        theirs,
        base,
      };
    ours = result.merged;
    oursAncestors = new Set([...oursAncestors, ...theirsAncestors]);
  }
  return { ok: true, merged: ours };
}

/**
 * The merge node's snapshot text: `merged` stamped with `id`, drizzle's
 * single-parent `prevId` (the parent that sorts last) and an empty `_meta`.
 */
export function mergeNodeSnapshotText(
  id: string,
  parents: readonly string[],
  merged: Snapshot,
): string {
  const snapshot: Snapshot = {
    id,
    prevId: parents[parents.length - 1]!,
    ...merged,
    _meta: EMPTY_SNAPSHOT_META,
  };
  return JSON.stringify(snapshot, null, 2);
}
