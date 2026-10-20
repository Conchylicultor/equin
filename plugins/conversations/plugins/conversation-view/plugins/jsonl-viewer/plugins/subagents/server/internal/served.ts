import { serveTranscriptValue } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server";
import { conversationParentFacts, parentFactsOf } from "../../core";

export const parentFactsServed = serveTranscriptValue(
  conversationParentFacts,
  parentFactsOf,
);
