import { serveValue } from "@plugins/network/plugins/live/server";
import { attachmentsByOwner } from "../../core";
import { getLink, getRegisteredLinks } from "./define-link";
import { _attachments } from "./tables";

// Registry-backed: `ownerType` is resolved against the defineLink registry, so
// a new owner needs no serve code — it just calls `Attachments.defineLink(table)`.
// The loader reads the owner's link table joined with `attachments`; the
// declared reads name `attachments` and every registered link table (a thunk —
// links register as each owner's tables module loads). Strips the
// server-only `diskPath` so the payload matches the wire `AttachmentSchema`.
export const attachmentsByOwnerServed = serveValue(attachmentsByOwner, {
  source: "db",
  reads: () => ({
    tables: [_attachments, ...getRegisteredLinks().map((l) => l.table)],
    reason:
      "a tuple joins one owner's link table with attachments; a write to any link row or attachment may change it, whole-table until it reads through a collection",
  }),
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
