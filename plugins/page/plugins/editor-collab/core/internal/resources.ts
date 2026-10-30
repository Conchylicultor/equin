import type { z } from "zod";
import {
  liveCollection,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import {
  fieldsToZodObject,
  nullable,
  type FieldsRecord,
} from "@plugins/fields/core";
import { pagesEntityRef } from "@plugins/page/plugins/block-entity/core";
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

// A page's block docs, read ONE TUPLE PER PAGE — what an open page's block
// editors read, instead of one `blockDocs` row each (an 800-block page was 800
// subscriptions, 800 loads and 800 frames; now it is one). Every live block of
// the page (`pageBlocks`' membership: nearest page ancestor `pageId`, trashed
// rows out) with its doc state, `null` while it has none — so a block absent
// from a loaded scope is "not in this page (yet)", never "no doc": a trashed
// block's doc survives it, and an undo binds the restored row back to it.
//
// Served over the `page_blocks` TABLE with `page_block_docs` LEFT-joined on
// the block id (`../../server/internal/resource.ts`): a `doc-update` is the
// one-row refill of its block in its page's tuple, a block create / trash /
// restore an entrant / exit, and the ~1 s `data.text` typing projection
// refills nothing (the tuple reads no `data`).
export const pageBlockDocs = liveCollection("page-block-docs", {
  from: pagesEntityRef,
  baseExposures: false,
  carry: {
    pick: ["id", "pageId"],
    fields: {
      /** The block's doc state (base64), `null` while it has no doc yet. */
      state: nullable(bytesField()),
    },
  },
  id: "id",
  all: {
    by: ["pageId"],
    orderBy: [["id", "asc"]],
    unbounded: {
      reason:
        "one page's block docs — every block editor of an open page reads its own row, the same set as the page's content forest (`pageBlocks`)",
    },
  },
});

/** A row as `pageBlockDocs` delivers it. */
export type PageBlockDocsRow =
  typeof pageBlockDocs extends LiveRowsCollection<infer R> ? R : never;
