import { z } from "zod";
import {
  declaredDefault,
  type FieldDef,
  type ExactOptions,
  type FieldMarks,
  type FieldMeta,
  pickMeta,
} from "@plugins/fields/core";
import { multilineTextFieldType } from "@plugins/fields/plugins/multiline-text/core";

export interface MultilineTextFieldDef extends FieldDef<string> {
  readonly type: typeof multilineTextFieldType;
  readonly rows?: number;
}

// The options mark the field (`FieldMarks`: a declared `default`, a `label`,
// `filterable: false`).
export function multilineTextField<
  const O extends FieldMeta & { default?: string; rows?: number } = Record<
    never,
    never
  >,
>(
  opts?: ExactOptions<O, FieldMeta & { default?: string; rows?: number }>,
): MultilineTextFieldDef & FieldMarks<O> {
  return Object.freeze({
    type: multilineTextFieldType,
    schema: z.string(),
    defaultValue: opts?.default ?? "",
    ...declaredDefault(opts),
    meta: pickMeta(opts),
    rows: opts?.rows,
  }) as MultilineTextFieldDef & FieldMarks<O>;
}
