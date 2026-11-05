import type {
  HostId,
  PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import { resolveComposition } from "./resolve-composition";
import type { CompositionManifest, EdgeGraph } from "./types";

/**
 * What would drop out of the bundle if `selection` were DESELECTED: `bundle(with) \
 * bundle(with `selection` removed from `selectedContributors`)`, sorted. Computed as
 * the difference of two `resolveComposition` runs so transitive cascades (deselecting
 * C drops C's hard closure, minus anything still reachable otherwise) are captured
 * for free.
 *
 * If `selection` is `entry`/`required` (hard-locked) or not actually selected, the
 * diff is empty — its hard closure is reachable from the entries regardless.
 */
export function impactOfPruning(
  graph: EdgeGraph,
  manifest: CompositionManifest,
  selection: PluginId,
  host?: HostId,
): PluginId[] {
  const withSelection = resolveComposition(graph, manifest, host);
  const withoutSelection = resolveComposition(
    graph,
    {
      ...manifest,
      selectedContributors: manifest.selectedContributors.filter(
        (x) => x !== selection,
      ),
    },
    host,
  );

  const dropped: PluginId[] = [];
  for (const id of withSelection.bundle) {
    if (!withoutSelection.bundle.has(id)) dropped.push(id);
  }
  return dropped.sort();
}

/**
 * What would be ADDED to the bundle if `candidate` were selected: `bundle(with
 * `candidate` added to selectedContributors) \ bundle(without)`, sorted. The review
 * affordance — "what does adding this option cost" — including `candidate` itself
 * plus everything its hard closure newly pulls in.
 *
 * Empty if `candidate` is already in the bundle (entry/required/via another
 * selection): selecting it adds nothing.
 */
export function impactOfSelecting(
  graph: EdgeGraph,
  manifest: CompositionManifest,
  candidate: PluginId,
  host?: HostId,
): PluginId[] {
  const withoutCandidate = resolveComposition(graph, manifest, host);
  const withCandidate = resolveComposition(
    graph,
    {
      ...manifest,
      selectedContributors: [...manifest.selectedContributors, candidate],
    },
    host,
  );

  const added: PluginId[] = [];
  for (const id of withCandidate.bundle) {
    if (!withoutCandidate.bundle.has(id)) added.push(id);
  }
  return added.sort();
}
