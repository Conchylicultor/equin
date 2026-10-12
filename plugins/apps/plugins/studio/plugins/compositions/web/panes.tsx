import { useEffect, useRef, type ReactElement } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { studioApp } from "@plugins/apps/plugins/studio/plugins/shell/core";
import {
  useCompositionData,
  useManifestItems,
  setActiveComposition,
  setCompareComposition,
} from "@plugins/plugin-meta/plugins/composition/web";
import {
  compositionsRoute,
  compositionDetailRoute,
} from "@plugins/apps/plugins/studio/plugins/compositions/core";
import { CompositionsList } from "./components/compositions-list";
import { CompareView, DEFAULT_A, DEFAULT_B } from "./components/compare-view";
import { useSeedActiveComposition } from "./internal/use-seed-active-composition";
import { CompositionDetail } from "./slots";

// Panes are declared first so their types are known before the component bodies
// reference them. Component identifiers below are function declarations
// (hoisted), so the forward reference is safe at runtime.

export const compositionsPane = Pane.define({
  title: "Compositions",
  route: compositionsRoute,
  app: studioApp,
  component: CompositionsBody,
  width: 380,
});

function useResolveComposition({ id }: { id: string }): ResolveResult {
  const items = useManifestItems();
  const { data } = useCompositionData();
  if (data.status === "loading" && items.length === 0)
    return { status: "pending" };
  return { status: items.some((it) => it.id === id) ? "found" : "missing" };
}

/** The composition's name from the manifests config, or undefined while it loads. */
function useCompositionTitle({ id }: { id: string }): string | undefined {
  return useManifestItems().find((it) => it.id === id)?.name;
}

export const compositionDetailPane = Pane.define({
  // Identity (id / `comp/:id` segment / the compositions ancestor) comes from
  // the route in `core/`, so the cross-app links built from it land here.
  route: compositionDetailRoute,
  app: studioApp,
  component: CompositionDetailBody,
  // Wider than release-detail's 480: it hosts the closure plugin tree.
  width: 560,
  useResolve: useResolveComposition,
  title: { useText: useCompositionTitle },
  // Main surface: the release-run pane pushed to the right is a drill-in — it
  // never steals the tab title from the composition.
  titleOwner: true,
});

export const comparePane = Pane.define({
  title: "Compare",
  route: defineRoute({
    id: "composition-compare",
    segment: "compare",
    parent: compositionsRoute,
  }),
  app: studioApp,
  component: CompareBody,
  width: 480,
});

function CompositionsBody(): ReactElement {
  return (
    <PaneChrome pane={compositionsPane}>
      <CompositionsList />
    </PaneChrome>
  );
}

function CompositionDetailBody(): ReactElement {
  const { id } = compositionDetailPane.useParams();
  useSeedActiveComposition(id);

  return (
    <PaneChrome pane={compositionDetailPane}>
      <CompositionDetail.Host id={id} />
    </PaneChrome>
  );
}

function CompareBody(): ReactElement {
  const { manifests } = useCompositionData();
  // Same store-outlives-pane rule as the detail pane's seed: the ref is the
  // guard, so a `manifests` config write never re-seeds over the user's pick,
  // and there is no cleanup — the next `comp/:id` seed clears the compare slot.
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current || manifests.length === 0) return;
    seeded.current = true;
    const a = manifests.find((m) => m.name === DEFAULT_A) ?? manifests[0];
    const b = manifests.find((m) => m.name === DEFAULT_B) ?? manifests[1];
    if (a) setActiveComposition(structuredClone(a));
    if (b) setCompareComposition(structuredClone(b));
  }, [manifests]);

  return (
    <PaneChrome pane={comparePane}>
      <CompareView />
    </PaneChrome>
  );
}
