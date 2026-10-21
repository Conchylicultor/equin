import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { conversationPrepromptRowsServed } from "./internal/resource";
// Registers the launch snapshots' saved-icon source (module eval).
import "./internal/saved-icons";

export { conversationPreprompt } from "./internal/tables";
export {
  getConversationPreprompt,
  recordConversationPreprompt,
  type ConversationPrepromptSnapshot,
} from "./internal/record";

export default {
  portable: true,
  description:
    "The snapshot of the preprompt each conversation was launched with (id + title + text + icon): written by the conversation launch on its own transaction, read back by every spawn of the conversation as the instructions appended to its system prompt, and served to the header chip.",
  contributions: [...conversationPrepromptRowsServed.declare],
} satisfies ServerPluginDefinition;
