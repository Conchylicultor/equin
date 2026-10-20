import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { CopyTextAction } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";

export function CopyAssistantTextAction({ event }: { event: JsonlEvent }) {
  if (event.kind !== "assistant-text") return null;
  return <CopyTextAction text={event.text} title="Copy message" />;
}
