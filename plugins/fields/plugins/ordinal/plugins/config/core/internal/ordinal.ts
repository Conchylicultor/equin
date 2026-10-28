import { z } from "zod";
import {
  declaredDefault,
  type FieldDef,
  type ExactOptions,
  type FieldMarks,
  type FieldMeta,
  pickMeta,
} from "@plugins/fields/core";
import { ordinalFieldType } from "@plugins/fields/plugins/ordinal/core";

export interface OrdinalFieldDef extends FieldDef<number> {
  readonly type: typeof ordinalFieldType;
  readonly min?: number;
  readonly max?: number;
}

type OrdinalFieldOptions = FieldMeta & {
  default?: number;
  min?: number;
  max?: number;
};

// The options mark the field (`FieldMarks`: a declared `default`, a `label`,
// `filterable: false`).
export function ordinalField<
  const O extends OrdinalFieldOptions = Record<never, never>,
>(
  opts?: ExactOptions<O, OrdinalFieldOptions>,
): OrdinalFieldDef & FieldMarks<O> {
  let schema = z.number().int();
  if (opts?.min !== undefined) schema = schema.min(opts.min);
  if (opts?.max !== undefined) schema = schema.max(opts.max);

  return Object.freeze({
    type: ordinalFieldType,
    schema,
    defaultValue: opts?.default ?? 0,
    ...declaredDefault(opts),
    meta: pickMeta(opts),
    min: opts?.min,
    max: opts?.max,
  }) as OrdinalFieldDef & FieldMarks<O>;
}
