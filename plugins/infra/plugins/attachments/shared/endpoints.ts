import { z } from "zod";
import {
  defineEndpoint,
  multipart,
} from "@plugins/infra/plugins/endpoints/core";

export const UploadedAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mime: z.string(),
  size: z.number(),
});

export const uploadAttachment = defineEndpoint({
  route: "POST /api/attachments",
  unpredicted: {
    reason: "server-minted-id",
    why: "the server mints the attachment id and the caller needs it to attach the upload",
  },
  body: multipart(),
  response: UploadedAttachmentSchema,
});

export const deleteAttachmentEndpoint = defineEndpoint({
  route: "DELETE /api/attachments/:id",
  internal: {
    why: "no browser client: only the server's own attachment cleanup deletes blobs",
  },
});

// Replace the attachments one holder (an unsent draft) keeps alive with `ids`,
// for `ttlMs` from now (null: until the holder releases them). An empty `ids`
// releases the holder. Ids that no longer exist are ignored.
export const holdAttachmentsEndpoint = defineEndpoint({
  route: "PUT /api/attachments/holds",
  unpredicted: {
    reason: "unobserved",
    why: "a draft garbage-collection hold with no user-visible state; the server alone decides retention",
  },
  body: z.object({
    holder: z.string().min(1),
    ids: z.array(z.string()),
    ttlMs: z.number().positive().nullable(),
  }),
});
