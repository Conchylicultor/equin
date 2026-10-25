import { getConfig } from "@plugins/config_v2/server";
import {
  classifyEdges,
  flattenManifest,
  resolveComposition,
} from "@plugins/plugin-meta/plugins/closure/core";
import {
  compositionsConfig,
  manifestItemToManifest,
} from "@plugins/plugin-meta/plugins/composition/core";
import { getFacet } from "@plugins/plugin-meta/plugins/facets/core";
import { deploySecretsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/deploy-secrets/core";
import type { PluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { getFacetsTreeCached } from "@plugins/plugin-meta/plugins/plugin-tree/server";
import { mergeDeclarations, type RequiredSecret } from "./plan";

/**
 * Every deploy secret a composition's closure needs.
 *
 * The closure is the one `resolveComposition` computes — the same static
 * closure converge's guards and the release build read — and the declarations
 * are each member's `deploy-secrets` facet (its `defineDeploySecret` calls in
 * `core/`). No plugin is named here: a second plugin declaring a secret is
 * picked up with no edit to this file.
 *
 * Throws for a composition the `compositions` config does not hold: a gate
 * that cannot compute the closure must not pass the run.
 */
export async function requiredDeploySecrets(
  compositionId: string,
): Promise<RequiredSecret[]> {
  return requiredInTree(await getFacetsTreeCached(), compositionId);
}

function requiredInTree(
  tree: PluginTree,
  compositionId: string,
): RequiredSecret[] {
  const items = getConfig(compositionsConfig).manifests;
  const item = items.find((m) => m.name === compositionId);
  if (!item) {
    throw new Error(
      `[deploy-secrets] "${compositionId}" is not a composition, so the secrets its closure needs cannot be computed.`,
    );
  }
  const flat = flattenManifest(
    manifestItemToManifest(item),
    items.map(manifestItemToManifest),
  );
  const bundle = resolveComposition(classifyEdges(tree), flat).bundle;
  const declared = [...tree.byDir.values()]
    .filter((node) => bundle.has(node.id))
    .flatMap((node) => {
      // Every node of a faceted tree carries the facet; one that does not is a
      // tree built without it, and reading it as "declares nothing" would pass
      // a run whose secrets were never looked at.
      const data = getFacet(node, deploySecretsFacetDef);
      if (data === undefined) {
        throw new Error(
          `[deploy-secrets] plugin ${node.id} has no "${deploySecretsFacetDef.id}" facet — the plugin tree was built without it.`,
        );
      }
      return data.declared.map((d) => ({
        plugin: node.id,
        key: d.key,
        description: d.description,
      }));
    });
  return mergeDeclarations(declared);
}
