import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { AttachmentFileSchema, AttachmentSchema } from "./schema";

/**
 * One owner's attachments: `ownerType` is the owner table's name (`"tasks"`),
 * resolved against the `Attachments.defineLink` registry, `id` the owner row's
 * id. An owner type no plugin linked is refused `unknown-owner-type`.
 */
export const attachmentsByOwner = liveValue("attachments.by-owner", {
  schema: z.array(AttachmentSchema),
  params: ["ownerType", "id"],
  refusals: ["unknown-owner-type"],
});

/**
 * One attachment and its location on disk, for previewing it as a host file.
 * Refused `missing` once the attachment is gone (deleted, or swept as an orphan).
 */
export const attachmentFile = liveValue("attachments.file", {
  schema: AttachmentFileSchema,
  params: ["id"],
  refusals: ["missing"],
});
