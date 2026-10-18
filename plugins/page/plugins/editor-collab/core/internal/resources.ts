import type { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { fieldsToZodObject, type FieldsRecord } from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { bytesField } from "@plugins/fields/plugins/bytes/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";

// One block's persisted content-CRDT state. `state` is a `bytes` field: base64
// on the wire, bytes in its `bytea` column (whose declared wire form, through
// sql-column's `withWire`, is unfolded base64) — the client decodes back to a
// Uint8Array and `Y.applyUpdate`s it (idempotent and commutative, so
// re-applying an echo of its own write is a no-op).
const blockDocFields = {
  blockId: textField(),
  /** `Y.encodeStateAsUpdate(doc)` of the block's content doc. */
  state: bytesField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;

/** The `page_block_docs` entity. */
export const pageBlockDocsEntityRef = entityRef(
  "page_block_docs",
  blockDocFields,
);
export const BlockDocRowSchema = fieldsToZodObject(blockDocFields);
export type BlockDocRow = z.infer<typeof BlockDocRowSchema>;

// The `page_block_docs` rows, read one block at a time: lookup-only (no default
// window — nothing lists every block's doc), so it mints `page-block-doc:rows`
// alone and is read with `useLiveRow(blockDocs, blockId)`. Only mounted block
// editors subscribe, which is the lazy content-loading win; `found: false` is
// "doc not initialized yet" (the first `doc-init` creates it). The point
// routing sends a write to one block's row to THAT block's subscribers only.
export const blockDocs = liveCollection("page-block-doc", {
  from: pageBlockDocsEntityRef,
  carry: { pick: ["blockId", "state", "updatedAt"] },
  id: "blockId",
});
