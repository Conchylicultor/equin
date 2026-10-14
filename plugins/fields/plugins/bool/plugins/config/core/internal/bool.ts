import { z } from "zod";
import {
  declaredDefault,
  type FieldDef,
  type ExactOptions,
  type FieldMarks,
  type FieldMeta,
  pickMeta,
} from "@plugins/fields/core";
import { boolFieldType } from "@plugins/fields/plugins/bool/core";

export interface BoolFieldDef extends FieldDef<boolean> {
  readonly type: typeof boolFieldType;
}

// The options mark the field (`FieldMarks`: a declared `default`, a `label`,
// `filterable: false`).
export function boolField<
  const O extends FieldMeta & { default?: boolean } = Record<never, never>,
>(
  opts?: ExactOptions<O, FieldMeta & { default?: boolean }>,
): BoolFieldDef & FieldMarks<O> {
  return Object.freeze({
    type: boolFieldType,
    schema: z.boolean(),
    defaultValue: opts?.default ?? false,
    ...declaredDefault(opts),
    meta: pickMeta(opts),
  }) as BoolFieldDef & FieldMarks<O>;
}
