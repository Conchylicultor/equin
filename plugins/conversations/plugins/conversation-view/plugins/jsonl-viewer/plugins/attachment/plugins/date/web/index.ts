import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { attachmentRenderer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { DateAttachmentView } from "./components/date-attachment-view";

export default {
  collapsed: true,
  description:
    "Renders the harness calendar-date attachments — the routine date stamp and the mid-conversation date change — across both the current `date` spelling and the legacy `date_change` one.",
  contributions: [
    ...attachmentRenderer({
      match: "date",
      component: DateAttachmentView,
      role: "context",
    }),
    // The pre-2.1.260 spelling of the same fact: `{ type: "date_change",
    // newDate }` is the `changed: true` case, and old transcripts keep it
    // forever. Same component, so the two can never drift apart.
    ...attachmentRenderer({
      match: "date_change",
      component: DateAttachmentView,
      role: "context",
    }),
  ],
} satisfies PluginDefinition;
