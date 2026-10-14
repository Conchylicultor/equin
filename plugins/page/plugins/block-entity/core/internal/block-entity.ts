import { z } from "zod";
import {
  nullable,
  type FieldDef,
  type FieldsRecord,
  type FieldType,
} from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { rankField } from "@plugins/fields/plugins/rank/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { Rank, RankSchema } from "@plugins/primitives/plugins/rank/core";

// The `page_blocks` entity, by reference: its name and its fields as the wire
// carries them — what a browser-safe declaration names it with (`pagesTree`'s
// `from`, an extension shape's `exposes.parent`: starred, agent-origin, tags).
//
// The table itself stays a raw `pgTable` (page/editor's
// `server/internal/tables.ts`),
// not built from this record by `defineEntity`: its CHECK constraint
// (`page_blocks_trash_flags_agree`) has no spelling in an entity's meta, and
// its `data` column is branded (`BlockData`, minted only by
// `parseBlockData`). So this record states the WIRE half — the block fields
// page/editor's `BlockSchema` carries — and the server binds them to the
// table's columns by name.
//
// A leaf of its own: a server schema file loads the shapes that name this
// entity (`exposes.parent`), and the editor's core barrel pulls Lexical / Yjs,
// which drizzle-kit cannot load synchronously.

/**
 * A rank as the wire reads it: the `Rank` value object (`RankSchema`), layered
 * on `rankField` the way the rank field type says a consumer does (its value
 * type stays the raw key, keeping `$inferSelect` honest). No default: the
 * backfill is `rankField`'s own `""`, read as a `Rank` like any key.
 */
export function rankWireField(): FieldDef<Rank> {
  const field = rankField();
  return Object.freeze({
    type: field.type as unknown as FieldType<Rank>,
    schema: RankSchema,
    defaultValue: Rank.from(field.defaultValue),
    meta: field.meta,
  });
}

/** A block's fields, as `BlockSchema` reads them. */
export const blockFields = {
  id: textField(),
  pageId: nullable(textField()),
  parentId: nullable(textField()),
  type: textField(),
  // The payload, per block type; `pageData()` reads a page's.
  data: jsonField<unknown>({ schema: z.unknown(), default: {} }),
  rank: rankWireField(),
  expanded: boolField(),
  createdAt: dateField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;

/** The `page_blocks` entity — every block, a page row included. */
export const pagesEntityRef = entityRef("page_blocks", blockFields);
