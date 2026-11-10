import type { LiveRowsCollection } from "@plugins/network/plugins/live/core";
import type { Rank } from "@plugins/primitives/plugins/rank/core";
import type { LiveTreeAliases } from "../../../core";

/**
 * A live tree's reference edges (`LiveHierarchyConfig.aliases`), typed by the
 * collection they are read from: `collection` holds one row per parent, keyed
 * by the tree row's id, and `targets` names the ids that row references —
 * each drawn as a read-only reference child of the parent. `rank`, when
 * given, places a reference among the parent's real children (a rank in the
 * tree's own `rank` space; `null` = after them).
 *
 * ```tsx
 * hierarchy={{ aliases: treeAliases({
 *   collection: pageLinkTargets,
 *   targets: (row) => row.linksTo,
 *   rank: (row, target) => row.linkRanks[target] ?? null,
 * }) }}
 * ```
 */
export function treeAliases<Edges>(spec: {
  collection: LiveRowsCollection<Edges> & { readonly id: keyof Edges & string };
  targets: (edges: Edges) => readonly string[];
  rank?: (edges: Edges, target: string) => Rank | null;
}): LiveTreeAliases {
  return spec as unknown as LiveTreeAliases;
}
