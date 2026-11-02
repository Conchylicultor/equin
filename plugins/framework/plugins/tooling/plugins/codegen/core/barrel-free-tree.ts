import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  buildPluginTree,
  type PluginTree,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";

const barrelFreeTreeCache = new Map<string, Promise<PluginTree>>();

/**
 * The barrel-FREE plugin tree (`skipBarrelImport`) — a pure function of committed
 * plugin source (facet extraction reads only .ts/.tsx/package.json; no generated
 * manifest feeds it), so it is IDENTICAL for every skipBarrelImport caller in a
 * build. Memoized per root so one `./equin build` does ONE barrel-free tree
 * build, not one per codegen step. Twin of `buildEnrichedTree` (which is the
 * enriched, barrel-imported tree; the two are deliberately separate caches).
 *
 * WHY ITS OWN MODULE. This is the bottom tier of codegen's three-tier ordering:
 * `barrel-free-tree` → `slot-declaration-guard` → `enriched-tree`. The guard
 * needs a barrel-free tree to compute the disabled set, and the enriched tree
 * needs the guard to have declared slots before anything reads `contributions`.
 * Keeping this tier free of the other two is what lets the enriched tree depend
 * on the declaration pass without closing an import cycle.
 */
export function buildBarrelFreeTree(root: AppPath): Promise<PluginTree> {
  let cached = barrelFreeTreeCache.get(root);
  if (!cached) {
    cached = buildPluginTree(joinAppPath(root, "plugins"), {
      skipBarrelImport: true,
      facets: true,
    });
    barrelFreeTreeCache.set(root, cached);
  }
  return cached;
}
