import { z } from "zod";
import {
  declaredDefault,
  type FieldDef,
  type ExactOptions,
  type FieldMarks,
  type FieldMeta,
  pickMeta,
} from "@plugins/fields/core";
import { intFieldType } from "@plugins/fields/plugins/int/core";

export interface IntFieldDef extends FieldDef<number> {
  readonly type: typeof intFieldType;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

type IntFieldOptions = FieldMeta & {
  default?: number;
  min?: number;
  max?: number;
  step?: number;
};

// The options mark the field (`FieldMarks`: a declared `default`, a `label`,
// `filterable: false`).
export function intField<
  const O extends IntFieldOptions = Record<never, never>,
>(opts?: ExactOptions<O, IntFieldOptions>): IntFieldDef & FieldMarks<O> {
  let schema = z.number().int();
  if (opts?.min !== undefined) schema = schema.min(opts.min);
  if (opts?.max !== undefined) schema = schema.max(opts.max);

  return Object.freeze({
    type: intFieldType,
    schema,
    defaultValue: opts?.default ?? 0,
    ...declaredDefault(opts),
    meta: pickMeta(opts),
    min: opts?.min,
    max: opts?.max,
    step: opts?.step,
  }) as IntFieldDef & FieldMarks<O>;
}
