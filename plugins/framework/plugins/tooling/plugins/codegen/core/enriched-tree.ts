import { sharedWork } from "@plugins/packages/plugins/shared-work/core";
import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { PluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { buildFacetedPluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/plugins/faceted/core";
import { evaluateAllBarrels, recordSlotNaming } from "./evaluated-barrels";
import type { CodegenPass } from "./codegen-pass";

const enrichedTrees = new WeakMap<CodegenPass, Promise<PluginTree>>();

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
 * process asks for it. Memoized per pass (`codegen-pass.ts`).
 */
export function buildEnrichedTree(pass: CodegenPass): Promise<PluginTree> {
  let cached = enrichedTrees.get(pass);
  if (!cached) {
    cached = sharedWork("enriched plugin tree", async () => {
      const evaluation = await evaluateAllBarrels(pass);
      const naming = await recordSlotNaming(pass, "source");
      // The set the barrel-free tree was read off: its records are this
      // tree's.
      return buildFacetedPluginTree(joinAppPath(pass.root, "plugins"), {
        repo: pass.repo,
        enrich: {
          naming,
          modulesOf: (node) => evaluation.modulesOf(node),
        },
      });
    });
    enrichedTrees.set(pass, cached);
  }
  return cached;
}
