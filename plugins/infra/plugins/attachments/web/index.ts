import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { uploadAttachment } from "./internal/upload";
export type { UploadedAttachment } from "./internal/upload";
export { getAttachmentFile } from "../shared/endpoints";
export { holdAttachments } from "./internal/hold";

export default {
  description:
    "Polymorphic file attachments. Exposes uploadAttachment() helper; storage/serve on the server plugin.",
  contributions: [],
} satisfies PluginDefinition;
