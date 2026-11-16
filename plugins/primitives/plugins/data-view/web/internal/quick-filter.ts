import { canonicalJson } from "@plugins/network/plugins/live/plugins/canonical-params/core";
import type {
  FilterGroup,
  FilterNode,
  FilterRule,
  OperandQuickFilter,
  QuickFilterOption,
  SegmentedQuickFilter,
} from "../../core";
import { countRules, emptyGroup, newNodeId } from "./filter-tree-ops";

/**
 * A quick filter is a VIEW onto the filter tree, never a second filter: which
 * option is selected is read off the tree ({@link activeQuickOption}), and a
 * pick rewrites the tree ({@link applyQuickOption}). Pure — the toolbar reads
 * the active view's filter and writes through the same `setFilter` the Filter
 * panel uses.
 */

/** Does `node` hold a rule on `fieldId`, at any depth? */
function holdsField(node: FilterNode, fieldId: string): boolean {
  return node.kind === "rule"
    ? node.fieldId === fieldId
    : node.children.some((c) => holdsField(c, fieldId));
}

/** The root's own (top-level) rules on `fieldId`. */
function topLevelRules(root: FilterGroup, fieldId: string): FilterRule[] {
  return root.children.filter(
    (c): c is FilterRule => c.kind === "rule" && c.fieldId === fieldId,
  );
}

/** One spelling per operand, so `{ amount, unit }` matches in any key order. */
function sameOperand(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * The field's place in the filter, as a quick filter reads it: no rule on it,
 * exactly one top-level rule under an `and` root, or something else — two
 * rules, one in a nested group, one under an `or` root — which no quick
 * filter names.
 */
export type FieldRuleState =
  { kind: "none" } | { kind: "one"; rule: FilterRule } | { kind: "other" };

export function fieldRuleOf(
  filter: FilterGroup | null,
  fieldId: string,
): FieldRuleState {
  if (filter === null || !holdsField(filter, fieldId)) return { kind: "none" };
  if (filter.conjunction !== "and") return { kind: "other" };
  const nested = filter.children.some(
    (c) => c.kind === "group" && holdsField(c, fieldId),
  );
  if (nested) return { kind: "other" };
  const rules = topLevelRules(filter, fieldId);
  if (rules.length !== 1) return { kind: "other" };
  return { kind: "one", rule: rules[0]! };
}

/**
 * The operand an operand quick filter shows: `undefined` with no rule on the
 * field, the rule's value when the field's one top-level rule is the quick
 * filter's operator, `"other"` when the filter holds anything else on the
 * field (the control then says so, and an edit replaces it).
 */
export function activeQuickOperand(
  filter: FilterGroup | null,
  qf: OperandQuickFilter,
): { kind: "none" } | { kind: "value"; value: unknown } | { kind: "other" } {
  const held = fieldRuleOf(filter, qf.fieldId);
  if (held.kind !== "one") return held;
  return held.rule.operatorId === qf.operatorId && held.rule.value !== undefined
    ? { kind: "value", value: held.rule.value }
    : { kind: "other" };
}

/**
 * The option of `qf` the filter currently IS, or `null` when it holds
 * something no option names — a hand-edited rule, two rules on the field, a
 * rule on it inside a nested group, or one under an `or` root. Matches when
 * the field's top-level rules are exactly one rule equal (operator + operand)
 * to an option's rule, or none (the `rule: null` option).
 */
export function activeQuickOption(
  filter: FilterGroup | null,
  qf: SegmentedQuickFilter,
): string | null {
  const noRule = qf.options.find((o) => o.rule === null)?.id ?? null;
  const held = fieldRuleOf(filter, qf.fieldId);
  if (held.kind === "none") return noRule;
  if (held.kind === "other") return null;
  const { rule } = held;
  return (
    qf.options.find(
      (o) =>
        o.rule !== null &&
        o.rule.operatorId === rule.operatorId &&
        sameOperand(o.rule.value, rule.value),
    )?.id ?? null
  );
}

/**
 * The filter with `option` picked: the field's top-level rules dropped and
 * the option's rule put in the first one's place (reusing its id), else
 * appended under a fresh id — so picking the saved option back leaves the
 * very tree the view was saved with (a clean draft). An `or` root is wrapped
 * in an `and` group first. A tree left with no rule is `null`.
 */
export function applyQuickOption(
  filter: FilterGroup | null,
  qf: SegmentedQuickFilter,
  option: QuickFilterOption,
): FilterGroup | null {
  return applyQuickRule(filter, qf.fieldId, option.rule);
}

/**
 * The filter with an operand quick filter's operand set: its operator's rule
 * on the field with `value`, or — `undefined`, nothing picked — no rule on it.
 */
export function applyQuickOperand(
  filter: FilterGroup | null,
  qf: OperandQuickFilter,
  value: unknown,
): FilterGroup | null {
  return applyQuickRule(
    filter,
    qf.fieldId,
    value === undefined ? null : { operatorId: qf.operatorId, value },
  );
}

/** {@link applyQuickOption}'s rewrite, for one rule (or none) on `fieldId`. */
function applyQuickRule(
  filter: FilterGroup | null,
  fieldId: string,
  quickRule: QuickFilterOption["rule"],
): FilterGroup | null {
  const root: FilterGroup =
    filter === null
      ? emptyGroup("and")
      : filter.conjunction === "and"
        ? filter
        : {
            kind: "group",
            id: newNodeId(),
            conjunction: "and",
            children: [filter],
          };
  const dropped = topLevelRules(root, fieldId);
  const rule: FilterRule | null =
    quickRule === null
      ? null
      : {
          kind: "rule",
          id: dropped[0]?.id ?? newNodeId(),
          fieldId: fieldId,
          operatorId: quickRule.operatorId,
          ...(quickRule.value === undefined ? {} : { value: quickRule.value }),
        };
  const children: FilterNode[] = [];
  let placed = false;
  for (const child of root.children) {
    if (child.kind === "rule" && child.fieldId === fieldId) {
      if (!placed && rule !== null) children.push(rule);
      placed = true;
      continue;
    }
    children.push(child);
  }
  if (!placed && rule !== null) children.push(rule);
  const next: FilterGroup = { ...root, children };
  return countRules(next) === 0 ? null : next;
}
