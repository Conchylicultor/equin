import { z } from "zod";
import {
  type ExactOptions,
  type FieldDef,
  type FieldMarks,
  type FieldMeta,
  pickMeta,
  type StoredAs,
} from "@plugins/fields/core";
import { bytesFieldType } from "@plugins/fields/plugins/bytes/core";

// A field whose value is base64 on the wire and bytes in its column: the
// field's value (and schema) is the wire string; `StoredAs<Uint8Array>` types
// the entity's column by what it stores, and the storage's `withWire` codec
// encodes every served row.
export interface BytesFieldDef extends FieldDef<string>, StoredAs<Uint8Array> {
  readonly type: typeof bytesFieldType;
}

// The options mark the field (`FieldMarks`: a `label`, `filterable: false`).
export function bytesField<const O extends FieldMeta = Record<never, never>>(
  opts?: ExactOptions<O, FieldMeta>,
): BytesFieldDef & FieldMarks<O> {
  return Object.freeze({
    type: bytesFieldType,
    schema: z.string(),
    defaultValue: "",
    meta: pickMeta(opts),
  }) as unknown as BytesFieldDef & FieldMarks<O>;
}
