import { z } from "zod";
import { dateString } from "@plugins/infra/plugins/endpoints/core";

// Canonical wire shape of an attachment row. diskPath (server-only) is
// intentionally excluded — the list handler strips it before responding.
export const AttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mime: z.string(),
  size: z.number(),
  createdAt: dateString(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/**
 * One attachment with where its bytes live on this machine — what a host-file
 * viewer needs to show it. The path is withheld from every listing (above) and
 * served only for the one attachment a preview asked for; this is a
 * single-user instance whose browser already reads host files (`infra/host-fs`).
 */
export const AttachmentFileSchema = AttachmentSchema.extend({
  diskPath: z.string(),
});
export type AttachmentFile = z.infer<typeof AttachmentFileSchema>;
