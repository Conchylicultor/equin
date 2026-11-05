import { useSyncExternalStore } from "react";
import {
  flattenManifest,
  resolveComposition,
  type CompositionManifest,
  type EdgeGraph,
  type MembershipState,
} from "@plugins/plugin-meta/plugins/closure/core";
import type {
  HostId,
  PluginId,
} from "@plugins/framework/plugins/plugin-id/core";

/**
 * Per-plugin diff state between two resolved bundles (A = active, B = compareWith):
 * in both bundles, only A, only B, or in neither. Drives the membership band's
 * compare color mode and the pane's feature-delta list.
 */
export type DiffState = "only-a" | "only-b" | "both" | "neither";

/**
 * The active-composition store: the working DRAFT manifest the UI is currently
 * visualizing plus, derived from it + the latest deserialized graph, a membership
 * map computed ONCE per (active, graph) change.
 *
 * This is a **genuinely page-global signal** — there is one composition the user is
 * inspecting, shared across every Studio surface (the explorer tree-row bands and
 * the plugin-detail sections live in different panes of the same app). Like the
 * pane route store, the value lives in a single module-level instance whose state
 * is held in closure variables and read back through instance methods (NOT a
 * module-level `let` read directly by the `useSyncExternalStore` snapshot), so the
 * `scoped-store/no-module-mutable-store` shape does not apply.
 *
 * The graph is supplied by `useCompositionData()` (which deserializes it once); the
 * membership recompute keys on both the active manifest reference and the graph
 * reference, so swapping either re-resolves exactly once.
 */
/**
 * The host a manifest is viewed on: the one picked in the Studio's host
 * toggle, else the widest one it declares. `desktop` executes every folder
 * `browser` does, so a row declared for both is the desktop bundle — the same
 * answer as resolving it as declared.
 */
export function viewedHost(
  manifest: CompositionManifest,
  picked: HostId | null,
): HostId {
  return picked ?? (manifest.hosts.includes("desktop") ? "desktop" : "browser");
}

function createCompositionStore() {
  let activeManifest: CompositionManifest | null = null;
  // The Studio's Desktop / Browser toggle: which host every surface resolves
  // the active (and compared) composition on. `null` = as the row declares.
  let pickedHost: HostId | null = null;
  let compareManifest: CompositionManifest | null = null;
  let graph: EdgeGraph | null = null;
  // The full manifest set, published by `useCompositionData`. The resolution
  // boundary flattens active/compare against this so a composition's `extends`
  // (e.g. a profile pulling in the self-improvement PACK) is folded in before
  // closure — no caller resolves a raw, un-flattened manifest.
  let registry: CompositionManifest[] = [];

  // Cached derived membership + the (active, registry, graph) refs it was computed for.
  let membershipCache: Map<PluginId, MembershipState> | null = null;
  let membershipForActive: CompositionManifest | null = null;
  let membershipForRegistry: CompositionManifest[] | null = null;
  let membershipForGraph: EdgeGraph | null = null;
  let membershipForHost: HostId | null = null;

  // Cached derived diff map + the (active, compareWith, registry, graph) refs it was computed for.
  let diffCache: Map<PluginId, DiffState> | null = null;
  let diffForActive: CompositionManifest | null = null;
  let diffForCompare: CompositionManifest | null = null;
  let diffForRegistry: CompositionManifest[] | null = null;
  let diffForGraph: EdgeGraph | null = null;
  let diffForHost: HostId | null = null;

  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const l of listeners) l();
  };

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getActive(): CompositionManifest | null {
      return activeManifest;
    },
    getCompare(): CompositionManifest | null {
      return compareManifest;
    },
    getIsCompareMode(): boolean {
      return activeManifest !== null && compareManifest !== null;
    },
    getGraph(): EdgeGraph | null {
      return graph;
    },
    getRegistry(): CompositionManifest[] {
      return registry;
    },
    getPickedHost(): HostId | null {
      return pickedHost;
    },
    /** Recompute (and cache) membership when the active manifest, registry, or
     *  graph changed. The active draft is flattened against the registry first so
     *  its `extends` packs land in the bundle. */
    getMembership(): Map<PluginId, MembershipState> | null {
      if (!activeManifest || !graph) {
        membershipCache = null;
        membershipForActive = null;
        membershipForRegistry = null;
        membershipForGraph = null;
        return null;
      }
      if (
        membershipCache &&
        membershipForActive === activeManifest &&
        membershipForRegistry === registry &&
        membershipForGraph === graph &&
        membershipForHost === pickedHost
      ) {
        return membershipCache;
      }
      membershipCache = resolveComposition(
        graph,
        flattenManifest(activeManifest, registry),
        viewedHost(activeManifest, pickedHost),
      ).membership;
      membershipForHost = pickedHost;
      membershipForActive = activeManifest;
      membershipForRegistry = registry;
      membershipForGraph = graph;
      return membershipCache;
    },
    /** Recompute (and cache) the per-plugin A↔B diff map when active, compareWith,
     *  the registry, or the graph changed. `null` unless BOTH manifests are set
     *  (compare mode). Both sides are flattened against the registry first. */
    getDiffMap(): Map<PluginId, DiffState> | null {
      if (!activeManifest || !compareManifest || !graph) {
        diffCache = null;
        diffForActive = null;
        diffForCompare = null;
        diffForRegistry = null;
        diffForGraph = null;
        return null;
      }
      if (
        diffCache &&
        diffForActive === activeManifest &&
        diffForCompare === compareManifest &&
        diffForRegistry === registry &&
        diffForGraph === graph &&
        diffForHost === pickedHost
      ) {
        return diffCache;
      }
      // Both sides on the same host — the active one's — so the diff is
      // about the manifests, never about the hosts they declare.
      const host = viewedHost(activeManifest, pickedHost);
      const bundleA = resolveComposition(
        graph,
        flattenManifest(activeManifest, registry),
        host,
      ).bundle;
      const bundleB = resolveComposition(
        graph,
        flattenManifest(compareManifest, registry),
        host,
      ).bundle;
      diffForHost = pickedHost;
      const map = new Map<PluginId, DiffState>();
      // Every node defaults to "neither"; mark bundle members from each side.
      for (const id of graph.hardForward.keys()) map.set(id, "neither");
      for (const id of bundleA) {
        map.set(id, bundleB.has(id) ? "both" : "only-a");
      }
      for (const id of bundleB) {
        if (!bundleA.has(id)) map.set(id, "only-b");
      }
      diffCache = map;
      diffForActive = activeManifest;
      diffForCompare = compareManifest;
      diffForRegistry = registry;
      diffForGraph = graph;
      return diffCache;
    },
    setGraph(next: EdgeGraph): void {
      if (graph === next) return;
      graph = next;
      emit();
    },
    setRegistry(next: CompositionManifest[]): void {
      if (registry === next) return;
      registry = next;
      emit();
    },
    setActive(manifest: CompositionManifest | null): void {
      activeManifest = manifest;
      emit();
    },
    setCompare(manifest: CompositionManifest | null): void {
      compareManifest = manifest;
      emit();
    },
    setPickedHost(host: HostId | null): void {
      if (pickedHost === host) return;
      pickedHost = host;
      emit();
    },
  };
}

const store = createCompositionStore();

/** Populated by `useCompositionData()` with the once-deserialized graph. */
export function setGraph(next: EdgeGraph): void {
  store.setGraph(next);
}

export function getGraph(): EdgeGraph | null {
  return store.getGraph();
}

/** Published by `useCompositionData()` with the full manifest set, so the
 *  resolution boundary can flatten `extends` against it. */
export function setRegistry(next: CompositionManifest[]): void {
  store.setRegistry(next);
}

export function getRegistry(): CompositionManifest[] {
  return store.getRegistry();
}

export function getActiveComposition(): CompositionManifest | null {
  return store.getActive();
}

export function getActiveMembership(): Map<PluginId, MembershipState> | null {
  return store.getMembership();
}

export function setActiveComposition(manifest: CompositionManifest | null): void {
  store.setActive(manifest);
}

/** Set (or clear) the composition to compare the active one against. Setting both
 *  active and compareWith enters compare mode (`useIsCompareMode()` → true). */
export function setCompareComposition(manifest: CompositionManifest | null): void {
  store.setCompare(manifest);
}

/** Pin a single plugin as the composition root — visualize the closure from here.
 *  Sets an ad-hoc draft with the plugin's whole subtree (`id.**`) as the sole entry
 *  and no selected contributors, so pinning keeps whole-subtree closure behavior
 *  (a bare id would now resolve to the node + its hard deps only). */
export function pinAsRoot(id: PluginId): void {
  store.setActive({
    name: "(pinned)",
    hosts: ["desktop"],
    entryPoints: [`${id}.**`],
    selectedContributors: [],
  });
}

/** Pick the host every Studio surface views the composition on (`null`: as
 *  the row declares). */
export function setViewHost(host: HostId | null): void {
  store.setPickedHost(host);
}

/** The picked host, `null` when the row's declaration decides. */
export function usePickedHost(): HostId | null {
  return useSyncExternalStore(
    store.subscribe,
    store.getPickedHost,
    store.getPickedHost,
  );
}

/** The host the active composition is viewed on, or `null` with none active. */
export function useViewHost(): HostId | null {
  const active = useActiveComposition();
  const picked = usePickedHost();
  return active ? viewedHost(active, picked) : null;
}

export function clearActive(): void {
  store.setActive(null);
  store.setCompare(null);
}

/** Patch the active draft (e.g. toggle a selectedContributor). No-op if no active
 *  composition. Replaces the manifest reference so membership re-resolves once. */
export function updateActiveDraft(patch: Partial<CompositionManifest>): void {
  const active = store.getActive();
  if (!active) return;
  store.setActive({ ...active, ...patch });
}

// ── React hooks ───────────────────────────────────────────────────────────

export function useActiveComposition(): CompositionManifest | null {
  return useSyncExternalStore(store.subscribe, store.getActive, store.getActive);
}

export function useActiveMembership(): Map<PluginId, MembershipState> | null {
  return useSyncExternalStore(store.subscribe, store.getMembership, store.getMembership);
}

export function useGraph(): EdgeGraph | null {
  return useSyncExternalStore(store.subscribe, store.getGraph, store.getGraph);
}

export function useRegistry(): CompositionManifest[] {
  return useSyncExternalStore(store.subscribe, store.getRegistry, store.getRegistry);
}

export function useCompareComposition(): CompositionManifest | null {
  return useSyncExternalStore(store.subscribe, store.getCompare, store.getCompare);
}

export function useIsCompareMode(): boolean {
  return useSyncExternalStore(
    store.subscribe,
    store.getIsCompareMode,
    store.getIsCompareMode,
  );
}

export function useDiffMap(): Map<PluginId, DiffState> | null {
  return useSyncExternalStore(store.subscribe, store.getDiffMap, store.getDiffMap);
}
