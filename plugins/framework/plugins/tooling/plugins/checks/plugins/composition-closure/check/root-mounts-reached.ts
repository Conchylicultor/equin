import {
  buildRegistryGenContext,
  readCompositionManifestsFromDisk,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import {
  flattenManifest,
  resolveComposition,
} from "@plugins/plugin-meta/plugins/closure/core";
import { manifestItemToManifest } from "@plugins/plugin-meta/plugins/composition/core";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import { getFacet } from "@plugins/plugin-meta/plugins/facets/core";
import { contributionsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/contributions/core";
import {
  asPath,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

/**
 * The framework's own slot group — web-sdk's `Core` (`Core.Root`, `Core.Boot`):
 * mounted by the app itself in every bundle, so a contribution there names no
 * capability that needs it. Matched by group, so a new framework slot is
 * covered without an edit. (Named rather than imported: web-sdk's barrel would
 * load the companion manifest into every CLI process, which regenerates it.)
 */
const AMBIENT_GROUP = "Core";

/**
 * No plugin is mounted at the app root while nothing reaches it.
 *
 * A composition bundles what its entries reach: imports, token uses,
 * companions, usage rules. A plugin mounted from `Core.Root` / `Core.Boot`
 * that none of those reach ships only where a composition NAMES it — and if
 * none but main (`**`) does, it is missing from every served app with no
 * warning. That is how equin.ai shipped blank icons (the sprite sheet), theme
 * fonts that never loaded and slots ignoring their layouts: each was a root
 * mount some capability needed, and nothing said so.
 *
 * So each such plugin must be named by some composition other than main. The
 * naming IS the decision of what it is: a requirement of being served
 * (`served-baseline`), an opt-in feature (a pack or a subsystem row), or part of
 * an app (its subtree). When a capability needs it, it is none of those — it is
 * a companion of that capability, and then an edge reaches it.
 */
export const rootMountsReached: Check = {
  id: "root-mounts-reached",
  description:
    "Every plugin mounted at the app root (Core.Root / Core.Boot) is reached by an edge (import, token, companion, usage) or named by a composition other than main",
  async run() {
    const root = await getWorktreeRoot();
    const { tree, graph } = await buildRegistryGenContext(root);

    const reachedByRule = new Set<PluginId>(graph.rules.map((r) => r.then));
    const items = readCompositionManifestsFromDisk(root);
    const manifests = items.map(manifestItemToManifest);
    const named = new Set<PluginId>();
    for (const item of items) {
      if (item.id === MAIN_COMPOSITION_ID) continue;
      const flat = flattenManifest(manifestItemToManifest(item), manifests);
      for (const id of resolveComposition(graph, flat).bundle) named.add(id);
    }

    const problems: string[] = [];
    for (const node of tree.byDir.values()) {
      const ambient = (getFacet(node, contributionsFacetDef)?.static ?? [])
        .map((c) => c.slot)
        .filter((slot) => slot.split(".")[0] === AMBIENT_GROUP);
      if (ambient.length === 0) continue;
      if (graph.hardReverse.get(node.id)!.length > 0) continue;
      if (reachedByRule.has(node.id) || named.has(node.id)) continue;
      problems.push(
        `${asPath(node.id)}: mounted at ${[...new Set(ambient)].join(", ")}, reached by nothing, named by no composition but main`,
      );
    }

    if (problems.length === 0) return { ok: true };
    return {
      ok: false,
      message:
        "Root mounts no served app can ship — each is in main only, and missing from every other bundle without a warning:\n  " +
        problems.join("\n  "),
      hint:
        "Say what each one is. Needed by a capability → make it that capability's companion: the owner opens a root slot " +
        "(`X.Root = defineRootSlot()`, mounted with `Core.Root({ slot: X.Root })`) and the plugin contributes " +
        "`X.Root({ component, companion: true })`. Needed to be served at all → `served-baseline`. An opt-in feature → a pack or " +
        "subsystem row in plugins/plugin-meta/plugins/composition/core/config.ts.",
    };
  },
};
