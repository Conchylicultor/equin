import { useMemo } from "react";
import type { FieldDef, SortRule } from "../../core";
import { splitPinned } from "./pinned-sort";

export interface SortController<TRow> {
  rules: SortRule[];
  setRules: (rules: SortRule[]) => void;
  /** Fields eligible to sort: have a `value` projection and `sortable !== false`. */
  sortableFields: FieldDef<TRow>[];
  /** Count of rules whose field still resolves (dangling rules excluded), for the pill. */
  ruleCount: number;
  addRule: (fieldId: string) => void; // append asc; no-op if already present
  removeRule: (fieldId: string) => void;
  setDirection: (fieldId: string, direction: "asc" | "desc") => void;
  /** Change a rule's field, keeping direction & position; no-op if nextFieldId already present. */
  setField: (fieldId: string, nextFieldId: string) => void;
  /** Reorder priority, clamped within the rule's own segment (pinned / user). */
  move: (fieldId: string, toIndex: number) => void;
  /**
   * Pin / unpin a rule: pinning moves it to the END of the pinned prefix,
   * unpinning to the HEAD of the user rules — so the toggle never jumps a rule
   * past one the user ordered.
   */
  togglePinned: (fieldId: string) => void;
  /** Drop every USER rule; pinned rules stay (an explicit remove still deletes one). */
  clear: () => void;
}

/** arrayMove(items, from, to) — pure, immutable reorder. */
function arrayMove<T>(items: T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

/**
 * Builder-facing controller for the data-view sort-rule list. Mirrors
 * `useFilterController`'s shape (memoized facade), flat: every action computes the
 * next array immutably and commits it through `setRules` (the host binds that to
 * `setSortRules(activeViewId, …)` → `updateView({ sort }, { merge: true })`).
 */
export function useSortController<TRow>(
  fields: FieldDef<TRow>[],
  rules: SortRule[],
  setRules: (rules: SortRule[]) => void,
): SortController<TRow> {
  const sortableFields = useMemo(
    () => fields.filter((f) => f.value && f.sortable !== false),
    [fields],
  );

  const ruleCount = useMemo(
    () =>
      rules.filter((r) => sortableFields.some((f) => f.id === r.fieldId))
        .length,
    [rules, sortableFields],
  );

  return useMemo(() => {
    const addRule = (fieldId: string) => {
      if (rules.some((r) => r.fieldId === fieldId)) return; // uniqueness invariant
      setRules([...rules, { fieldId, direction: "asc" }]);
    };
    const removeRule = (fieldId: string) => {
      setRules(rules.filter((r) => r.fieldId !== fieldId));
    };
    const setDirection = (fieldId: string, direction: "asc" | "desc") => {
      setRules(
        rules.map((r) => (r.fieldId === fieldId ? { ...r, direction } : r)),
      );
    };
    const setField = (fieldId: string, nextFieldId: string) => {
      if (rules.some((r) => r.fieldId === nextFieldId)) return; // no duplicate field
      setRules(
        rules.map((r) =>
          r.fieldId === fieldId ? { ...r, fieldId: nextFieldId } : r,
        ),
      );
    };
    const move = (fieldId: string, toIndex: number) => {
      const from = rules.findIndex((r) => r.fieldId === fieldId);
      if (from === -1) return;
      // Pinned rules are a prefix: a drag cannot carry a rule across the
      // boundary (pinning is its own gesture), so clamp into its segment.
      const pinnedCount = splitPinned(rules).pinned.length;
      const [lo, hi] = rules[from]?.pinned
        ? [0, pinnedCount - 1]
        : [pinnedCount, rules.length - 1];
      const to = Math.min(Math.max(toIndex, lo), hi);
      if (from === to) return;
      setRules(arrayMove(rules, from, to));
    };
    const togglePinned = (fieldId: string) => {
      const rule = rules.find((r) => r.fieldId === fieldId);
      if (!rule) return;
      const { pinned, user } = splitPinned(rules);
      if (rule.pinned) {
        setRules([
          ...pinned.filter((r) => r.fieldId !== fieldId),
          { fieldId: rule.fieldId, direction: rule.direction },
          ...user,
        ]);
      } else {
        setRules([
          ...pinned,
          { ...rule, pinned: true },
          ...user.filter((r) => r.fieldId !== fieldId),
        ]);
      }
    };
    const clear = () => setRules(splitPinned(rules).pinned);

    return {
      rules,
      setRules,
      sortableFields,
      ruleCount,
      addRule,
      removeRule,
      setDirection,
      setField,
      move,
      togglePinned,
      clear,
    };
  }, [rules, setRules, sortableFields, ruleCount]);
}
