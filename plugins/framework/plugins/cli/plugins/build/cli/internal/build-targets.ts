import { asPath, asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { readEffectiveConfigFromDisk } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import {
  assertCompositionId,
  compositionsConfig,
  type CompositionManifestItem,
} from "@plugins/plugin-meta/plugins/composition/core";
import {
  namespaceCollision,
  probeNamespace,
} from "@plugins/infra/plugins/worktree/server";
import {
  MAIN_COMPOSITION_ID,
  namespaceFor,
  type CheckoutRef,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import { getMainRepoRoot } from "@plugins/infra/plugins/spawn/core";
import { configDir } from "@plugins/config_v2/data-dirs";

/**
 * WHAT one `./equin build` invocation deploys — the one place that decides
 * what a build TARGET is.
 *
 * A target is a (composition, checkout) pair, and the checkout half is the same
 * for every target of one invocation: you build the tree you are standing in.
 * The composition half comes from `--composition`, defaulting to the app this
 * repo builds. `namespaceFor` joins them, so `build` from main publishes
 * `sonata`, and the same command in a worktree publishes `sonata.att-x` — a
 * separate namespace, dist and database, which is the whole point of the phase.
 *
 * Everything a target needs to be legal is decided HERE, before any work: the id
 * exists in the manifest, it is a legal composition id, and no other owner
 * already holds the namespace it would claim. A build that is going to be
 * refused must cost milliseconds, not the ten minutes it takes to reach the
 * step that would have noticed.
 */
export interface BuildTarget {
  /** The composition id — `MAIN_COMPOSITION_ID` for a plain build. */
  composition: string;
  /** Where it is served: `namespaceFor(composition, checkout)`. */
  namespace: Namespace;
  /** Its resolved manifest row, so callers never re-read the config to find it. */
  item: CompositionManifestItem;
  /**
   * Whether this is the checkout's OWN app. Two things differ for it and only
   * for it, and both are opposite operations rather than a flag on one:
   * its database is the worktree FORK (which carries main's data and must never
   * be created empty), and it claims no `composition.json` marker (the namespace
   * belongs to the checkout, and a marker there would make a same-named worktree
   * checkout refuse to be created).
   */
  isMainComposition: boolean;
}

// The `compositions` config's owning plugin — where its jsonc files live under
// `config/` and the per-namespace user config dir.
const COMPOSITIONS_HIERARCHY_PATH = asPath(
  asPluginId("plugin-meta.composition"),
);

/**
 * The compositions THIS CHECKOUT declares: the resolved `compositions` config —
 * git layer plus the user edits propagated into this checkout's own namespace —
 * read straight off disk.
 *
 * DELIBERATELY DIFFERENT from `assertKnownCompositions`
 * (`./app-artifacts.ts`), which reads the CODE SEED
 * (`compositionsConfig.fields.manifests.defaultValue`) and is what the hermetic
 * posture validates against. The divergence is real and intended: a composition
 * created in Studio exists only in a user layer, and it must be servable — that
 * is the surface that creates one — while a release is cut from what the source
 * tree declares. Stated at both ends so neither is mistaken for the other's
 * approximation.
 *
 * Read off disk rather than through an `import()` of the config module by the
 * same rule the whole CLI obeys: nothing in this process's import closure may
 * reach a registered codegen manifest, or `cli:codegen-manifests-not-frozen`
 * fires. `compositionsConfig` itself is a plain descriptor — the *values* are
 * what must come from the filesystem.
 */
export function readCheckoutCompositions(
  root: string,
  checkout: CheckoutRef,
): CompositionManifestItem[] {
  const values = readEffectiveConfigFromDisk(compositionsConfig, {
    root,
    userConfigDir: configDir.file(namespaceFor(MAIN_COMPOSITION_ID, checkout)),
    hierarchyPath: COMPOSITIONS_HIERARCHY_PATH,
  });
  return values.manifests;
}

/**
 * What one invocation is building, and the document it was decided from.
 *
 * `manifest` comes back alongside the targets because stage 1 needs the WHOLE
 * document, not just the rows it is building: a composition's `extends` names
 * other manifest entries, and `flattenManifest` resolves them against this list.
 * Returning the one read rather than letting the caller take a second is the
 * same rule the reset guard states — two reads of one config are two documents
 * that can disagree.
 */
export interface ResolvedBuildTargets {
  /** Every composition THIS CHECKOUT declares, in manifest order. */
  manifest: CompositionManifestItem[];
  /** The subset being built, in the order given on the command line. */
  targets: BuildTarget[];
}

/**
 * Resolve `--composition <id...>` (or its absence) into the ordered set of
 * namespaces this invocation will publish.
 *
 * THROWS on anything that makes a target illegal — an unknown id, an id that is
 * not a legal composition name, a namespace another owner holds. A throw rather
 * than a result: every one of these is a caller mistake with nothing to fall
 * back to, and `build`'s own error path renders it.
 */
export async function resolveBuildTargets(opts: {
  /** The checkout being built — its tree, its config, its namespaces. */
  root: string;
  /** The ids from `--composition`; empty means "this checkout's own app". */
  requested: readonly string[];
  /** Which checkout `root` is, minted once by the caller. */
  checkout: CheckoutRef;
}): Promise<ResolvedBuildTargets> {
  const { root, requested, checkout } = opts;
  const items = readCheckoutCompositions(root, checkout);
  const byId = new Map(items.map((i) => [i.id, i]));

  const ids = requested.length > 0 ? [...requested] : [MAIN_COMPOSITION_ID];

  // One throw naming EVERY unknown id plus the known set: someone fixing two
  // typos should not have to run twice to find the second.
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown composition${unknown.length > 1 ? "s" : ""} ` +
        `${unknown.map((id) => `"${id}"`).join(", ")}. ` +
        `Known in this checkout: ${items.map((i) => i.id).join(", ")}`,
    );
  }

  // The namespace-collision probe reads git state (a worktree dir, a branch),
  // which lives under the MAIN checkout even when this build runs from a linked
  // one — so it is the root to probe against. Memoized, so this is one spawn.
  const mainRoot = await getMainRepoRoot(root);
  const compositionIds = new Set(items.map((i) => i.id));

  const targets: BuildTarget[] = [];
  const seen = new Set<string>();
  for (const composition of ids) {
    // A repeated `--composition sonata sonata` would deploy the same namespace
    // twice in one invocation, the second run sweeping the first's staging dir.
    if (seen.has(composition)) continue;
    seen.add(composition);

    assertCompositionId(composition);
    const namespace = namespaceFor(composition, checkout);
    const isMainComposition = composition === MAIN_COMPOSITION_ID;

    // Only a composition CLAIMS a namespace. The checkout's own app is already
    // the owner of its namespace — that is what the elision rule says — so
    // probing it as a claimant would have it collide with itself (its spec dir
    // exists and carries no composition marker, which is precisely the arm that
    // refuses a foreign dir).
    if (!isMainComposition) {
      const collision = namespaceCollision(
        namespace,
        { kind: "composition", id: composition },
        probeNamespace(mainRoot, namespace, compositionIds),
      );
      if (collision !== null) {
        throw new Error(`composition "${composition}": ${collision}`);
      }
    }

    targets.push({
      composition,
      namespace,
      // Non-null by the `unknown` check above.
      item: byId.get(composition)!,
      isMainComposition,
    });
  }
  return { manifest: items, targets };
}
