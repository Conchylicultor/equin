import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { getTranscriptImage } from "../core";
import {
  jsonlEventsServed,
  transcriptToolCallServed,
} from "./internal/jsonl-events-resource";
import { handleTranscriptImage } from "./internal/image-handler";

// A value derived from a conversation's whole transcript (an outline, a total,
// its shells), served from the events in memory — what the page reads instead
// of the transcript, of which it holds only the latest window.
export { serveTranscriptValue } from "./internal/transcript-value";
// The building blocks, for a value served some other way.
export {
  conversationEvents,
  conversationEventsSignature,
  watchConversationEvents,
} from "./internal/conversation-events";

export default {
  portable: true,
  description:
    "Streams a conversation's transcript as structured events via the paged jsonl-events resource (newest first; a change ships the rows it touched), read from the host's TranscriptSource (Claude's JSONL session log on the desktop), and serves its images by key.",
  contributions: [
    ...jsonlEventsServed.declare,
    ...transcriptToolCallServed.declare,
  ],
  httpRoutes: {
    [getTranscriptImage.route]: handleTranscriptImage,
  },
} satisfies ServerPluginDefinition;
