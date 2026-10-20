import { serveTranscriptValue } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server";
import { conversationShellFacts, shellFactsOf } from "../../core";

export const factsServed = serveTranscriptValue(
  conversationShellFacts,
  shellFactsOf,
);
