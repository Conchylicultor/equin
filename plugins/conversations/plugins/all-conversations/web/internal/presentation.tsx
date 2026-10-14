import { useMemo, type ReactElement } from "react";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  ConvStatusDot,
  type ConversationItemConv,
} from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import { useOptimisticConversationStatus } from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";
import { useModelCatalog } from "@plugins/conversations/plugins/model-provider/web";
import { mapResource } from "@plugins/primitives/plugins/live-state/web";
import {
  FieldPresentation,
  type LiveFieldOptionsRead,
} from "@plugins/network/plugins/live/web";
import { conversationsEntityRef } from "@plugins/tasks/plugins/tasks-core/core";
import { conversationModelOptions } from "../../core";

// How the conversations entity's fields present in every list of
// conversations (All-conversations, History, the Queue): registered once
// against the entity (`FieldPresentation.Register({ owner:
// conversationsEntityRef })`, `../index.ts`), so no list builds them.

/**
 * The status the conversation header shows — `working` from the instant a
 * turn is sent — so no list disagrees with it.
 */
export function StatusCell({
  conv: row,
}: {
  conv: ConversationItemConv & { updatedAt: Date };
}): ReactElement {
  const status = useOptimisticConversationStatus(row);
  return (
    <Inline gap="xs">
      <ConvStatusDot conv={{ ...row, status }} />
      <Text as="span" variant="caption">
        {status}
      </Text>
    </Inline>
  );
}

/**
 * The model filter's options, read from the LIVE model catalog — a version
 * discovered today is filterable without a release. Loading until the
 * (preloaded) catalog settles: never an empty option list.
 */
export function useConversationModelOptions(): LiveFieldOptionsRead {
  const catalog = useModelCatalog();
  return useMemo(
    () => mapResource(catalog, conversationModelOptions),
    [catalog],
  );
}

/**
 * Every list of conversations (All-conversations, History, the Queue) derives
 * its fields from the entity; this is how two of them present. The status
 * cell reads the row's identity and timestamps beside the status (`reads`).
 */
export const conversationPresentation = FieldPresentation.Register({
  owner: conversationsEntityRef,
  reads: ["id", "title", "kind", "createdAt", "updatedAt"],
  fields: {
    status: { cell: (_status, conv) => <StatusCell conv={conv} /> },
    model: { useOptions: useConversationModelOptions },
  },
});
