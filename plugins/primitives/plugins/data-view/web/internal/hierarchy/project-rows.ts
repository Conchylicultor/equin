import type { HierarchyConfig } from "../../../core";
import { Rank } from "@plugins/primitives/plugins/rank/core";

/**
 * The projected tree row: the original `TRow` plus the `TreeItem` fields the
 * tree primitive needs (`id`, `parentId`, `rank`, `expanded`). We keep the
 * original row reachable via `__row` so callbacks recover the concrete `TRow`.
 * `alias` marks a reference node synthesized from `hierarchy.getAliasParents`
 * — the same `__row` rendered as a read-only leaf under an additional parent.
 */
export type ProjectedRow<TRow> = {
  id: string;
  parentId: string | null;
  rank: Rank;
  expanded: boolean;
  alias: boolean;
  __row: TRow;
};

// Alias node ids: `<rowKey>\u0000alias\u0000<parentRowKey>`. A NUL byte cannot
// appear in a real row key, so the encoding is collision-free and reversible.
const ALIAS_SEP = "\u0000alias\u0000";
export const aliasNodeId = (rowId: string, parentId: string) =>
  `${rowId}${ALIAS_SEP}${parentId}`;
export const isAliasNodeId = (id: string) => id.includes(ALIAS_SEP);
export const realNodeId = (id: string) => {
  const i = id.indexOf(ALIAS_SEP);
  return i === -1 ? id : id.slice(0, i);
};

/**
 * Ranks for one alias-parent's run of `count` reference leaves: minted as a
 * contiguous run AFTER that parent's last real child (`maxRealRank`), so alias
 * ranks are distinct both from the real siblings' and from each other, and rank
 * order agrees with the display order (the alias pass appends them last).
 *
 * Distinctness is load-bearing, not cosmetic. A row's rank is only meaningful
 * within its own sibling group, so an alias carrying its row's own rank imports
 * a key from a foreign group: with per-group ranks minted `a0, a1, …`, an alias
 * of any parent's first child lands on `a0` and collides with the host parent's
 * own first child, putting rank order at odds with paint order.
 *
 * It used to be worse: the drop path rank-SORTED a parent's children to find a
 * drop's neighbours, so the duplicate made `Rank.between(a0, a0)` throw and
 * silently swallowed the drag — for drops on the REAL rows beside the alias
 * too. The tree's drop contract is anchor-only now (`resolveDropParent`), so
 * what minting still protects is the display invariant.
 */
function mintAliasRanks(
  maxRealRank: Rank | null,
  count: number,
  fallback: () => Rank[],
): Rank[] {
  try {
    return Rank.nBetween(maxRealRank, null, count);
    // eslint-disable-next-line promise-safety/no-bare-catch -- Rank.nBetween throws a plain Error on an exhausted/corrupt neighbourhood; aliases are read-only navigation leaves, so degrading to the row's own rank (today's behavior) keeps them rendered and reachable rather than dropping them from the tree. The collision hazard above is what this fallback re-admits, bounded to a rank space already corrupt.
  } catch {
    return fallback();
  }
}

/**
 * Project each raw row → a `TreeItem`-shaped row, plus a map back to the
 * original so `TreeList` callbacks recover the concrete `TRow`. Pure: the same
 * inputs always yield the same projection (the caller memoizes).
 *
 * `expanded` comes only from the view's own per-(surface, view-instance, row)
 * expand map, falling back to `defaultExpanded`: there is no consumer-supplied
 * expand accessor, so a row's collapse state can never be domain data.
 */
export function projectRows<TRow>(args: {
  rows: readonly TRow[];
  rowKey: (row: TRow, index: number) => string;
  hierarchy: HierarchyConfig<TRow>;
  expanded: Record<string, boolean> | undefined;
  defaultExpanded: boolean | undefined;
}): { projected: ProjectedRow<TRow>[]; originalById: Map<string, TRow> } {
  const { rows, rowKey, hierarchy, expanded, defaultExpanded } = args;
  const byId = new Map<string, TRow>();
  const out: ProjectedRow<TRow>[] = [];
  // Per-parent max REAL rank, accumulated in the real pass so the alias pass can
  // mint after each host parent's last real child.
  const maxRankByParent = new Map<string, Rank>();

  rows.forEach((row, i) => {
    const id = rowKey(row, i);
    byId.set(id, row);
    const parentId = hierarchy.getParentId(row);
    const rank = hierarchy.getRank(row);
    if (parentId !== null) {
      const prevMax = maxRankByParent.get(parentId);
      if (prevMax === undefined || Rank.compare(rank, prevMax) > 0) {
        maxRankByParent.set(parentId, rank);
      }
    }
    out.push({
      id,
      parentId,
      rank,
      expanded: expanded?.[id] ?? defaultExpanded ?? false,
      alias: false,
      __row: row,
    });
  });

  // Second pass: synthesize the alias (reference) leaves AFTER every real node,
  // so `buildTree` (insertion-order children) lands them last among each
  // parent's children. Grouped by alias-parent so each parent's aliases mint as
  // one contiguous run past its last real child — see `mintAliasRanks`.
  const getAliasParents = hierarchy.getAliasParents;
  if (getAliasParents) {
    const byAliasParent = new Map<string, { nodeId: string; row: TRow }[]>();
    rows.forEach((row, i) => {
      const id = rowKey(row, i);
      const realParentId = hierarchy.getParentId(row);
      for (const parent of getAliasParents(row)) {
        if (parent === id || parent === realParentId || !byId.has(parent)) {
          continue;
        }
        const nodeId = aliasNodeId(id, parent);
        if (byId.has(nodeId)) continue; // duplicate edge
        byId.set(nodeId, row);
        const list = byAliasParent.get(parent);
        if (list) list.push({ nodeId, row });
        else byAliasParent.set(parent, [{ nodeId, row }]);
      }
    });
    for (const [parent, entries] of byAliasParent) {
      const ranks = mintAliasRanks(
        maxRankByParent.get(parent) ?? null,
        entries.length,
        () => entries.map((e) => hierarchy.getRank(e.row)),
      );
      entries.forEach((entry, k) => {
        out.push({
          id: entry.nodeId,
          parentId: parent,
          rank: ranks[k]!,
          expanded: false,
          alias: true,
          __row: entry.row,
        });
      });
    }
  }

  return { projected: out, originalById: byId };
}
