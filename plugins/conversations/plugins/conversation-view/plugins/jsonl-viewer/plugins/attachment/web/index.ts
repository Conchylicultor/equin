import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { JsonlViewerAttachment as JsonlViewerAttachmentSlots } from "./slots";
import { AttachmentRow } from "./components/attachment-row";
import { unrenderedAttachmentRole } from "./attachment-renderer";

export { JsonlViewerAttachment } from "./slots";
export { attachmentRenderer } from "./attachment-renderer";
export type { AttachmentRole } from "./attachment-renderer";

export default {
  collapsed: true,
  description:
    "Renders attachment JSONL events with subtype dispatch to per-attachment renderer plugins.",
  contributions: [
    JsonlViewer.EventRenderer({
      match: "attachment",
      component: AttachmentRow,
    }),
    JsonlViewer.ContextRole({
      id: "attachment:unrendered",
      fallback: true,
      role: unrenderedAttachmentRole,
    }),
  ],
  slots: JsonlViewerAttachmentSlots,
} satisfies PluginDefinition;
