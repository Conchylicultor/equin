import type {
  HostId,
  PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import { graphForHosts } from "./host-view";
import { inclusionPathWithin } from "./inclusion-path";
import { resolveComposition, expandEntrySeeds } from "./resolve-composition";
import type { CompositionManifest, EdgeGraph, InclusionPath } from "./types";

/**
 * Explain why `target` is in the composition's bundle: the shortest chain of
 * edges from a seed (an entry point, or a SELECTED soft contributor) to
 * `target`. `null` if `target` is not bundled.
 *
 * The public, manifest-shaped entry point: it resolves the composition and hands
 * the resolved parts to {@link inclusionPathWithin}, which owns the BFS. The
 * split exists because `resolveComposition` itself needs an explanation — its
 * `unsatisfiedExclusions` postcondition names the import chain that re-added an
 * excluded plugin — and a resolver calling this wrapper would be a cycle (and an
 * infinite one). Both callers reach the same BFS instead of a second copy of it.
 *
 * Walked over the same host view the resolution used (`manifest.hosts`, or
 * `host` alone), so each hop names a folder that host executes.
 */
export function explainInclusion(
  graph: EdgeGraph,
  manifest: CompositionManifest,
  target: PluginId,
  host?: HostId,
): InclusionPath | null {
  const comp = resolveComposition(graph, manifest, host);
  const { seeds } = expandEntrySeeds(manifest, graph, host);
  return inclusionPathWithin(
    graphForHosts(graph, host ? [host] : manifest.hosts),
    {
      bundle: comp.bundle,
      membership: comp.membership,
      entrySeeds: seeds,
      selectedContributors: manifest.selectedContributors,
    },
    target,
  );
}
