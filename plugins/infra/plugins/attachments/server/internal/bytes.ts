import { serveValue } from "@plugins/network/plugins/live/server";
import { attachmentBytes } from "../../core";
import { AttachmentBlobs } from "./blobs";
import { getAttachment } from "./operations";

// An attachment's bytes, read from the host's blob store by the key its row
// recorded. Immutable by id: an upload always mints a new attachment, and the
// bytes under an id are never rewritten.
export const attachmentBytesServed = serveValue(attachmentBytes, {
  source: "external",
  changes: {
    immutable: {
      reason:
        "an attachment's bytes never change — an upload mints a new id; a deletion is not healed while subscribed",
    },
  },
  loader: async ({ id }) => {
    const att = await getAttachment(id);
    if (!att) {
      throw attachmentBytes.refuse("missing", `No attachment ${id}`);
    }
    const blob = await AttachmentBlobs.get().read(att.diskPath);
    if (blob === null) {
      throw attachmentBytes.refuse(
        "missing",
        `The bytes of attachment ${id} are gone from the store`,
      );
    }
    return await blob.arrayBuffer();
  },
});
