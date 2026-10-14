import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { attachmentRenderer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { AttachedFileView } from "./components/attached-file-view";

export default {
  collapsed: true,
  description:
    "Renders a file the user attached to their message: a pasted image shown inline at its own aspect with a small/large toggle, or a text file as a syntax-highlighted listing behind its path.",
  contributions: [
    ...attachmentRenderer({
      match: "file",
      component: AttachedFileView,
      role: "conversation",
    }),
  ],
} satisfies PluginDefinition;
