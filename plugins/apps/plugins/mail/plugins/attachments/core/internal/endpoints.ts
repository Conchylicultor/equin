import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// Lazy Gmail attachment blob download. The sync engine stores attachment
// *metadata* (filename/mime/size/gmailAttachmentId) at hydration but never
// downloads the bytes. This endpoint fetches the bytes on demand (reading-pane
// chip click or an inline `cid:` image), stores them via `infra/attachments`
// (`createAttachment`), stamps `mail_attachments.stored_attachment_id`, and
// returns the same-origin URL. A second request for the same row is a cache hit
// (no Gmail round-trip).
export const mailAttachmentDownloadEndpoint = defineEndpoint({
  route: "POST /api/mail/attachment",
  body: z.object({ attachmentRowId: z.string() }),
  response: z.object({ storedAttachmentId: z.string(), url: z.string() }),
});

/** Same-origin URL for a stored attachment blob (served by `infra/attachments`). */
export function mailAttachmentUrl(storedAttachmentId: string): string {
  return `/api/attachments/${storedAttachmentId}`;
}
