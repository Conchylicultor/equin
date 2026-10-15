import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import {
  type FieldDef,
  type Labelled,
  type FieldMeta,
  pickMeta,
} from "@plugins/fields/core";
import type { FieldType } from "@plugins/fields/core";
import { jsonFieldType } from "@plugins/fields/plugins/json/core";

export interface JsonFieldDef<T> extends FieldDef<T> {
  readonly type: FieldType<T>;
}

/**
 * Typed dynamic-keyed JSON config field. Holds an arbitrary value validated by
 * the supplied Zod schema — the gap `objectField` (fixed-key) and `listField`
 * cannot fill (e.g. a recursive tree, or a `Record<string, …>` map). The value
 * is app-written, not hand-edited; its settings renderer is read-only.
 */
// A labelled JSON field is marked `Labelled` (`FieldMarks`), so it may be
// listed; it is never filterable (a JSON value has no filter domain). Two
// overloads rather than an inferred options type: most callers name `T`
// explicitly, which would leave an options type parameter at its default.
export function jsonField<T>(
  opts: FieldMeta & { label: string; schema: ZodParser<T>; default: T },
): JsonFieldDef<T> & Labelled;
export function jsonField<T>(
  opts: FieldMeta & { schema: ZodParser<T>; default: T },
): JsonFieldDef<T>;
export function jsonField<T>(
  opts: FieldMeta & { schema: ZodParser<T>; default: T },
): JsonFieldDef<T> {
  return Object.freeze({
    // The cast is TRUE, not a hope. The `json` token declares `unknown`, and
    // this narrows it to `T` — which the token's storage contribution then makes
    // real: it is handed `opts.schema` and builds a `parsedJson` column that
    // decodes through it, on every read and every write. Before that
    // contribution took the `decode` arm, this line was the whole basis of `T`
    // on a jsonb column and nothing ran behind it
    // (`research/2026-08-26-global-decoded-jsonb-entity-columns.md`).
    type: jsonFieldType as FieldType<T>,
    schema: opts.schema,
    defaultValue: opts.default,
    meta: pickMeta(opts),
  });
}
