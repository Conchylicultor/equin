import type { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { fieldsToZodObject, type FieldsRecord } from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";

// One block's persisted content-CRDT state. `state` is base64 on the wire: the
// `page_block_docs.state` column is a `bytea`, whose declared wire form
// (collab-doc's `bytea`, through sql-column's `withWire`) is unfolded base64 —
// the client decodes back to a Uint8Array and `Y.applyUpdate`s it (idempotent
// and commutative, so re-applying an echo of its own write is a no-op).
const blockDocFields = {
  blockId: textField(),
  /** `Y.encodeStateAsUpdate(doc)` of the block's content doc, base64. */
  state: textField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;
export const BlockDocRowSchema = fieldsToZodObject(blockDocFields);
export type BlockDocRow = z.infer<typeof BlockDocRowSchema>;

// The `page_block_docs` rows, read one block at a time: lookup-only (no default
// window — nothing lists every block's doc), so it mints `page-block-doc:rows`
// alone and is read with `useLiveRow(blockDocs, blockId)`. Only mounted block
// editors subscribe, which is the lazy content-loading win; `found: false` is
// "doc not initialized yet" (the first `doc-init` creates it). The point
// routing sends a write to one block's row to THAT block's subscribers only.
export const blockDocs = liveCollection("page-block-doc", {
  carry: { fields: blockDocFields },
  id: "blockId",
});
