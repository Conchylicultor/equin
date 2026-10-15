import {
  classifyEdges,
  flattenManifest,
  resolveComposition,
  type EdgeGraph,
} from "@plugins/plugin-meta/plugins/closure/core";
import {
  compositionsConfig,
  manifestItemToManifest,
  type CompositionManifestItem,
} from "@plugins/plugin-meta/plugins/composition/core";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import {
  asPath,
  asPluginId,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import type { PluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { readGitLayerConfig } from "./git-layer-config";

// The composition plugin's own id, from which its config directory is derived
// (`config/<asPath(id)>/<name>.{origin.,}jsonc`) — the same relPath key
// `renderConfigOriginContent` emits. Derived through the canonical helpers
// rather than hardcoding "plugin-meta/composition".
const COMPOSITION_PLUGIN_ID = asPluginId("plugin-meta.composition");

/**
 * The committed composition manifests, off disk. Every build-time consumer needs
 * this exact read — registry codegen (which composition are these registries
 * for?), `composition-closure` (are the manifests valid?) and
 * `plugins-registry-in-sync` (does main's closure render the committed
 * registries?) — and a second hand-rolled copy of the path derivation plus the
 * hash-header contract is precisely how they would come to disagree about what
 * the repo declares.
 *
 * Reads the GIT layer only: a per-worktree user edit must not be able to move a
 * committed registry or a committed doc, which it could not do anyway (the write
 * is refused for main's row) and which would be silently inert if it did.
 */
export function readCompositionManifestsFromDisk(
  root: string,
): CompositionManifestItem[] {
  return readGitLayerConfig(compositionsConfig, {
    root,
    hierarchyPath: asPath(COMPOSITION_PLUGIN_ID),
  }).manifests;
}

/**
 * What the app SHIPS, as the manifest declares it: the `singularity`
 * composition's resolved closure, plus the ids its negatives name directly.
 *
 * This is the one answer to "is this plugin in the app?". A plugin leaves the app
 * by being negated out of a manifest — there is no second mechanism (the
 * `singularity.disabled` package.json flag it replaced is gone), so codegen
 * filters every registry, every generated origin and every doc marker by exactly
 * this set.
 */
export interface MainComposition {
  /** Every plugin id `singularity`'s hard closure bundles. */
  bundle: Set<PluginId>;
  /**
   * The ids a negative entry pattern names directly, after the explicit-positive
   * protection. Everything else missing from `bundle` is there because the
   * removal cascade took it (a descendant, or an importer that would crash
   * without it) — which is the seed-vs-cascade distinction the docs annotate.
   */
  negated: Set<PluginId>;
  /** The row's declared `home` (unresolved — `resolveRegistryHome` validates it). */
  home: string;
}

/**
 * Resolve `singularity`'s closure from the committed manifests.
 *
 * THROWS when the `singularity` row is missing, and when the resolved
 * composition carries `unsatisfiedExclusions` — a negative that did not take
 * effect. Neither is a case to degrade around: emitting a registry that
 * contradicts the manifest is exactly the silent divergence this phase removes,
 * and "everything" is the most dangerous possible fallback (it would ship the
 * plugins the repo just declared it does not want).
 */
export function resolveMainComposition(
  graph: EdgeGraph,
  root: string,
): MainComposition {
  const items = readCompositionManifestsFromDisk(root);
  const mainItem = items.find((m) => m.id === MAIN_COMPOSITION_ID);
  if (!mainItem) {
    throw new Error(
      `No "${MAIN_COMPOSITION_ID}" composition in the manifest registry. ` +
        `The main app is an ordinary composition entry — without it there is nothing ` +
        `to render the committed registries from. Restore the "${MAIN_COMPOSITION_ID}" ` +
        `seed (entry points \`["**"]\`) in plugins/plugin-meta/plugins/composition/core/config.ts.`,
    );
  }
  const manifest = flattenManifest(
    manifestItemToManifest(mainItem),
    items.map(manifestItemToManifest),
  );
  const resolved = resolveComposition(graph, manifest);
  if (resolved.unsatisfiedExclusions.length > 0) {
    // `path` is total: an entry here is a negated id that is nevertheless in the
    // hard closure, so a backward chain to some seed provably exists (the engine
    // throws rather than hand back a hole). Already sorted by target.
    const lines = resolved.unsatisfiedExclusions.map(
      ({ target, path }) =>
        `  - ${target} is still bundled via ` +
        `${path.origin} → ${path.steps.map((s) => s.to).join(" → ")}`,
    );
    throw new Error(
      `The "${MAIN_COMPOSITION_ID}" composition contradicts its own manifest: ` +
        `${resolved.unsatisfiedExclusions.length} declared exclusion(s) did not take effect.\n` +
        `${lines.join("\n")}\n` +
        `A build must never emit registries that disagree with the manifest. Either the ` +
        `importer named above should be excluded too, or the exclusion should be dropped ` +
        `(plugins/plugin-meta/plugins/composition/core/config.ts).`,
    );
  }
  // The negated set comes off the SAME resolution that produced the bundle,
  // never from a re-parse of the patterns somewhere else — that is how a doc
  // marker would start disagreeing with the registry it annotates.
  return {
    bundle: resolved.bundle,
    negated: resolved.negatedTargets,
    home: mainItem.home,
  };
}

/** {@link resolveMainComposition} from a tree, for the callers that hold one and
 *  have no other use for the edge graph. */
export function mainComposition(
  tree: PluginTree,
  root: string,
): MainComposition {
  return resolveMainComposition(classifyEdges(tree), root);
}

/** Just the membership set — the common ask (`bundle.has(id)` = "in the app"). */
export function mainBundle(tree: PluginTree, root: string): Set<PluginId> {
  return mainComposition(tree, root).bundle;
}
