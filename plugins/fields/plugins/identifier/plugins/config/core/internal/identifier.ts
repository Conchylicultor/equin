import { z } from "zod";
import {
  declaredDefault,
  type FieldDef,
  type ExactOptions,
  type FieldMarks,
  type FieldMeta,
  pickMeta,
} from "@plugins/fields/core";
import { identifierFieldType } from "@plugins/fields/plugins/identifier/core";

export interface IdentifierFieldDef extends FieldDef<string> {
  readonly type: typeof identifierFieldType;
}

// The options mark the field (`FieldMarks`: a declared `default`, a `label`,
// `filterable: false`).
export function identifierField<
  const O extends FieldMeta & { default?: string } = Record<never, never>,
>(
  opts?: ExactOptions<O, FieldMeta & { default?: string }>,
): IdentifierFieldDef & FieldMarks<O> {
  return Object.freeze({
    type: identifierFieldType,
    schema: z.string(),
    defaultValue: opts?.default ?? "",
    ...declaredDefault(opts),
    meta: pickMeta(opts),
  }) as IdentifierFieldDef & FieldMarks<O>;
}
