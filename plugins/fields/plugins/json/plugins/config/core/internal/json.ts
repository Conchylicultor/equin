import type { z } from "zod";
import {
  defineDefaultlessField,
  defineField,
  type DefaultlessFieldDef,
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

/** A JSON field given no `default`: it has none (see `DefaultlessFieldDef`). */
export interface DefaultlessJsonFieldDef<T> extends DefaultlessFieldDef<T> {
  readonly type: FieldType<T>;
}

type JsonOptions<T> = FieldMeta & { schema: z.ZodType<T>; default?: T };

/**
 * Typed dynamic-keyed JSON config field. Holds an arbitrary value validated by
 * the supplied Zod schema — the gap `objectField` (fixed-key) and `listField`
 * cannot fill (e.g. a recursive tree, or a `Record<string, …>` map). The value
 * is app-written, not hand-edited; its settings renderer is read-only.
 *
 * The `default` is optional: a JSON value often has no value that stands for
 * "nothing yet" (a trace snapshot, a non-empty question list), so without one
 * the field is defaultless — its key required, always written or wrapped in
 * `nullable()`. A given default is asserted to parse (`defineField`).
 */
// A labelled JSON field is marked `Labelled` (`FieldMarks`), so it may be
// listed; it is never filterable (a JSON value has no filter domain). Overloads
// rather than an inferred options type: most callers name `T` explicitly,
// which would leave an options type parameter at its default.
export function jsonField<T>(
  opts: FieldMeta & { label: string; schema: z.ZodType<T>; default: T },
): JsonFieldDef<T> & Labelled;
export function jsonField<T>(
  opts: FieldMeta & { label: string; schema: z.ZodType<T> },
): DefaultlessJsonFieldDef<T> & Labelled;
export function jsonField<T>(
  opts: FieldMeta & { schema: z.ZodType<T>; default: T },
): JsonFieldDef<T>;
export function jsonField<T>(
  opts: FieldMeta & { schema: z.ZodType<T> },
): DefaultlessJsonFieldDef<T>;
export function jsonField<T>(
  opts: JsonOptions<T>,
): JsonFieldDef<T> | DefaultlessJsonFieldDef<T> {
  // The cast is TRUE, not a hope. The `json` token declares `unknown`, and
  // this narrows it to `T` — which the token's storage contribution then makes
  // real: it is handed `opts.schema` and builds a `parsedJson` column that
  // decodes through it, on every read and every write. Before that
  // contribution took the `decode` arm, this line was the whole basis of `T`
  // on a jsonb column and nothing ran behind it
  // (`research/2026-08-26-global-decoded-jsonb-entity-columns.md`).
  const type = jsonFieldType as FieldType<T>;
  const meta = pickMeta(opts);
  if (!("default" in opts)) {
    return defineDefaultlessField({ type, schema: opts.schema, meta });
  }
  return defineField({
    type,
    schema: opts.schema,
    defaultValue: opts.default as T,
    meta,
  });
}
