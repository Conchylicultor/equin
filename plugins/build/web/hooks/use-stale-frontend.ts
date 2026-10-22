import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { deployment } from "@plugins/build/plugins/deployment/core";

// Robust stale-tab detection: compare the graph hash baked into the executing
// bundle against the graph the server is currently serving — the `web` carrier's
// pin in the deployment description. Fires even for a tab that *loaded* an
// already-stale `index.html`, because the comparison is between two identities
// of the bytes rather than between two moments in time.
//
// The graph hash is a function of the composed module graph, so a rebuild that
// changed nothing republishes the same value and no tab is asked to reload — the
// per-run build id this replaced was new on every build by construction.
//
// The `baked !== "dev"` guard keeps it inert wherever the global is not injected
// (a dev server), where an absent pin would otherwise read as a permanent
// mismatch.
export function useStaleFrontend(): {
  stale: boolean;
  serverGraph: string | null;
} {
  const res = useLive(deployment);
  // Not a collapse: staleness is unknowable until the server's graph hash has
  // been received, so neither loading nor a FAILED read may claim the tab is
  // stale (or fresh) — both answer "not stale, graph unknown". A failed read
  // renders its own error where it is shown; if it failed because this tab is
  // out of date, that is the contract-mismatch signal's to say, not this one's.
  // Unavailable (a subtree with no computer behind it, the demo) is the same
  // "graph unknown": the page's own staleness is the page transport's read.
  return foldResource(res, {
    loading: () => ({ stale: false, serverGraph: null }),
    error: () => ({ stale: false, serverGraph: null }),
    unavailable: () => ({ stale: false, serverGraph: null }),
    ready: (data) => {
      // An unresolved pin (no dist yet, or one published before the trailer
      // existed) means the graph is UNKNOWN, and unknown must not arm the
      // reload dot — a missing pin can never manufacture a permanent
      // stale-tab warning.
      const web = data.deployable.find((c) => c.id === "web");
      const serverGraph =
        web !== undefined && web.graph.resolved ? web.graph.value : null;
      const baked = import.meta.env.VITE_BUILD_GRAPH ?? "dev";
      const stale = !!serverGraph && baked !== "dev" && serverGraph !== baked;
      return { stale, serverGraph };
    },
  });
}
