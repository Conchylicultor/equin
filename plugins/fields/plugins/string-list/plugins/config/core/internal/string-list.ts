import { z } from "zod";
import {
  declaredDefault,
  type FieldDef,
  type ExactOptions,
  type FieldMarks,
  type FieldMeta,
  pickMeta,
} from "@plugins/fields/core";
import { stringListFieldType } from "@plugins/fields/plugins/string-list/core";

export interface StringListFieldDef extends FieldDef<string[]> {
  readonly type: typeof stringListFieldType;
}

// The options mark the field (`FieldMarks`: a declared `default`, a `label`,
// `filterable: false`).
export function stringListField<
  const O extends FieldMeta & { default?: string[] } = Record<never, never>,
>(
  opts?: ExactOptions<O, FieldMeta & { default?: string[] }>,
): StringListFieldDef & FieldMarks<O> {
  return Object.freeze({
    type: stringListFieldType,
    schema: z.array(z.string()),
    defaultValue: opts?.default ?? [],
    ...declaredDefault(opts),
    meta: pickMeta(opts),
  }) as StringListFieldDef & FieldMarks<O>;
}
