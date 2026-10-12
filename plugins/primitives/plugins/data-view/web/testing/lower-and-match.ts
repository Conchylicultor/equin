import {
  matchesFilter,
  type FilterDomainId,
} from "@plugins/network/plugins/live/plugins/filter/core";
import type { FieldDef, FilterFieldValue, FilterOperator } from "../../core";
import { coerceToDomain } from "../internal/evaluate-filter";

/**
 * Does a rule `op(operand)` keep a row whose field projects to `value`? — the
 * in-memory evaluator's exact path for one rule: `op.lower` over a column of
 * `domain` (an incomplete rule, `undefined`, keeps every row), the DataView
 * domain adapter, then the filter language's `matchesFilter`. For operator-set
 * tests that pin a lowering by its effect on values.
 */
export function lowersToMatch(
  op: Pick<FilterOperator, "lower">,
  domain: FilterDomainId,
  operand: unknown,
  value: FilterFieldValue,
  now = 0,
  field: FieldDef<unknown> = { id: "v", label: "v" },
): boolean {
  const filter = op.lower(operand, { column: "v", field, now });
  if (filter === undefined) return true;
  return matchesFilter({ v: coerceToDomain(value, domain) }, filter, {
    v: { domain },
  });
}

/** A minimal option-less field for a test that calls `op.lower` directly. */
export function testField(id: string): FieldDef<unknown> {
  return { id, label: id };
}
