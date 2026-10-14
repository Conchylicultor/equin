import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { TextEditorSlots } from "@plugins/primitives/plugins/text-editor/web";
import { ImageUploadPlugin } from "./internal/image-upload-plugin";
import { AttachmentSlots } from "./slots";
import "./internal/register";

export { AttachmentThumbnail } from "./components/attachment-thumbnail";
export { AttachmentFileChip } from "./components/attachment-file-chip";
export { AttachFilesButton } from "./components/attach-files-button";
export { AttachmentSlots } from "./slots";
export type { AttachmentOpener, AttachedFileRef } from "./slots";
export {
  attachmentUrl,
  attachmentMarkdown,
  attachmentRefMarkdown,
  extractAttachmentIds,
  rewriteAttachmentMarkdown,
  isAttachmentUrl,
  isImageRef,
  ATTACHMENT_MARKDOWN_RE,
} from "./internal/markdown";

export default {
  description:
    'File paste/drop/pick support for the text editor. Uploads files via the attachments primitive and renders them inline: an image as a thumbnail chip that opens the full-window image viewer, any other file as a file chip; AttachFilesButton is the composer bar\'s "+" picker.',
  slots: { opener: AttachmentSlots.Opener },
  contributions: [
    TextEditorSlots.Plugin({
      id: "paste-images",
      component: ImageUploadPlugin,
    }),
  ],
} satisfies PluginDefinition;
