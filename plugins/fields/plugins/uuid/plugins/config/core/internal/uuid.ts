import { z } from "zod";
import {
  declaredDefault,
  defineDefaultlessField,
  defineField,
  type DefaultlessFieldDef,
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

/** A uuid field given no `default`: it has none (see `DefaultlessFieldDef`). */
export interface DefaultlessUuidFieldDef extends DefaultlessFieldDef<string> {
  readonly type: typeof uuidFieldType;
}

type UuidOptions = FieldMeta & { default?: string };

// A uuid has no value that stands for "any uuid", so a uuid field gets a
// default only when one is given (asserted to be a uuid); without one it is
// defaultless — its key required, so it is always written (a primary key) or
// wrapped in `nullable()`. The options mark the field (`FieldMarks`: a
// declared `default`, a `label`, `filterable: false`).
export function uuidField<const O extends UuidOptions = Record<never, never>>(
  opts?: ExactOptions<O, UuidOptions>,
): (O extends { readonly default: string }
  ? UuidFieldDef
  : DefaultlessUuidFieldDef) &
  FieldMarks<O>;
export function uuidField(
  opts?: UuidOptions,
): UuidFieldDef | DefaultlessUuidFieldDef {
  const schema = z.string().uuid();
  const meta = pickMeta(opts);
  if (opts?.default === undefined) {
    return defineDefaultlessField({ type: uuidFieldType, schema, meta });
  }
  return defineField({
    type: uuidFieldType,
    schema,
    defaultValue: opts.default,
    ...declaredDefault(opts),
    meta,
  });
}
