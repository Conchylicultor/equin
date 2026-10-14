import { z } from "zod";
import {
  type ExactOptions,
  type FieldDef,
  type FieldMarks,
  type FieldMeta,
  type FieldType,
  pickMeta,
} from "@plugins/fields/core";
import { textFieldType } from "@plugins/fields/plugins/text/core";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import type { AnyIdKind, Id, IdKind, IdShape } from "./id-kind";

// Every stored-id decoder minted, and the kind it decodes. A column built with
// one (`idColumn`, or a `defineEntity` record's `idKindField`) is a declared id
// column — `ids:pk-declared` reads a table's id column back through
// sql-column's `columnSchema` and asks here which kind it is.
const decoderKinds = new WeakMap<object, AnyIdKind>();

/**
 * The decoder of a STORED id of `kind`: brands, never validates (see
 * {@link idKindField}). Shared by the field and by the server's `idColumn` /
 * `idRef`, so every stored id of a kind decodes one way.
 */
export function storedIdSchema<P extends string>(
  kind: IdKind<P, IdShape>,
): ZodParser<Id<P>> {
  const schema: ZodParser<Id<P>> = z
    .string()
    .transform((value) => value as Id<P>);
  decoderKinds.set(schema, kind as AnyIdKind);
  return schema;
}

/** The kind a {@link storedIdSchema} decoder was minted for, else `undefined`. */
export function idKindOfDecoder(schema: object): AnyIdKind | undefined {
  return decoderKinds.get(schema);
}

/**
 * An id column for a `defineEntity` field record: stored as `text`, typed
 * `Id<P>` on both the drizzle row and the zod wire schema.
 *
 * In `core/` (not `server/`) because field records are: an entity's record is
 * web-safe, so `core/internal/schema.ts` can derive the wire schemas from the
 * same object the server builds the table from.
 *
 * The column's decoder BRANDS what is stored, it does not VALIDATE it. The
 * database is the authority on the ids it already holds — live tables carry
 * rows minted before their kind existed (`task-meta-crashes`,
 * `legacy-claude-…`) — and a read must never throw on one. Validation is the
 * job of the boundaries a new id enters through: `kind.mint()` for a fresh id
 * and `kind.schema` / `kind.parse` for one arriving from outside.
 *
 * `defaultValue` is `""`, exactly as `textField`'s: an id column is always
 * written by its mint, never from a field default. Its options mark the field
 * (`FieldMarks` — a `label` lets a list show it).
 */
export function idKindField<
  P extends string,
  const O extends FieldMeta = Record<never, never>,
>(
  kind: IdKind<P, IdShape>,
  opts?: ExactOptions<O, FieldMeta>,
): FieldDef<Id<P>> & FieldMarks<O> {
  return Object.freeze({
    type: textFieldType as FieldType<Id<P>>,
    schema: storedIdSchema(kind),
    defaultValue: "" as Id<P>,
    meta: pickMeta(opts),
  }) as FieldDef<Id<P>> & FieldMarks<O>;
}

// Every external-id decoder minted, and why the id is not one of ours.
const decoderExternals = new WeakMap<object, string>();

/** The `reason` an {@link externalIdField} decoder was minted with, else `undefined`. */
export function externalReasonOfDecoder(schema: object): string | undefined {
  return decoderExternals.get(schema);
}

/**
 * The `defineEntity` twin of the server's `externalIdColumn`: a field record's
 * `id` whose values are NOT minted here (a Gmail message id, a YouTube video
 * id). A plain `text` string on both the row and the wire; `reason` says whose
 * id it is, and is what `ids:pk-declared` reads back off the built column.
 */
export function externalIdField(opts: {
  reason: string;
  meta?: FieldMeta;
}): FieldDef<string> {
  // An identity transform, not a bare `z.string()`: the text storage arm gives
  // a plain `ZodString` a bare `text` column with NO decoder
  // (`fields/text/storage`), and the decoder is the only thing
  // `ids:pk-declared` can read this declaration back off — a bare string here
  // left every `defineEntity` external id reported as undeclared.
  const schema: ZodParser<string> = z.string().transform((value) => value);
  decoderExternals.set(schema, opts.reason);
  return Object.freeze({
    type: textFieldType,
    schema,
    defaultValue: "",
    meta: pickMeta(opts.meta),
  });
}
