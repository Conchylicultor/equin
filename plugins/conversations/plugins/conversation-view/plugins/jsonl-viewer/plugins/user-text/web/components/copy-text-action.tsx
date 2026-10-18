import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";
import { CopyTextAction } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";

export function CopyUserTextAction({ event }: { event: JsonlEvent }) {
  if (event.kind !== "user-text") return null;
  return <CopyTextAction text={event.text} title="Copy message" />;
}
