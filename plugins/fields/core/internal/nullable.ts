import type { FieldDef, InferFieldValue, MetaMarksOf } from "./field-spec";
import type { FieldType } from "./types";

// Make any field nullable, composing with every factory
// (`nullable(textField())`, `nullable(dateField())`,
// `nullable(jsonField<T[]>({...}))`). The column's storage builder is keyed off
// `type.id`, which is unchanged — only the schema gains `.nullable()` and the
// wire/backfill default becomes `null`.
//
// `defineEntity` reads nullability from the RAW `field.schema`: a `ZodNullable`
// leaves the DB column nullable (no `.notNull()`). Nullability is DISTINCT from
// a DB-column default — `nullable()` adds neither `.default()` nor any
// `meta.columns.<key>.default`; a nullable column simply defaults to NULL on
// the wire (`fieldsToZodObject` wraps the schema with `.default(null)`).
//
// The meta is the field's own, so its meta marks (`Labelled`, `Unfilterable`)
// carry over; its default does not (it becomes `null`, never declared).
//
// The `type` cast is the only boundary cast: a `FieldType<T>` token is reused
// for the `T | null` value (the runtime token carries no `T`, it is phantom),
// so `InferFieldValue` reports `T | null` and the column brands accordingly.
export function nullable<D extends FieldDef>(
  def: D,
): FieldDef<InferFieldValue<D> | null> & MetaMarksOf<D> {
  return Object.freeze({
    type: def.type as unknown as FieldType<InferFieldValue<D> | null>,
    schema: def.schema.nullable(),
    defaultValue: null,
    meta: def.meta,
  }) as FieldDef<InferFieldValue<D> | null> & MetaMarksOf<D>;
}
