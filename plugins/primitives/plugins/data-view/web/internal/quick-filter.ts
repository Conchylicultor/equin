import { canonicalJson } from "@plugins/network/plugins/live/plugins/canonical-params/core";
import type {
  FilterGroup,
  FilterNode,
  FilterRule,
  QuickFilter,
  QuickFilterOption,
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
 * The option of `qf` the filter currently IS, or `null` when it holds
 * something no option names — a hand-edited rule, two rules on the field, a
 * rule on it inside a nested group, or one under an `or` root. Matches when
 * the field's top-level rules are exactly one rule equal (operator + operand)
 * to an option's rule, or none (the `rule: null` option).
 */
export function activeQuickOption(
  filter: FilterGroup | null,
  qf: QuickFilter,
): string | null {
  const noRule = qf.options.find((o) => o.rule === null)?.id ?? null;
  if (filter === null || !holdsField(filter, qf.fieldId)) return noRule;
  if (filter.conjunction !== "and") return null;
  const nested = filter.children.some(
    (c) => c.kind === "group" && holdsField(c, qf.fieldId),
  );
  if (nested) return null;
  const rules = topLevelRules(filter, qf.fieldId);
  if (rules.length !== 1) return null;
  const [rule] = rules as [FilterRule];
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
  qf: QuickFilter,
  option: QuickFilterOption,
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
  const dropped = topLevelRules(root, qf.fieldId);
  const rule: FilterRule | null =
    option.rule === null
      ? null
      : {
          kind: "rule",
          id: dropped[0]?.id ?? newNodeId(),
          fieldId: qf.fieldId,
          operatorId: option.rule.operatorId,
          ...(option.rule.value === undefined
            ? {}
            : { value: option.rule.value }),
        };
  const children: FilterNode[] = [];
  let placed = false;
  for (const child of root.children) {
    if (child.kind === "rule" && child.fieldId === qf.fieldId) {
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
