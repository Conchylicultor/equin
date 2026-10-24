import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { AttachmentFileSchema, AttachmentSchema } from "./schema";

/**
 * One owner's attachments: `ownerType` is the owner table's name (`"tasks"`),
 * resolved against the `Attachments.defineLink` registry, `id` the owner row's
 * id. An owner type no plugin linked is refused `unknown-owner-type`.
 */
export const attachmentsByOwner = liveValue("attachments.by-owner", {
  schema: wholeList(AttachmentSchema, {
    reason:
      "one owner's attachments — the files a person attached to one task or block, a handful, never a growing log",
  }),
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
