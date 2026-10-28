import type { DefaultlessFieldDef, FieldDef } from "./field-spec";

/** A field's `defaultValue` does not parse against its own schema. */
export class FieldDefaultError extends Error {
  override name = "FieldDefaultError";
}

// Every def whose default has been checked (or that has none). A def is frozen,
// so one check holds for its lifetime; `fieldSchemaWithDefault` re-asserts
// through this set without re-parsing on every composition.
const checked = new WeakSet<FieldDef>();

/**
 * Throws a {@link FieldDefaultError} unless `field.defaultValue` is a value its
 * schema accepts — the default is a VALUE the field can hold, never a stand-in
 * (`""` for a uuid) that only looks like one. Output-checked: the default is
 * parsed as stored data would be, which is what zod 4's non-re-parsing
 * `.default()` hands out verbatim.
 */
export function assertFieldDefault(field: FieldDef): void {
  if (checked.has(field)) return;
  if (field.defaultless !== true) {
    const result = field.schema.safeParse(field.defaultValue);
    if (!result.success) {
      const issues = result.error.issues
        .map(
          (i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`,
        )
        .join("; ");
      throw new FieldDefaultError(
        `field type "${field.type.id}": default ${JSON.stringify(field.defaultValue)} does not parse against its own schema — ${issues}`,
      );
    }
  }
  checked.add(field);
}

/**
 * The one way a field def is built: freezes it after asserting its default
 * parses ({@link assertFieldDefault}), so an invalid default fails where the
 * field is declared — at boot — not at the first read that backfills it.
 */
export function defineField<D extends FieldDef>(def: D): D {
  const frozen = Object.freeze(def);
  assertFieldDefault(frozen);
  return frozen;
}

/**
 * Builds a {@link DefaultlessFieldDef}: a field with no default. Its
 * `defaultValue` is a getter that throws, so a consumer that seeds a value
 * from it (a form, a config) fails loudly instead of reading a stand-in.
 */
export function defineDefaultlessField<T>(
  def: Omit<FieldDef<T>, "defaultValue" | "defaultDeclared" | "defaultless">,
): DefaultlessFieldDef<T> {
  const frozen = Object.freeze({
    ...def,
    defaultless: true as const,
    get defaultValue(): never {
      throw new FieldDefaultError(
        `field type "${def.type.id}" has no default: write the key, or wrap the field in nullable()`,
      );
    },
  });
  checked.add(frozen);
  return frozen;
}
