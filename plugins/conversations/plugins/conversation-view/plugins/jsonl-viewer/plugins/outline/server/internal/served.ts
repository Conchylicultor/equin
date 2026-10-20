import { serveTranscriptValue } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server";
import { conversationTurns, userTurnsOf } from "../../core";

export const turnsServed = serveTranscriptValue(conversationTurns, (events) =>
  userTurnsOf(events),
);
