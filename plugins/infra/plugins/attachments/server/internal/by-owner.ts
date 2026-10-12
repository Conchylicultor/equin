import { serveValue } from "@plugins/network/plugins/live/server";
import { attachmentsByOwner } from "../../core";
import { getLink } from "./define-link";

// Registry-backed: `ownerType` is resolved against the defineLink registry, so
// a new owner needs no serve code — it just calls `Attachments.defineLink(table)`.
// The loader reads the owner's link table joined with `attachments`, so the
// change feed recomputes a held tuple on a link or attachment write. Strips the
// server-only `diskPath` so the payload matches the wire `AttachmentSchema`.
export const attachmentsByOwnerServed = serveValue(attachmentsByOwner, {
  source: "db",
  unbounded: {
    reason:
      "one owner's attachments — the files a person attached to one task or block, a handful, never a growing log",
  },
  loader: async ({ ownerType, id }) => {
    const link = getLink(ownerType);
    if (!link) {
      throw attachmentsByOwner.refuse(
        "unknown-owner-type",
        `Unknown attachment owner type: ${ownerType}`,
      );
    }
    const rows = await link.list(id);
    return rows.map(({ diskPath, ...wire }) => wire); // strip server-only path
  },
});
