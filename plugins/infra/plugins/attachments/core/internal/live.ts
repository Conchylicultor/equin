import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { attachmentsEntityRef } from "./entity";
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
 * Each attachment row, by id — what `attachmentFile` follows (lookup-only:
 * `:rows` alone). An attachment is written once (its upload) and then only
 * deleted, so a reader is reached by its own attachment's deletion alone.
 */
export const attachmentRows = liveCollection("attachments.rows", {
  from: attachmentsEntityRef,
  carry: {
    pick: ["id", "filename", "mime", "size", "diskPath", "createdAt"],
  },
  baseExposures: false,
  id: "id",
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

/**
 * One attachment's bytes, by id — for a reader that decodes the file itself
 * (a song's MIDI or MusicXML document). A `bytes` value: read over HTTP as
 * `application/octet-stream`. Immutable: an attachment's bytes never change
 * (an upload mints a new id), so nothing re-reads a tuple once answered.
 *
 * Refused `missing` when there is no such attachment, or its bytes are gone
 * from the host's blob store.
 */
export const attachmentBytes = liveValue("attachments.bytes", {
  bytes: true,
  params: ["id"],
  refusals: ["missing"],
});
