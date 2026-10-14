import { NULL_OPTION_KEY } from "@plugins/fields/core";
import {
  and,
  clause,
  or,
  type Filter,
  type FilterScalar,
} from "@plugins/network/plugins/live/plugins/filter/core";
import type {
  FieldDef,
  FilterLowerContext,
} from "@plugins/primitives/plugins/data-view/core";

type Lower = (operand: unknown, ctx: FilterLowerContext) => Filter | undefined;

function asString(operand: unknown): string {
  return typeof operand === "string" ? operand : "";
}

function asList(operand: unknown): string[] {
  return Array.isArray(operand)
    ? operand.filter((x): x is string => typeof x === "string")
    : [];
}

/**
 * The values picked options spell (an option's `value` is its value's
 * canonical spelling — `fields/core`'s `optionKey`): `"null"` is the no-value,
 * and over a `valueDomain` each key reads back as the boolean / number it
 * spells. A key that spells no value of the domain (a stale option in a saved
 * view) names nothing.
 */
function decode(
  keys: readonly string[],
  field: FieldDef<unknown>,
): { values: FilterScalar[]; none: boolean } {
  const values: FilterScalar[] = [];
  let none = false;
  for (const key of keys) {
    if (key === NULL_OPTION_KEY) {
      none = true;
      continue;
    }
    switch (field.valueDomain) {
      case "boolean":
        if (key === "true" || key === "false") values.push(key === "true");
        break;
      case "number": {
        const n = Number(key);
        if (key.trim() !== "" && Number.isFinite(n)) values.push(n);
        break;
      }
      case undefined:
        values.push(key);
    }
  }
  return { values, none };
}

/** One part, or the group of them (`none` of them: the group's identity). */
function group(kind: "and" | "or", parts: Filter[]): Filter {
  if (parts.length === 1) return parts[0]!;
  return kind === "and" ? and(...parts) : or(...parts);
}

/** The options' values: one of them, or no value when "null" is picked. */
function matching(
  keys: readonly string[],
  { column, field }: FilterLowerContext,
): Filter {
  const { values, none } = decode(keys, field);
  const parts: Filter[] = [];
  // A boolean column takes `eq` only, so a list is one `eq` per value.
  if (field.valueDomain === "boolean" || values.length === 1) {
    for (const v of values) parts.push(clause(column, "eq", v));
  } else if (values.length > 1) {
    parts.push(clause(column, "in", values));
  }
  if (none) parts.push(clause(column, "isEmpty"));
  return group("or", parts);
}

/** The complement of {@link matching}: a row with no value is kept unless "null" is picked. */
function excluding(
  keys: readonly string[],
  { column, field }: FilterLowerContext,
): Filter {
  const { values, none } = decode(keys, field);
  const parts: Filter[] = [];
  if (field.valueDomain === "boolean" || values.length === 1) {
    for (const v of values) parts.push(clause(column, "ne", v));
  } else if (values.length > 1) {
    parts.push(clause(column, "notIn", values));
  }
  if (none) parts.push(clause(column, "isNotEmpty"));
  return group("and", parts);
}

function single(match: typeof matching): Lower {
  return (operand, ctx) => {
    const want = asString(operand);
    return want === "" ? undefined : match([want], ctx);
  };
}

function list(match: typeof matching): Lower {
  return (operand, ctx) => {
    const want = asList(operand);
    return want.length === 0 ? undefined : match(want, ctx);
  };
}

/**
 * The enum operators lowered into the filter language: exact (case-sensitive)
 * option matches, in the field's `valueDomain` when its values are not its
 * option strings. `is-not` / `is-none-of` are complements, so a row with no
 * option matches them — unless the no-value option (`"null"`) is the one
 * excluded.
 */
export const enumLower = {
  is: single(matching),
  "is-not": single(excluding),
  "is-any-of": list(matching),
  "is-none-of": list(excluding),
  "is-empty": (_operand, { column }) => clause(column, "isEmpty"),
  "is-not-empty": (_operand, { column }) => clause(column, "isNotEmpty"),
} satisfies Record<string, Lower>;
