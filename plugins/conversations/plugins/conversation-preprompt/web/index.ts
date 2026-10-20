import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { Item } from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import { PrepromptChip } from "./components/preprompt-chip";
import { PrepromptListIcon } from "./components/preprompt-list-icon";

export { useConversationPreprompt } from "./internal/hooks";

export default {
  description:
    "Header chip showing the preprompt the conversation's task was launched with; a popover reveals the full instruction text. Sidebar rows show the preprompt's icon (resolved live from the library, with a default-glyph fallback).",
  contributions: [
    conversationPane.Actions({ id: "preprompt", component: PrepromptChip }),
    Item.Chips({ id: "preprompt", component: PrepromptListIcon }),
  ],
} satisfies PluginDefinition;
