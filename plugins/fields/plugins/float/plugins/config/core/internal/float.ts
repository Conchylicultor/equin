import { z } from "zod";
import {
  declaredDefault,
  type FieldDef,
  type ExactOptions,
  type FieldMarks,
  type FieldMeta,
  pickMeta,
} from "@plugins/fields/core";
import { floatFieldType } from "@plugins/fields/plugins/float/core";

export interface FloatFieldDef extends FieldDef<number> {
  readonly type: typeof floatFieldType;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

type FloatFieldOptions = FieldMeta & {
  default?: number;
  min?: number;
  max?: number;
  step?: number;
};

// The options mark the field (`FieldMarks`: a declared `default`, a `label`,
// `filterable: false`).
export function floatField<
  const O extends FloatFieldOptions = Record<never, never>,
>(opts?: ExactOptions<O, FloatFieldOptions>): FloatFieldDef & FieldMarks<O> {
  let schema = z.number();
  if (opts?.min !== undefined) schema = schema.min(opts.min);
  if (opts?.max !== undefined) schema = schema.max(opts.max);

  return Object.freeze({
    type: floatFieldType,
    schema,
    defaultValue: opts?.default ?? 0,
    ...declaredDefault(opts),
    meta: pickMeta(opts),
    min: opts?.min,
    max: opts?.max,
    step: opts?.step,
  }) as FloatFieldDef & FieldMarks<O>;
}
