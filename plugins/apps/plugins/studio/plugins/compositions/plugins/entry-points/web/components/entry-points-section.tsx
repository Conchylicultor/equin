import type { ReactElement } from "react";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  useActiveComposition,
  useCompositionData,
} from "@plugins/plugin-meta/plugins/composition/web";
import { isCommittedSourceComposition } from "@plugins/plugin-meta/plugins/composition/core";
import { EntryEditor } from "./entry-editor";

/** Section host for the entry-point editor. */
export function EntryPointsSection({ id }: { id: string }): ReactElement {
  const draft = useActiveComposition();
  const { data } = useCompositionData();

  if (!draft) {
    return (
      <Text variant="caption" tone="muted">
        No active composition.
      </Text>
    );
  }

  // The picker searches every plugin id: until the graph's read settles there is
  // no candidate list to search, which is a state — not an empty one.
  if (data.status === "loading") return <Loading variant="text" />;
  if (data.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the plugin ids"
        error={data.error}
        refetch={data.refetch}
      />
    );
  }

  // Main's row and the `base-exclusions` row are the two whose entry points
  // decide what the app SHIPS, and codegen reads them from the committed config
  // — so an edit stored here could never reach a registry. The same predicate
  // the `save` guard uses, so the inert control and the throw beneath it cannot
  // disagree about which rows they mean.
  return (
    <EntryEditor
      draft={draft}
      allIds={data.data.allIds}
      editable={!isCommittedSourceComposition(id)}
    />
  );
}
