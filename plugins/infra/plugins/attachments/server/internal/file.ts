import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import { attachmentFile, attachmentRows } from "../../core";
import { _attachments } from "./tables";

// Each attachment row, by id — the row `attachments.file` follows.
export const attachmentRowsServed = serveCollection(attachmentRows, {
  from: _attachments,
});

// The one read that hands out an attachment's disk path: a preview shows the
// file through the host-file viewer, which reads by path. It follows the
// attachment's own row, so only that attachment's deletion (or orphan sweep)
// reaches it.
export const attachmentFileServed = serveValue(attachmentFile, {
  source: "db",
  follows: (follow) => ({
    attachment: follow(attachmentRowsServed, ({ id }) => ({ ids: [id] })),
  }),
  loader: (_params, { followed }) => {
    const att = followed.attachment[0];
    if (!att) throw attachmentFile.refuse("missing", "Attachment not found");
    return { ...att, createdAt: att.createdAt.toISOString() };
  },
});
