import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { jsonlEventsServed } from "./internal/jsonl-events-resource";

export default {
  portable: true,
  description:
    "Streams a conversation's transcript as structured events via the jsonl-events resource, read from the host's TranscriptSource (Claude's JSONL session log on the desktop).",
  contributions: [...jsonlEventsServed.declare],
} satisfies ServerPluginDefinition;
