import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { renameConversation } from "../core";
import { handleRename } from "./internal/handle-rename";

export default {
  description:
    "Renaming a conversation, every host's half: PUT /api/conversations/:id/title writes the conversation's own title and marks it as the user's (titleByUser), so no generated title replaces it and the conversation lists name the row by it whatever their title setting.",
  httpRoutes: {
    [renameConversation.route]: handleRename,
  },
} satisfies ServerPluginDefinition;
