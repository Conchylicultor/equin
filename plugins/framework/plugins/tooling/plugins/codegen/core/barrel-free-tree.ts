import { sharedWork } from "@plugins/packages/plugins/shared-work/core";
import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { PluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { buildFacetedPluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/plugins/faceted/core";
import type { CodegenPass } from "./codegen-pass";

const barrelFreeTrees = new WeakMap<CodegenPass, Promise<PluginTree>>();

/**
 * The barrel-FREE plugin tree — a pure function of committed plugin source
 * (facet extraction reads only .ts/.tsx/package.json; no generated manifest
 * feeds it), so it is IDENTICAL for every caller in a pass. Memoized per pass
 * so one `./equin build` does ONE barrel-free tree build, not one per codegen
 * step. `buildEnrichedTree` reads the same facet records again and enriches
 * them with the evaluated barrels.
 *
 * WHY ITS OWN MODULE. It is the bottom tier: the barrel evaluation needs it to
 * know every plugin's barrels and which plugins the registry omits, and the
 * enriched tree needs the evaluation. Keeping this tier free of the other two
 * is what lets them depend on it without closing an import cycle.
 *
 * Read off the pass's set (`CodegenPass.repo`): a snapshot (blob ids), which
 * makes the facets plugin records read from the shared store.
 */
export function buildBarrelFreeTree(pass: CodegenPass): Promise<PluginTree> {
  let cached = barrelFreeTrees.get(pass);
  if (!cached) {
    cached = sharedWork("barrel-free plugin tree", () =>
      buildFacetedPluginTree(joinAppPath(pass.root, "plugins"), {
        repo: pass.repo,
      }),
    );
    barrelFreeTrees.set(pass, cached);
  }
  return cached;
}
