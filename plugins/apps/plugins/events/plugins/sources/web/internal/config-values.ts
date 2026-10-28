import {
  fieldDefaults,
  fieldsToZodObject,
  type FieldsRecord,
} from "@plugins/fields/core";

/**
 * A source's `config` blob, resolved against its type's own `configFields`.
 *
 * A result rather than a bare object: a stored blob that no longer satisfies its
 * type's schema (the type plugin changed a field, or the row was written by an
 * older version) is a real condition the Settings form must SAY, not paper over
 * by rendering whatever survives. Returning a partial object here would produce
 * a form that silently drops the offending key on the next autosave.
 */
export type ConfigValues =
  | { status: "ok"; values: Record<string, unknown> }
  | { status: "invalid"; message: string };

/**
 * Read a stored `config` jsonb into form values.
 *
 * Runs the SAME `fieldsToZodObject` the server validates writes against, which
 * buys three things at once and is why this is not a plain object spread:
 * missing keys backfill from each field's own `defaultValue` (so a field added
 * to a source type renders immediately on existing rows), JSON-round-tripped
 * values coerce back to their field type (`z.coerce.date()` turns a stored ISO
 * string back into a `Date` the date renderer can use), and a blob that no
 * longer fits its schema is reported instead of half-rendered.
 */
export function readConfigValues(
  fields: FieldsRecord,
  stored: Record<string, unknown>,
): ConfigValues {
  const parsed = fieldsToZodObject(fields).safeParse(stored);
  if (!parsed.success) {
    return { status: "invalid", message: parsed.error.message };
  }
  return { status: "ok", values: parsed.data as Record<string, unknown> };
}

/** Every field at its declared default — the seed for a new source's form. */
export function initialConfigValues(
  fields: FieldsRecord,
): Record<string, unknown> {
  return fieldDefaults(fields, "an event source's config");
}
