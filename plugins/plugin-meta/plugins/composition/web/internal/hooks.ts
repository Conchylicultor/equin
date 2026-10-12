import { useEffect, useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  type ResourceError,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import {
  deserializeEdgeGraph,
  explainInclusion,
  flattenManifest,
  impactOfPruning,
  impactOfSelecting,
  resolveComposition,
  type CompositionManifest,
  type EdgeGraph,
  type InclusionPath,
} from "@plugins/plugin-meta/plugins/closure/core";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import {
  compositionData,
  manifestItemToManifest,
  type CompositionData,
  type CompositionManifestItem,
} from "@plugins/plugin-meta/plugins/composition/core";
import type { PluginNode } from "@plugins/plugin-meta/plugins/plugin-view/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import {
  setGraph,
  setRegistry,
  useActiveComposition,
  useGraph,
  useRegistry,
} from "./store";
import { useManifestItems } from "./manifests";

/** The settled composition data: the deserialized edge graph and every plugin id. */
export interface CompositionGraph {
  graph: EdgeGraph;
  allIds: PluginId[];
}

export interface CompositionDataResult {
  /**
   * The `compositionData` read itself — loading, failed or ready — so a caller
   * renders "not known yet" and "could not be read" as states rather than as an
   * empty id list or a missing graph.
   */
  data: ResourceResult<CompositionGraph>;
  /** From the `compositions` config, independent of the graph read. */
  manifests: CompositionManifest[];
}

// Deserialize the graph EXACTLY ONCE per fetched value, shared across every
// caller (the membership band runs in hundreds of tree rows at once — they must
// not each deserialize the whole graph). Keyed on the value's object identity,
// which the live read keeps stable across renders until the value changes.
let lastValue: CompositionData | null = null;
let lastGraph: CompositionGraph | null = null;

function deserialized(data: CompositionData): CompositionGraph {
  if (data === lastValue && lastGraph) return lastGraph;
  lastValue = data;
  lastGraph = { graph: deserializeEdgeGraph(data.graph), allIds: data.allIds };
  return lastGraph;
}

/** The read with its value deserialized (module-cached, see {@link deserialized}). */
function useCompositionGraph(): ResourceResult<CompositionGraph> {
  return mapResource(useLive(compositionData), deserialized);
}

/**
 * The graph to publish into the active-composition store: the ready value, or
 * — after a failed re-read — the stale one still held. `null` means "nothing to
 * publish" (the store keeps what it has); it is never rendered as an answer, as
 * every surface reads the read's own state.
 */
function graphToPublish(
  read: ResourceResult<CompositionGraph>,
): EdgeGraph | null {
  switch (read.status) {
    case "loading":
      return null;
    case "error":
      return read.stale?.graph ?? null;
    case "ready":
      return read.data.graph;
  }
}

/**
 * Fetch the closure data and rehydrate it. The serialized graph is deserialized
 * exactly once per value (module-cached, see {@link deserialized}) and published
 * into the active-composition store so the membership recompute can read it.
 * Manifests are sourced from the `compositions` config_v2 config (not the
 * `compositionData` value) and mapped to the engine's `CompositionManifest[]`
 * (dropping `id`). Safe to call from many components — the live read dedupes
 * the network request and the deserialize is shared.
 */
export function useCompositionData(): CompositionDataResult {
  const data = useCompositionGraph();
  const graph = graphToPublish(data);
  const items = useManifestItems();
  const manifests = useMemo(() => items.map(manifestItemToManifest), [items]);

  // Publish the deserialized graph into the store so the band / detail sections
  // resolve membership against it. `graph` is module-cache-stable per value, so
  // this fires once per fetch.
  useEffect(() => {
    if (graph) setGraph(graph);
  }, [graph]);

  // Publish the full manifest set so the store's resolution boundary can flatten
  // each draft's `extends` against it. `manifests` is `useMemo`-stable per `items`
  // (config) change, so this fires once per config edit, not per render.
  useEffect(() => {
    setRegistry(manifests);
  }, [manifests]);

  return { data, manifests };
}

/**
 * What the app this repo builds does NOT ship, and which half of that is a
 * decision rather than a consequence.
 *
 * `excluded` is every plugin id outside the `singularity` composition's bundle.
 * `negatedTargets` is the subset a manifest negated BY NAME (in practice the
 * `base-exclusions` row every composition inherits) — the rest are ids the
 * removal cascade took because they descend from, or import, one of those. That
 * is exactly the distinction the explorer badge draws between *Not in the app*
 * and *Not in the app (cascade)*.
 *
 * **Derived here rather than shipped.** The answer is a pure function of the
 * edge graph and the composition manifests, and the client already holds both —
 * the graph from the `compositionData` live value, the manifests from the `compositions`
 * config. A `disabledIds`-style wire field would be a SECOND spelling of a
 * computation the engine already owns, free to drift from it the moment the
 * negative pass changes; deriving it means the badge and the codegen that emits
 * the registries are reading one implementation.
 *
 * **Which config layer this reads.** The client reads the EFFECTIVE (layered)
 * config, while codegen reads the GIT layer. They coincide because a runtime
 * write to the two rows that govern this answer is refused: `save` throws for
 * `MAIN_COMPOSITION_ID` and `BASE_EXCLUSIONS_ID` (see `manifests.ts`), and the
 * surfaces render those controls inert. So no user layer can exist for either
 * row, and this badge cannot claim an exclusion the committed registries do not
 * have.
 *
 * The `pending` arm is a state to render, not an absence to collapse: before the
 * graph arrives nothing is known about any plugin, and answering with an empty
 * `excluded` would assert that every plugin ships — a claim that then reverses
 * itself. Likewise `failed` is rendered with its Retry, never left as a
 * `pending` that never ends.
 */
export type AppExclusions =
  | { kind: "pending" }
  | { kind: "failed"; error: ResourceError; refetch: () => Promise<void> }
  | {
      kind: "ready";
      /** Every id outside main's bundle — excluded on purpose or by cascade. */
      excluded: Set<PluginId>;
      /** The subset a manifest negated by name. Always ⊆ `excluded`. */
      negatedTargets: Set<PluginId>;
    };

const PENDING_EXCLUSIONS: AppExclusions = { kind: "pending" };

// Resolved ONCE per (graph, manifest-config) pair rather than per caller: the
// explorer badge asks this question from every row of a tree of ~900, and
// resolving main's whole closure per row would be that many full closures per
// render. Both inputs are reference-stable — the graph per fetched value (see
// `deserialized`), the items array per config document — so identity is the
// whole cache key, the same shape `deserialized` uses one screen up.
let exclusionsForGraph: EdgeGraph | null = null;
let exclusionsForItems: CompositionManifestItem[] | null = null;
let exclusionsCache: AppExclusions | null = null;

function appExclusions(
  graph: EdgeGraph,
  items: CompositionManifestItem[],
): AppExclusions {
  if (
    exclusionsCache &&
    exclusionsForGraph === graph &&
    exclusionsForItems === items
  ) {
    return exclusionsCache;
  }

  const registry = items.map(manifestItemToManifest);
  const main = registry.find((m) => m.name === MAIN_COMPOSITION_ID);
  // Loud rather than "nothing is excluded": the config defaults always carry
  // main's row, so reaching here means a stored manifest set replaced it — the
  // state `composition-closure` refuses, and one where every answer this hook
  // could give would be a guess about an app that has no definition.
  if (!main) {
    throw new Error(
      `The compositions config carries no "${MAIN_COMPOSITION_ID}" manifest, so what the app ships is undefined.`,
    );
  }

  // `flattenManifest` folds in the `base-exclusions` row unconditionally, which
  // is where the negatives actually live — main's own row is still `["**"]`.
  const { bundle, negatedTargets } = resolveComposition(
    graph,
    flattenManifest(main, registry),
  );
  const excluded = new Set<PluginId>();
  // Every tree node is a key in each adjacency map, so this is the full id set
  // without reaching for the value's `allIds`.
  for (const id of graph.hardForward.keys()) {
    if (!bundle.has(id)) excluded.add(id);
  }

  exclusionsCache = { kind: "ready", excluded, negatedTargets };
  exclusionsForGraph = graph;
  exclusionsForItems = items;
  return exclusionsCache;
}

/** See {@link AppExclusions}. Shares the live read with the other
 *  composition-data consumers, so calling it from every tree row costs one fetch. */
export function useAppExclusions(): AppExclusions {
  const read = useCompositionGraph();
  const items = useManifestItems();
  switch (read.status) {
    case "loading":
      return PENDING_EXCLUSIONS;
    case "error":
      return { kind: "failed", error: read.error, refetch: read.refetch };
    case "ready":
      return appExclusions(read.data.graph, items);
  }
}

/**
 * Ensure the closure graph is fetched + published to the store, without returning
 * the (potentially large) payload. For ambient consumers like the per-row
 * membership band that only need the store populated so `useActiveMembership()` can
 * resolve. The network request and deserialize are shared with `useCompositionData`.
 */
export function useEnsureCompositionData(): void {
  const graph = graphToPublish(useCompositionGraph());
  useEffect(() => {
    if (graph) setGraph(graph);
  }, [graph]);
}

/** Why `node` is in the active composition's bundle (or `null` when not bundled /
 *  no active composition / graph not loaded). The active draft is flattened
 *  against the registry so `extends`-pulled contributors are explained too. */
export function useInclusion(node: PluginNode): InclusionPath | null {
  const active = useActiveComposition();
  const graph = useGraph();
  const registry = useRegistry();
  return useMemo(() => {
    if (!active || !graph) return null;
    return explainInclusion(graph, flattenManifest(active, registry), node.id);
  }, [active, graph, registry, node.id]);
}

export interface ImpactResult {
  /** Ids that would be ADDED by selecting `node` as a contributor. */
  select: PluginId[];
  /** Ids that would be DROPPED by deselecting `node` (if currently selected). */
  prune: PluginId[];
}

/** The select/prune impact of `node` against the active composition. `null` when no
 *  active composition / graph not loaded. */
export function useImpact(node: PluginNode): ImpactResult | null {
  const active = useActiveComposition();
  const graph = useGraph();
  const registry = useRegistry();
  return useMemo(() => {
    if (!active || !graph) return null;
    const flat = flattenManifest(active, registry);
    return {
      select: impactOfSelecting(graph, flat, node.id),
      prune: impactOfPruning(graph, flat, node.id),
    };
  }, [active, graph, registry, node.id]);
}

/**
 * Whether the composition named `name` ships plugin `pluginId`, resolved IN THE
 * BROWSER from the edge graph and the manifests — the same derivation as
 * {@link useAppExclusions}, for any composition rather than main's.
 *
 * Four states, none of them a guess:
 * - `pending` — the graph has not arrived; nothing is known yet.
 * - `failed` — the graph could not be read: rendered with its Retry, never
 *   left as a `pending` that never ends.
 * - `unknown-composition` — no manifest answers to `name` (renamed or removed).
 * - `ready` — `included` is membership in the resolved bundle, `extends` and
 *   the base exclusions folded in.
 *
 * Lets a surface show a section only when the software it is about actually
 * ships the plugin behind it, without naming any composition.
 */
export type CompositionInclusion =
  | { kind: "pending" }
  | { kind: "failed"; error: ResourceError; refetch: () => Promise<void> }
  | { kind: "unknown-composition" }
  | { kind: "ready"; included: boolean };

const PENDING_INCLUSION: CompositionInclusion = { kind: "pending" };

// One resolved bundle per (graph, manifest config, composition name): every
// caller asking about the same composition shares the closure walk.
let bundleForGraph: EdgeGraph | null = null;
let bundleForItems: CompositionManifestItem[] | null = null;
const bundleCache = new Map<string, Set<PluginId> | null>();

function bundleOf(
  graph: EdgeGraph,
  items: CompositionManifestItem[],
  name: string,
): Set<PluginId> | null {
  if (bundleForGraph !== graph || bundleForItems !== items) {
    bundleCache.clear();
    bundleForGraph = graph;
    bundleForItems = items;
  }
  const cached = bundleCache.get(name);
  if (cached !== undefined) return cached;
  const registry = items.map(manifestItemToManifest);
  const manifest = registry.find((m) => m.name === name);
  const bundle = manifest
    ? resolveComposition(graph, flattenManifest(manifest, registry)).bundle
    : null;
  bundleCache.set(name, bundle);
  return bundle;
}

/**
 * `name` is `null` while the caller does not know WHICH composition to ask
 * about yet (its own read is still loading) — answered as `pending`, so a hook
 * that must run unconditionally never has to invent a placeholder name.
 */
export function useCompositionIncludes(
  name: string | null,
  pluginId: PluginId,
): CompositionInclusion {
  const read = useCompositionGraph();
  const items = useManifestItems();
  if (name === null) return PENDING_INCLUSION;
  if (read.status === "loading") return PENDING_INCLUSION;
  if (read.status === "error")
    return { kind: "failed", error: read.error, refetch: read.refetch };
  const bundle = bundleOf(read.data.graph, items, name);
  if (!bundle) return { kind: "unknown-composition" };
  return { kind: "ready", included: bundle.has(pluginId) };
}
