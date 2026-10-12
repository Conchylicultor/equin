import {
  clause,
  type Filter,
} from "@plugins/network/plugins/live/plugins/filter/core";
import {
  optionDescendants,
  type FilterLowerContext,
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

/** A one-tag operand as a one-element list op; an empty one is incomplete. */
function one(op: "hasAll" | "hasNone"): Lower {
  return (operand, { column }) => {
    const tag = asString(operand);
    return tag === "" ? undefined : clause(column, op, [tag]);
  };
}

function many(op: "hasAny" | "hasAll"): Lower {
  return (operand, { column }) => {
    const tags = asList(operand);
    return tags.length === 0 ? undefined : clause(column, op, tags);
  };
}

/** The field's declared options, or none for a not-ready / option-less field. */
function optionsOf(field: FilterLowerContext["field"]) {
  if (field.options) return field.options;
  return field.optionsResult?.status === "ready"
    ? field.optionsResult.options
    : [];
}

/** Like `many`, over each operand tag's closure in the options' hierarchy. */
function nested(op: "hasAny" | "hasNone"): Lower {
  return (operand, { column, field }) => {
    const tags = asList(operand);
    if (tags.length === 0) return undefined;
    const options = optionsOf(field);
    const closure = new Set(tags.flatMap((t) => optionDescendants(options, t)));
    return clause(column, op, [...closure]);
  };
}

/**
 * The tags operators lowered into the filter language's `stringArray` domain.
 * `does-not-contain` is `hasNone`, the complement of `hasAny`, so a row with no
 * tag set matches it. The `-nested` operators widen each operand tag to itself
 * plus its descendants (`FieldOption.parent`); on a flat option list that is the
 * operand itself.
 */
export const tagsLower = {
  contains: one("hasAll"),
  "does-not-contain": one("hasNone"),
  "contains-any-of": many("hasAny"),
  "contains-all-of": many("hasAll"),
  "has-nested": nested("hasAny"),
  "lacks-nested": nested("hasNone"),
  "is-empty": (_operand, { column }) => clause(column, "isEmpty"),
  "is-not-empty": (_operand, { column }) => clause(column, "isNotEmpty"),
} satisfies Record<string, Lower>;
