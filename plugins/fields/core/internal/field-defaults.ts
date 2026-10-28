import { FieldDefaultError } from "./define-field";
import type { FieldsRecord } from "./field-spec";

/**
 * `F` with every field that has NO default (a `DefaultlessFieldDef`) typed as
 * an error message — for a composer that seeds a whole value from its fields'
 * defaults (`objectField` with no `default`, a list item's Add, a config).
 * Take it as `fields: F & DefaultedFields<F>`: tsc then rejects a defaultless
 * field there, at the composition site, instead of a throw at module load.
 */
export type DefaultedFields<F extends FieldsRecord> = {
  readonly [K in keyof F]: F[K] extends { readonly defaultless: true }
    ? "a field with no default cannot be seeded here: give it a default, or wrap it in nullable()"
    : F[K];
};

/**
 * Every field of `fields` at its default — the seed of a whole value. A
 * field with no default (widened past {@link DefaultedFields}) throws a
 * {@link FieldDefaultError} naming the composer and the key: there is no
 * value to seed it with, and no key the author could write instead.
 */
export function fieldDefaults(
  fields: FieldsRecord,
  composer: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, field]) => {
      if (field.defaultless === true) {
        throw new FieldDefaultError(
          `${composer}: field "${key}" (type "${field.type.id}") has no default, so ${composer} cannot seed it — give the field a default, or wrap it in nullable()`,
        );
      }
      return [key, field.defaultValue];
    }),
  );
}
