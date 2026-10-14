import { z } from "zod";
import {
  type DeclaredDefault,
  declaredDefault,
  type FieldDef,
  type ExactOptions,
  type FieldMarks,
  type FieldMeta,
  type FieldOptionMeta,
  type FieldType,
  pickMeta,
} from "@plugins/fields/core";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import { textFieldType } from "@plugins/fields/plugins/text/core";

// A text column whose values are exactly what `schema` produces — the
// field-record analogue of `parsedText(name, schema)`, and the general form of
// which `enumTextField` is the closed-set sugar.
//
// It reuses the `text` storage token, whose contribution is a DECODING arm: it
// is handed this very schema and builds the column from it, so the union in the
// value type is derived from what runs rather than asserted. `type.id` stays
// `"text"`, so every DataView cell / filter / config surface behaves exactly as
// for a plain text field.
//
// Taking a SCHEMA rather than a value tuple is what makes both of this repo's
// policies spellable: the strict `z.enum` for a closed engine-internal set, and
// a `tolerantEnum` for a set whose ids get renamed while old rows outlive them
// (`conversations.model` — see `model-provider/core`). A tuple form could only
// ever express the first.
//
// `default` is REQUIRED here: a general schema has no "first value" to fall back
// to, and a `defaultValue` that does not really parse would be a silent
// mis-backfill. `enumTextField` supplies it from the tuple.
//
// `default` is `NoInfer<T>`: `T` comes from `schema` alone. Were the literal
// default an inference site too, `parsedTextField(schema, { default: "high" })`
// would widen `T` to `string` and the field would silently lose its union.
//
// Its default is always DECLARED (`DeclaredDefault`) — it is required; its
// other options mark it too (`FieldMarks`: a `label`, `filterable: false`).
export function parsedTextField<
  T extends string,
  const O extends FieldMeta & { default: NoInfer<T> } = FieldMeta & {
    default: NoInfer<T>;
  },
>(
  schema: ZodParser<T>,
  opts: ExactOptions<O, FieldMeta & { default: NoInfer<T> }>,
): FieldDef<T> & DeclaredDefault & FieldMarks<O> {
  return textOf(schema, opts, opts.default, {
    defaultDeclared: true,
  }) as FieldDef<T> & DeclaredDefault & FieldMarks<O>;
}

/** The one builder: `mark` is the `DeclaredDefault` mark, when the caller chose `defaultValue`. */
function textOf<T extends string, M extends Partial<DeclaredDefault>>(
  schema: ZodParser<T>,
  opts: FieldMeta | undefined,
  defaultValue: T,
  mark: M,
): FieldDef<T> & M {
  return Object.freeze({
    // True by construction now: the text storage arm really does produce `T`,
    // because `T` is inferred from `schema` and `schema` is what decodes the
    // column.
    type: textFieldType as FieldType<T>,
    schema,
    defaultValue,
    ...mark,
    meta: pickMeta(opts),
  });
}

/**
 * `enumTextField`'s options: the field meta, with `options` keyed by exactly
 * the field's values (each value's label, chip tint and tooltip).
 */
type EnumTextOptions<V extends string> = Omit<FieldMeta, "optionMeta"> & {
  default?: V;
  options?: { readonly [K in V]: FieldOptionMeta };
};

// The closed-set sugar over `parsedTextField`. Pass a `readonly` tuple of the
// allowed values (e.g. a `MAIL_LABEL_TYPES` const array). `InferFieldValue` then
// reports the exact union, so a column built from this field and a `z.infer` of
// the same record agree by construction. `default` defaults to the first value
// — a declared `default` marks the field (`DeclaredDefault`: see
// `FieldDef.defaultDeclared`); the implicit first value does not. `options`
// presents each value (`{ main: { label: "Main", variant: "primary" } }`).
// The options mark the field (`FieldMarks`).
export function enumTextField<
  const T extends readonly [string, ...string[]],
  const O extends EnumTextOptions<T[number]> = Record<never, never>,
>(
  values: T,
  opts?: ExactOptions<O, EnumTextOptions<T[number]>>,
): FieldDef<T[number]> & FieldMarks<O> {
  if (opts?.options !== undefined) {
    const extra = Object.keys(opts.options).filter(
      (v) => !(values as readonly string[]).includes(v),
    );
    if (extra.length > 0) {
      throw new Error(
        `enumTextField: \`options\` names ${extra.map((v) => `"${v}"`).join(", ")}, which ${extra.length === 1 ? "is not a value" : "are not values"} of the field.`,
      );
    }
  }
  return textOf(
    z.enum(values),
    opts === undefined ? undefined : { ...opts, optionMeta: opts.options },
    opts?.default ?? values[0],
    declaredDefault(opts),
  ) as FieldDef<T[number]> & FieldMarks<O>;
}
