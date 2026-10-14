import { z } from "zod";
import {
  declaredDefault,
  type FieldDef,
  type ExactOptions,
  type FieldMarks,
  type FieldMeta,
  pickMeta,
} from "@plugins/fields/core";
import { uuidFieldType } from "@plugins/fields/plugins/uuid/core";

export interface UuidFieldDef extends FieldDef<string> {
  readonly type: typeof uuidFieldType;
}

// The options mark the field (`FieldMarks`: a declared `default`, a `label`,
// `filterable: false`).
export function uuidField<
  const O extends FieldMeta & { default?: string } = Record<never, never>,
>(
  opts?: ExactOptions<O, FieldMeta & { default?: string }>,
): UuidFieldDef & FieldMarks<O> {
  return Object.freeze({
    type: uuidFieldType,
    schema: z.string().uuid(),
    defaultValue: opts?.default ?? "",
    ...declaredDefault(opts),
    meta: pickMeta(opts),
  }) as UuidFieldDef & FieldMarks<O>;
}
