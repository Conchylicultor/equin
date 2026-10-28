import { z } from "zod";
import {
  declaredDefault,
  type FieldDef,
  type ExactOptions,
  type FieldMarks,
  type FieldMeta,
  pickMeta,
} from "@plugins/fields/core";
import { byteSizeFieldType } from "@plugins/fields/plugins/byte-size/core";

export interface ByteSizeFieldDef extends FieldDef<number> {
  readonly type: typeof byteSizeFieldType;
  readonly min?: number;
  readonly max?: number;
}

type ByteSizeFieldOptions = FieldMeta & {
  default?: number;
  min?: number;
  max?: number;
};

// The options mark the field (`FieldMarks`: a declared `default`, a `label`,
// `filterable: false`).
export function byteSizeField<
  const O extends ByteSizeFieldOptions = Record<never, never>,
>(
  opts?: ExactOptions<O, ByteSizeFieldOptions>,
): ByteSizeFieldDef & FieldMarks<O> {
  let schema = z.number();
  if (opts?.min !== undefined) schema = schema.min(opts.min);
  if (opts?.max !== undefined) schema = schema.max(opts.max);

  return Object.freeze({
    type: byteSizeFieldType,
    schema,
    defaultValue: opts?.default ?? 0,
    ...declaredDefault(opts),
    meta: pickMeta(opts),
    min: opts?.min,
    max: opts?.max,
  }) as ByteSizeFieldDef & FieldMarks<O>;
}
