import type { Filter } from "@plugins/network/plugins/live/plugins/filter/core";
import type {
  FieldDef,
  FilterLowerContext,
  FilterOperator,
  FilterOperatorSet,
  FilterRule,
} from "../../core";

/**
 * Resolve a rule's field + operator (and the operator's set), or `null` when
 * either is unresolvable (a dangling rule whose field/operator no longer exists
 * in the schema). The single place that maps `(fieldId, operatorId)` → live
 * `{ field, set, op }`, so the lowering and the rule counter resolve identically.
 */
export function resolveRuleOperator<TRow>(
  rule: FilterRule,
  fields: FieldDef<TRow>[],
  resolveOperatorSet: (typeId: string) => FilterOperatorSet | undefined,
): {
  field: FieldDef<TRow>;
  set: FilterOperatorSet;
  op: FilterOperator;
} | null {
  const field = fields.find((f) => f.id === rule.fieldId);
  if (!field) return null;
  const set = resolveOperatorSet(field.type ?? "text");
  const op = set?.operators.find((o) => o.id === rule.operatorId);
  if (!set || !op) return null;
  return { field, set, op };
}

/**
 * The clock a completeness probe hands `lower`. `FilterOperator.lower`'s
 * contract is that WHETHER it answers `undefined` never depends on `now`, so
 * any instant gives the counter the evaluator's answer; a constant keeps the
 * counter pure (no clock read in render).
 */
const COMPLETENESS_PROBE: Omit<FilterLowerContext, "column" | "field"> = {
  now: 0,
};

/**
 * THE single definition of "this rule constrains rows": it resolves, and its
 * operator lowers it to a `Filter` (`lower` answers `undefined` for an
 * incomplete rule). The evaluator (`lowerFilterGroup`, which drops an
 * incomplete rule — it keeps every row) and the rule counter (the chip badge)
 * both read `lower`'s one answer, so counting and filtering can never disagree.
 */
export function isRuleActive<TRow>(
  rule: FilterRule,
  fields: FieldDef<TRow>[],
  resolveOperatorSet: (typeId: string) => FilterOperatorSet | undefined,
): boolean {
  const resolved = resolveRuleOperator(rule, fields, resolveOperatorSet);
  if (resolved === null) return false;
  const lowered: Filter | undefined = resolved.op.lower(rule.value, {
    column: resolved.field.id,
    field: resolved.field as FieldDef<unknown>,
    ...COMPLETENESS_PROBE,
  });
  return lowered !== undefined;
}
