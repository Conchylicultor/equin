import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { attachmentRenderer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { CommandPermissionsView } from "./components/command-permissions-view";

export default {
  collapsed: true,
  description:
    "Renders command-permissions attachment events showing permission grants for the session.",
  contributions: [
    ...attachmentRenderer({
      match: "command_permissions",
      component: CommandPermissionsView,
      role: "context",
    }),
  ],
} satisfies PluginDefinition;
