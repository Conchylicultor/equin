import { z } from "zod";
import {
  fieldsToZodObject,
  pickMeta,
  type FieldDef,
  type FieldMeta,
  type FieldsRecord,
} from "@plugins/fields/core";
import {
  variantFieldType,
  type VariantValue,
} from "@plugins/fields/plugins/variant/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";

/** A single registered variant: its display label + the FieldsRecord shaping
 *  its payload (everything but the `type` discriminant). */
export interface VariantEntry {
  readonly label: string;
  readonly fields: FieldsRecord;
}

export interface VariantFieldDef extends FieldDef<VariantValue> {
  readonly type: typeof variantFieldType;
  /**
   * Web-only: per-type payload-schema + label registry for rendering/validation.
   * A function type only — importing this core module pulls no web/React code.
   * Omitted on the server build (opaque storage there). Optional so the shared
   * descriptor stays server-safe.
   */
  readonly useVariants?: Hook<() => Map<string, VariantEntry>>;
}

// Opaque/passthrough at the config boundary: only the `type` discriminant is
// validated; per-type payload survives passthrough, validated downstream by
// the chosen variant's own fields (see validateVariant), not here. One schema
// for every variant field — it depends on no option, and a zod schema is
// immutable — so declaring one (every DataView's views config does, at module
// evaluation) builds no zod.
const VARIANT_SCHEMA = z.object({ type: z.string() }).passthrough();

export function variantField(
  opts?: FieldMeta & {
    default?: VariantValue;
    useVariants?: VariantFieldDef["useVariants"];
  },
): VariantFieldDef {
  return Object.freeze({
    type: variantFieldType,
    schema: VARIANT_SCHEMA,
    defaultValue: opts?.default ?? { type: "" },
    meta: pickMeta(opts),
    useVariants: opts?.useVariants,
  });
}

export function isVariantFieldDef(field: FieldDef): field is VariantFieldDef {
  // Token check — more robust than a key probe, since `useVariants` is optional.
  return field.type.id === variantFieldType.id;
}

/**
 * Pure downstream validator: resolve the per-type `fields` for `value.type` and
 * validate the payload (value minus the `type` key) against it.
 *
 * Fail-soft on an unknown `type` (returns `{ ok: false }`, mirroring
 * `reorder-tree-renderer`'s `if (!nodeType) continue` skip). Dependency-light
 * (zod + fields/core only) so it stays co-located-`bun:test`-able.
 */
export function validateVariant(
  value: VariantValue,
  variants: Map<string, VariantEntry>,
): { ok: true; value: VariantValue } | { ok: false } {
  const entry = variants.get(value.type);
  if (!entry) return { ok: false };

  const { type: _type, ...payload } = value;
  // `.passthrough()`: preserve payload keys not described by the current per-type
  // `fields` registry, so re-saving a variant never silently drops data
  // (matches the opaque/passthrough contract at the config boundary above, and
  // mirrors how `defineConfig` opts back into passthrough over the now-strict
  // `fieldsToZodObject` primitive).
  const parsed = fieldsToZodObject(entry.fields)
    .passthrough()
    .safeParse(payload);
  if (!parsed.success) return { ok: false };

  return { ok: true, value: { type: value.type, ...parsed.data } };
}
