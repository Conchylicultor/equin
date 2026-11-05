import { useMemo, useState, type ReactElement } from "react";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  useActiveComposition,
  useCompositionData,
  useGraph,
  useViewHost,
} from "@plugins/plugin-meta/plugins/composition/web";
import {
  flattenManifest,
  resolveComposition,
} from "@plugins/plugin-meta/plugins/closure/core";
import { ContributorEditor } from "./contributor-editor";

/**
 * Section host for the contributor editor. The filter query is local state —
 * nothing outside this section reads it.
 */
export function ContributorsSection(): ReactElement {
  const draft = useActiveComposition();
  const { manifests } = useCompositionData();
  const graph = useGraph();
  const host = useViewHost();
  const [query, setQuery] = useState("");

  const resolved = useMemo(() => {
    if (!draft || !graph || !host) return null;
    // Flatten the draft's `extends` (e.g. a profile's self-improvement pack)
    // against the full registry before resolving, mirroring the store — on
    // the host the Studio views it on.
    return resolveComposition(graph, flattenManifest(draft, manifests), host);
  }, [draft, graph, manifests, host]);

  if (!draft || !resolved) {
    return (
      <Text variant="caption" tone="muted">
        No active composition.
      </Text>
    );
  }

  return (
    <ContributorEditor
      draft={draft}
      resolved={resolved}
      query={query}
      onQueryChange={setQuery}
    />
  );
}
