import { nullable, type FieldsRecord } from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { rankField } from "@plugins/fields/plugins/rank/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import {
  asBlockData,
  StoredBlockDataSchema,
  type BlockData,
} from "./block-data";

// The `page_blocks` entity, by reference: its name and its fields — what a
// browser-safe declaration names it with (`pagesTree`'s `from`, an extension
// shape's `exposes.parent`: starred, agent-origin, tags) and what the server
// builds the table from (`defineEntity(pagesEntityRef, serverFields, meta)` in
// page/editor's `server/internal/tables.ts`).
//
// The record states the STORED value, as every entity record does: `rank` is
// the raw key (a list carries the wire `Rank` itself, with `rankValueField`),
// and `data` is the branded `BlockData` its column decodes to. The trash
// bookkeeping (`deletedAt`, `trashEntryId`) and the writer-derived `docRank`
// are server-only fields beside this record, so no list can pick them.
//
// A leaf of its own: a server schema file loads the shapes that name this
// entity (`exposes.parent`), and the editor's core barrel pulls Lexical / Yjs,
// which drizzle-kit cannot load synchronously.

/** A block's fields, as the `page_blocks` table stores them. */
export const blockFields = {
  id: textField(),
  // The nearest `type="page"` ancestor; NULL for a page at the tree root.
  pageId: nullable(textField()),
  parentId: nullable(textField()),
  type: textField(),
  // The payload, per block type; `pageData()` reads a page's.
  data: jsonField<BlockData>({
    schema: StoredBlockDataSchema,
    default: asBlockData({}),
  }),
  rank: rankField(),
  expanded: boolField(),
  createdAt: dateField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;

/** The `page_blocks` entity — every block, a page row included. */
export const pagesEntityRef = entityRef("page_blocks", blockFields);
