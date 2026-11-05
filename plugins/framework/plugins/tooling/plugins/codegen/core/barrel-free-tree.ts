import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { PluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { buildFacetedPluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/plugins/faceted/core";
import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";

const barrelFreeTreeCache = new Map<string, Promise<PluginTree>>();

/**
 * The barrel-FREE plugin tree — a pure function of committed plugin source
 * (facet extraction reads only .ts/.tsx/package.json; no generated manifest
 * feeds it), so it is IDENTICAL for every caller in a build. Memoized per root
 * so one `./equin build` does ONE barrel-free tree build, not one per codegen
 * step. `buildEnrichedTree` reads the same facet records again and enriches
 * them with the evaluated barrels.
 *
 * WHY ITS OWN MODULE. It is the bottom tier: the barrel evaluation needs it to
 * know every plugin's barrels and which plugins the registry omits, and the
 * enriched tree needs the evaluation. Keeping this tier free of the other two
 * is what lets them depend on it without closing an import cycle.
 *
 * `repo`: the pass's file set when the caller holds one. The build's is a
 * SNAPSHOT (blob ids), which makes the facets plugin records read from the
 * shared store; the first call's builds the tree, so the build hands it to the
 * first.
 */
export function buildBarrelFreeTree(
  root: AppPath,
  repo?: RepoFiles,
): Promise<PluginTree> {
  let cached = barrelFreeTreeCache.get(root);
  if (!cached) {
    cached = buildFacetedPluginTree(
      joinAppPath(root, "plugins"),
      repo ? { repo } : undefined,
    );
    barrelFreeTreeCache.set(root, cached);
  }
  return cached;
}
