import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { PluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { buildFacetedPluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/plugins/faceted/core";
import { buildBarrelFreeTree } from "./barrel-free-tree";
import { evaluateAllBarrels, recordSlotNaming } from "./evaluated-barrels";

const enrichedTreeCache = new Map<string, Promise<PluginTree>>();

/**
 * The ENRICHED plugin tree: every facet, enriched with every barrel as the
 * build evaluated it. The only construction site of an enriched tree in the
 * repo, so everything that reads a plugin's `contributions` (both docs, every
 * per-plugin `CLAUDE.md`, the config-origin and reorderable-slots generators,
 * the page-editor checks) comes through here.
 *
 * It is the barrel-free tree's facets — the same plugin records, read again,
 * never extracted twice — plus each facet's `enrich` over the evaluated
 * records (`evaluated-barrels.ts`) and the source-scope naming settled over
 * them. Nothing is imported unless a record missed.
 *
 * WHY THE NAMING TRAVELS WITH THE MODULES. A plugin's `contributions` array is
 * not always a literal: `reorder` starts with an EMPTY array that a
 * `subscribeSlotsDeclared` callback fills, so it holds 0 entries until a
 * declaration pass has run and ~240 after. The evaluated records resolve such
 * a barrel against the full declaration (`resolveDeclarationDependent`), and
 * the facets receive modules and naming as one value — so this tree, and every
 * generated artifact downstream of it, is a function of the checkout, whatever
 * process asks for it.
 */
export function buildEnrichedTree(root: AppPath): Promise<PluginTree> {
  let cached = enrichedTreeCache.get(root);
  if (!cached) {
    cached = (async () => {
      const evaluation = await evaluateAllBarrels(root);
      const naming = await recordSlotNaming(root, "source");
      // The set the barrel-free tree was read off: its records are this
      // tree's, one listing per process.
      return buildFacetedPluginTree(joinAppPath(root, "plugins"), {
        repo: (await buildBarrelFreeTree(root)).repo,
        enrich: {
          naming,
          modulesOf: (node) => evaluation.modulesOf(node),
        },
      });
    })();
    enrichedTreeCache.set(root, cached);
  }
  return cached;
}
