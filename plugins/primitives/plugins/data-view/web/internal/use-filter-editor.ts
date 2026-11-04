import { useCallback, useMemo } from "react";
import type {
  FieldDef,
  FilterConjunction,
  FilterGroup,
  FilterOperatorSet,
} from "../../core";
import { useDataViewControls } from "../components/controls/controls-context";
import {
  addGroup,
  addRule,
  deleteNode,
  emptyGroup,
  findRule,
  setConjunction,
  updateRule,
  wrapRuleInGroup,
} from "./filter-tree-ops";
import { carryOperand } from "./carry-operand";

/**
 * Everything the filter panel's rows need to read the schema and mutate the tree
 * by node id — the schema half of `FilterController` plus the local tree-edit
 * ops, already bound to the live tree.
 */
export interface FilterEditor {
  /**
   * The working root: the committed tree, or a transient empty root that hosts
   * the empty state before the first edit lands. It is the SINGLE source of
   * truth for the root id — rendering and every commit operate on this same
   * object, so a first edit made before anything is committed targets a group
   * that exists in the tree the edit is applied to.
   */
  root: FilterGroup;
  fields: FieldDef<unknown>[];
  resolveOperatorSet: (typeId: string) => FilterOperatorSet | undefined;

  // --- tree edits (all by node id, immutable, commit through setFilter) ---
  /** Add a rule on a specific field (operator defaulted from the field type). */
  addRuleForField: (groupId: string, fieldId: string) => void;
  addGroup: (groupId: string) => void;
  setConjunction: (groupId: string, conjunction: FilterConjunction) => void;
  deleteNode: (id: string) => void;
  wrapRuleInGroup: (ruleId: string) => void;

  /** Set a rule's field, resetting operator → default and clearing value. */
  changeRuleField: (ruleId: string, fieldId: string) => void;
  /** Set a rule's operator, keeping its value when the new operator edits
   *  the same operand shape (`carryOperand`), else clearing it. */
  changeRuleOperator: (ruleId: string, operatorId: string) => void;
  /** Write a rule's operand value. */
  setRuleValue: (ruleId: string, value: unknown) => void;
  /** Drop the whole tree. */
  clear: () => void;
}

/**
 * The filter editor, built fresh from the LIVE controller wherever it is asked
 * for.
 *
 * It is a hook and not a React context, and that is load-bearing rather than a
 * style choice. A pushed panel replaces the root panel's subtree entirely — the
 * stack renders either the root or the top entry, never both — so a provider
 * mounted by the root panel does not wrap the sub-panel pushed out of it, and a
 * context read there would throw. Handing the editor down through the push
 * closure instead would be worse than a crash: the closure is captured when the
 * row is clicked, so the second edit made inside a nested group would be computed
 * against the tree as it was before the first, silently dropping it.
 *
 * Every consumer therefore calls this hook itself and gets the tree as it is now.
 */
export function useFilterEditor(): FilterEditor {
  const { filter: controller } = useDataViewControls();

  const root: FilterGroup = useMemo(
    () => controller.filter ?? emptyGroup("and"),
    [controller.filter],
  );

  // A functional commit helper: apply `fn` to the working root and push the
  // result through setFilter.
  const commit = useCallback(
    (fn: (root: FilterGroup) => FilterGroup) => {
      controller.setFilter(fn(root));
    },
    [controller, root],
  );

  return useMemo<FilterEditor>(() => {
    /** A field type's default operator id (defaultOperator → operators[0]). */
    const defaultOperator = (typeId: string): string => {
      const set = controller.resolveOperatorSet(typeId);
      return set?.defaultOperator ?? set?.operators[0]?.id ?? "";
    };

    return {
      root,
      fields: controller.filterableFields,
      resolveOperatorSet: controller.resolveOperatorSet,
      addRuleForField: (groupId, fieldId) => {
        const field = controller.filterableFields.find((f) => f.id === fieldId);
        if (!field) return;
        commit((r) =>
          addRule(r, groupId, fieldId, defaultOperator(field.type ?? "text")),
        );
      },
      addGroup: (groupId) => commit((r) => addGroup(r, groupId, "and")),
      setConjunction: (groupId, conjunction) =>
        commit((r) => setConjunction(r, groupId, conjunction)),
      deleteNode: (id) => commit((r) => deleteNode(r, id)),
      wrapRuleInGroup: (ruleId) => commit((r) => wrapRuleInGroup(r, ruleId)),
      changeRuleField: (ruleId, fieldId) => {
        const field = controller.filterableFields.find((f) => f.id === fieldId);
        const operatorId = field ? defaultOperator(field.type ?? "text") : "";
        commit((r) =>
          updateRule(r, ruleId, { fieldId, operatorId, value: undefined }),
        );
      },
      changeRuleOperator: (ruleId, operatorId) =>
        commit((r) => {
          const rule = findRule(r, ruleId);
          if (!rule) return r;
          const field = controller.filterableFields.find(
            (f) => f.id === rule.fieldId,
          );
          const operators = field
            ? controller.resolveOperatorSet(field.type ?? "text")?.operators
            : undefined;
          const value = carryOperand(
            operators?.find((o) => o.id === rule.operatorId),
            operators?.find((o) => o.id === operatorId),
            rule.value,
          );
          return updateRule(r, ruleId, { operatorId, value });
        }),
      setRuleValue: (ruleId, value) =>
        commit((r) => updateRule(r, ruleId, { value })),
      clear: () => controller.setFilter(null),
    };
  }, [controller, commit, root]);
}
