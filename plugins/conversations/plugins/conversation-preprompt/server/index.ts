import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { conversationPrepromptRowsServed } from "./internal/resource";
// Registers the launch snapshots' saved-icon source (module eval).
import "./internal/saved-icons";

export { conversationPreprompt } from "./internal/tables";
export { recordConversationPreprompt } from "./internal/record";

export default {
  portable: true,
  description:
    "Serves the snapshot of the launching task's selected preprompt (id + title + text + icon) on each conversation, surfaced as a chip in the conversation header. The job that takes the snapshot when a conversation is created (it resolves the preprompt from config) lives in the machine half.",
  contributions: [...conversationPrepromptRowsServed.declare],
} satisfies ServerPluginDefinition;
