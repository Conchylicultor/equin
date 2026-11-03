export { AttachmentSchema, AttachmentFileSchema } from "./internal/schema";
export type { Attachment, AttachmentFile } from "./internal/schema";
export {
  attachmentsByOwner,
  attachmentFile,
  attachmentBytes,
  attachmentRows,
  ATTACHMENT_LINKS_MAX,
} from "./internal/live";
export type { AttachmentLinkRow } from "./internal/live";
export {
  attachmentFields,
  attachmentLinkFields,
  attachmentsEntityRef,
} from "./internal/entity";
export { getAttachmentFile } from "./internal/file-endpoint";
