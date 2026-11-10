import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { AttachmentSlots } from "@plugins/primitives/plugins/text-editor/plugins/paste-images/web";
import { attachmentPreviewPane, useAttachmentPreviewTarget } from "./panes";

export { attachmentPreviewPane } from "./panes";

export default {
  description:
    "An attachment previewed as a side pane through the Files preview (every file-viewer tab, Open with default app, size and age): the attachment/:id pane, homed in Files and opened beside any surface, and the file chip's opener, so clicking an attached file in a prompt opens it there.",
  // No `slots`: the pane borrows the browser's FilePreviewHeader, declared
  // there — declaring it here too would name one slot twice.
  contributions: [
    Pane.Register({ pane: attachmentPreviewPane }),
    AttachmentSlots.Opener({ useTarget: useAttachmentPreviewTarget }),
  ],
} satisfies PluginDefinition;
