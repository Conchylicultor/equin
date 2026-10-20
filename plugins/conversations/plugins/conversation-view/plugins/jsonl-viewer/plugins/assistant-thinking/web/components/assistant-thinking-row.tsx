import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

type AssistantThinkingEvent = Extract<JsonlEvent, { kind: "assistant-thinking" }>;

export function AssistantThinkingRow({ event }: { event: JsonlEvent }) {
  const e = event as AssistantThinkingEvent;

  return (
    <CollapsibleCard label="Thinking">
      <Text
        as="div"
        variant="caption"
        className="whitespace-pre-wrap break-words font-mono text-muted-foreground"
      >
        {e.thinking}
      </Text>
    </CollapsibleCard>
  );
}
