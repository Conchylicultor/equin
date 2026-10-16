import { serveValue } from "@plugins/network/plugins/live/server";
import { attachmentFile } from "../../core";
import { getAttachment } from "./operations";
import { _attachments } from "./tables";

// The one read that hands out an attachment's disk path: a preview shows the
// file through the host-file viewer, which reads by path.
export const attachmentFileServed = serveValue(attachmentFile, {
  source: "db",
  reads: {
    tables: [_attachments],
    reason:
      "one attachment row looked up by id; whole-table until it reads through a collection",
  },
  loader: async ({ id }) => {
    const att = await getAttachment(id);
    if (!att) throw attachmentFile.refuse("missing", "Attachment not found");
    return att;
  },
});
