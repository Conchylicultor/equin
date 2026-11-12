import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { ArtifactItem } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/core";
import { ConversationArtifacts } from "../slots";
import { ArtifactSection } from "./artifact-section";

/** The popover's header strip: its title. */
export function ArtifactsHeader() {
  return (
    <Text variant="label" className="font-semibold">
      Artifacts
    </Text>
  );
}

/**
 * The popover's body: one block per registered kind that found
 * something, in the order the reorder config puts them.
 *
 * The heading carries no number. The button's number is what the conversation
 * MADE, and the panel lists more than that (the pictures it looked at, the
 * skills it loaded) — so a second number here, an inch below the first and
 * under the same word, would read as a contradiction rather than as a second
 * fact.
 *
 * This file names no kind. It reads each one's label off the registry and hands
 * it its own items — so "files changed", "tasks filed" or anything else is one
 * new sub-plugin and no edit here.
 */
export function ArtifactsPanel({
  byKind,
}: {
  byKind: ReadonlyMap<string, ArtifactItem[]>;
}) {
  return (
    // The popover owns every inset (`xs`, a row host): the rows land on its
    // rail, and the header title and every section heading on its text rail —
    // one left edge for all of them, by construction rather than by a sum.
    <Stack gap="sm">
        <ConversationArtifacts.Kind.Render>
          {(kind) => {
            const items = byKind.get(kind.id);
            if (items === undefined || items.length === 0) return null;
            return (
              <ArtifactSection label={kind.label}>
                <kind.Section items={items} />
              </ArtifactSection>
            );
          }}
        </ConversationArtifacts.Kind.Render>
    </Stack>
  );
}
