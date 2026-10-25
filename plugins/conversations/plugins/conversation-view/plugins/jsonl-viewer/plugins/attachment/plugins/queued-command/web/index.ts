import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { attachmentRenderer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { QueuedCommandAttachmentView } from "./components/queued-command-attachment-view";

export default {
  collapsed: true,
  description:
    "Renders queued_command attachment events the CLI delivered into a running turn that are not the user's own prompt (a harness control message such as a task notification): a structured key/value card, else the raw command. A queued human prompt is the user's message — the transcript parser makes it one.",
  contributions: [
    ...attachmentRenderer({
      match: "queued_command",
      component: QueuedCommandAttachmentView,
      role: "conversation",
    }),
  ],
} satisfies PluginDefinition;
