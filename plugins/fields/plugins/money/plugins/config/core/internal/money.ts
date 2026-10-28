import { z } from "zod";
import {
  declaredDefault,
  type FieldDef,
  type ExactOptions,
  type FieldMarks,
  type FieldMeta,
  pickMeta,
} from "@plugins/fields/core";
import { moneyFieldType } from "@plugins/fields/plugins/money/core";

export interface MoneyFieldDef extends FieldDef<number> {
  readonly type: typeof moneyFieldType;
  readonly min?: number;
  readonly max?: number;
}

type MoneyFieldOptions = FieldMeta & {
  default?: number;
  min?: number;
  max?: number;
};

// The options mark the field (`FieldMarks`: a declared `default`, a `label`,
// `filterable: false`).
export function moneyField<
  const O extends MoneyFieldOptions = Record<never, never>,
>(opts?: ExactOptions<O, MoneyFieldOptions>): MoneyFieldDef & FieldMarks<O> {
  let schema = z.number();
  if (opts?.min !== undefined) schema = schema.min(opts.min);
  if (opts?.max !== undefined) schema = schema.max(opts.max);

  return Object.freeze({
    type: moneyFieldType,
    schema,
    defaultValue: opts?.default ?? 0,
    ...declaredDefault(opts),
    meta: pickMeta(opts),
    min: opts?.min,
    max: opts?.max,
  }) as MoneyFieldDef & FieldMarks<O>;
}
