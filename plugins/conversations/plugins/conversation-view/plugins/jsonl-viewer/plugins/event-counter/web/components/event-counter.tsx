import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { jsonlEvents } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/core";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

export function EventCounter() {
  const { convId } = conversationPane.useParams();
  // The whole transcript's count — the pane holds only its latest events.
  const result = useLive(jsonlEvents.meta, { id: convId });

  if (result.status === "loading") return null;
  if (result.status === "error")
    return (
      <ResourceErrorInline
        variant="icon"
        subject="the transcript events"
        error={result.error}
        refetch={result.refetch}
      />
    );

  const { count } = result.data;
  if (count === 0) return null;
  return (
    <Text as="span" variant="count" tone="muted">
      {count}
    </Text>
  );
}
