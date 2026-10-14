import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { attachmentRenderer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { NestedMemoryAttachmentView } from "./components/nested-memory-attachment-view";

export default {
  collapsed: true,
  description:
    "Renders nested-memory attachment events showing which CLAUDE.md files were loaded as context.",
  contributions: [
    ...attachmentRenderer({
      match: "nested_memory",
      component: NestedMemoryAttachmentView,
      role: "context",
    }),
  ],
} satisfies PluginDefinition;
