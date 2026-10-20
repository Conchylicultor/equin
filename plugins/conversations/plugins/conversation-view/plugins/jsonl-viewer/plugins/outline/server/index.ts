import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { turnsServed } from "./internal/served";

export default {
  portable: true,
  description:
    "Serves a conversation's user turns over its whole transcript (jsonl-viewer.outline.turns), for the outline of a pane that holds only the latest events.",
  contributions: [...turnsServed.declare],
} satisfies ServerPluginDefinition;
