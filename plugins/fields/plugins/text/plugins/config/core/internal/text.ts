import { z } from "zod";
import {
  declaredDefault,
  type FieldDef,
  type ExactOptions,
  type FieldMarks,
  type FieldMeta,
  pickMeta,
} from "@plugins/fields/core";
import { textFieldType } from "@plugins/fields/plugins/text/core";

export interface TextFieldDef extends FieldDef<string> {
  readonly type: typeof textFieldType;
}

// The options mark the field (`FieldMarks`: a declared `default`, a `label`,
// `filterable: false`).
export function textField<
  const O extends FieldMeta & { default?: string } = Record<never, never>,
>(
  opts?: ExactOptions<O, FieldMeta & { default?: string }>,
): TextFieldDef & FieldMarks<O> {
  return Object.freeze({
    type: textFieldType,
    schema: z.string(),
    defaultValue: opts?.default ?? "",
    ...declaredDefault(opts),
    meta: pickMeta(opts),
  }) as TextFieldDef & FieldMarks<O>;
}
