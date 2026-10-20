import { serveTranscriptFold } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/transcript-stats/server";
import { budgetFold } from "../../core";

export const budgetBeforeServed = serveTranscriptFold(budgetFold);
