import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { conversationActivityServed } from "./internal/arm";

export default {
  description:
    "The conversation arm of the activity space: binds the `conversations` table into the activity union (system conversations left out), its status / model / kind picked from the entity; every field exposed on a conversation folds into its band.",
  register: [conversationActivityServed],
} satisfies ServerPluginDefinition;
