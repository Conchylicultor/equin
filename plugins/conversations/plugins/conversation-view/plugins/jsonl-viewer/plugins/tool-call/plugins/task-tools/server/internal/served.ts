import { serveTranscriptValue } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server";
import { buildAggregate, conversationTaskAggregate } from "../../core";

export const aggregateServed = serveTranscriptValue(
  conversationTaskAggregate,
  buildAggregate,
);
