import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { CopyTextAction } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";

export function CopyToolResultAction({ event }: { event: JsonlEvent }) {
  if (event.kind !== "tool-call" || !event.result) return null;
  return <CopyTextAction text={event.result.content} title="Copy result" />;
}
