import { z } from "zod";
import {
  fieldDefaults,
  fieldSchemaWithDefault,
  type DefaultedFields,
  type FieldDef,
  type FieldMeta,
  type FieldsRecord,
  type FieldType,
  type InferFieldsObject,
} from "@plugins/fields/core";
import { objectFieldType } from "@plugins/fields/plugins/object/core";

export interface ObjectFieldDef<
  F extends FieldsRecord = FieldsRecord,
> extends FieldDef<InferFieldsObject<F>> {
  readonly subFields: F;
}

export function isObjectFieldDef(field: FieldDef): field is ObjectFieldDef {
  return "subFields" in field;
}

function pickMeta(opts?: FieldMeta): FieldMeta {
  return {
    label: opts?.label,
    description: opts?.description,
    placeholder: opts?.placeholder,
  };
}

export function objectField<const F extends FieldsRecord>(
  opts: FieldMeta &
    (
      | { subFields: F; default: InferFieldsObject<F> }
      // With no `default`, the object's is seeded from its sub-fields': each
      // needs one (tsc).
      | { subFields: F & DefaultedFields<F>; default?: undefined }
    ),
): ObjectFieldDef<F> {
  // Composed on first read, memoized: an object field is declared at module
  // evaluation, and composing its schema checks each sub-field's default
  // (`fieldSchemaWithDefault`). The sub-shape is built as an untyped record of
  // schemas, so zod cannot prove the object's output equals
  // `InferFieldsObject<F>` — a cast the input widening does not remove.
  let schema: z.ZodType<InferFieldsObject<F>> | undefined;
  const composeSchema = (): z.ZodType<InferFieldsObject<F>> => {
    const subShape: Record<string, z.ZodType> = {};
    for (const [key, field] of Object.entries(opts.subFields)) {
      subShape[key] = fieldSchemaWithDefault(field);
    }
    return z.object(subShape).passthrough() as unknown as z.ZodType<
      InferFieldsObject<F>
    >;
  };

  const defaultValue =
    opts.default != null
      ? { ...(opts.default as Record<string, unknown>) }
      : fieldDefaults(opts.subFields, "objectField");

  return Object.freeze({
    type: objectFieldType as FieldType<InferFieldsObject<F>>,
    get schema() {
      return (schema ??= composeSchema());
    },
    defaultValue: defaultValue as InferFieldsObject<F>,
    meta: pickMeta(opts),
    subFields: opts.subFields,
  });
}
