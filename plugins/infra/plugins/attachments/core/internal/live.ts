import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { AttachmentSchema } from "./schema";

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
