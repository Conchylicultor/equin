import { serveTranscriptFold } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/transcript-stats/server";
import { usageFold } from "../../core";

export const usageBeforeServed = serveTranscriptFold(usageFold);
