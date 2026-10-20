import { serveTranscriptValue } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server";
import { collectArtifacts, conversationArtifacts } from "../../core";
import { ConversationArtifactExtractor } from "./extractors";

export const artifactsServed = serveTranscriptValue(
  conversationArtifacts,
  (events) =>
    collectArtifacts(ConversationArtifactExtractor.getContributions(), events),
);
