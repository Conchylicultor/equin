import { z } from "zod";
import {
  declaredDefault,
  type FieldDef,
  type ExactOptions,
  type FieldMarks,
  type FieldMeta,
  pickMeta,
} from "@plugins/fields/core";
import { durationFieldType } from "@plugins/fields/plugins/duration/core";

export interface DurationFieldDef extends FieldDef<number> {
  readonly type: typeof durationFieldType;
  readonly min?: number;
  readonly max?: number;
}

type DurationFieldOptions = FieldMeta & {
  default?: number;
  min?: number;
  max?: number;
};

// The options mark the field (`FieldMarks`: a declared `default`, a `label`,
// `filterable: false`).
export function durationField<
  const O extends DurationFieldOptions = Record<never, never>,
>(
  opts?: ExactOptions<O, DurationFieldOptions>,
): DurationFieldDef & FieldMarks<O> {
  let schema = z.number();
  if (opts?.min !== undefined) schema = schema.min(opts.min);
  if (opts?.max !== undefined) schema = schema.max(opts.max);

  return Object.freeze({
    type: durationFieldType,
    schema,
    defaultValue: opts?.default ?? 0,
    ...declaredDefault(opts),
    meta: pickMeta(opts),
    min: opts?.min,
    max: opts?.max,
  }) as DurationFieldDef & FieldMarks<O>;
}
