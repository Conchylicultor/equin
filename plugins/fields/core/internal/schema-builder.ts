import { z } from "zod";
import { assertFieldDefault } from "./define-field";
import type { FieldDef, FieldsRecord } from "./field-spec";

// A missing key resolves to the field's own default, so adding a field to an
// existing config / list item / object is backward-compatible: documents that
// predate the field heal to its default instead of failing validation. A field
// with no default (`defaultless`) stays required. Mirrors
// objectField, which already wraps its sub-fields this way. The single rule
// every FieldsRecord→z.object composition site shares.
//
// Every default composed here is asserted to parse (`assertFieldDefault`, once
// per def), so a factory that skipped `defineField` cannot slip an invalid
// default past this choke point either.
export function fieldSchemaWithDefault(field: FieldDef): z.ZodType {
  assertFieldDefault(field);
  if (field.defaultless === true) return field.schema;
  return field.schema.default(field.defaultValue);
}

// Derives a strict `z.object` from a FieldsRecord — each field wrapped with its
// default-backfill. Returns a plain object schema (NO `.passthrough()`): a
// strict base so the future `defineEntity` (Stage C) gets clean row validation.
// Consumers that need unknown-key tolerance (config_v2's `defineConfig`, across
// schema evolution) apply `.passthrough()` themselves at the call site.
export function fieldsToZodObject<F extends FieldsRecord>(
  fields: F,
): z.ZodObject<{ [K in keyof F]: F[K]["schema"] }> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(fields)) {
    shape[key] = fieldSchemaWithDefault(field);
  }
  return z.object(shape) as unknown as z.ZodObject<{
    [K in keyof F]: F[K]["schema"];
  }>;
}

// Derives a strict PATCH schema over the named keys of a FieldsRecord: each
// key optional, with NO default-backfill — an absent key stays absent, so a
// partial update never writes a field the caller did not name. (zod 4 applies
// an inner `.default()` to an absent key even under `.optional()` /
// `.partial()`, so `fieldsToZodObject(…).partial()` would fill every unnamed
// key with its default.)
export function fieldsToPatchSchema(
  fields: FieldsRecord,
  keys: readonly string[],
): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const key of keys) {
    const field = fields[key];
    if (field === undefined) {
      throw new Error(`fieldsToPatchSchema: no field "${key}" in the record.`);
    }
    shape[key] = field.schema.optional();
  }
  return z.object(shape).strict() as unknown as z.ZodType<
    Record<string, unknown>
  >;
}
