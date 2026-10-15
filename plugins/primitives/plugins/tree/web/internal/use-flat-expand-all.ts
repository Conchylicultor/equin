import { useCallback, useMemo } from "react";
import type { ExpandChange } from "../../core";
import type { TreeItem } from "./types";

export type FlatExpandAll = {
  /**
   * Whether an expand-all is meaningful at all — there is at least one row with
   * children. A flat set has nothing to unfold, and the toolbar button is hidden
   * rather than shown inert.
   */
  hasExpandable: boolean;
  allExpanded: boolean;
  /** The batch that flips every expandable row to `next`. */
  changes(next: boolean): ExpandChange[];
};

/**
 * Whole-set expand/collapse over a FLAT row array, as a pure value.
 *
 * The set it writes is the rows that some other row names as its parent: a
 * childless row's `expanded` flag paints nothing, so including it would only pad
 * the batch. Membership is read off the parent links rather than off a built
 * tree, because the callers hold rows, not a forest — which is what lets one
 * implementation serve a tree's scoped rows and a grouped view's
 * per-section bucket alike.
 *
 * Contrast `buildSubtreeExpandIndex`, which answers the same question for every
 * row of ONE tree: that needs the hierarchy and walks it once per render; this
 * needs only the membership set.
 */
export function flatExpandAll<T extends TreeItem>(
  rows: readonly T[],
): FlatExpandAll {
  const childSet = new Set(
    rows.filter((r) => r.parentId).map((r) => r.parentId!),
  );
  const expandable = rows.filter((r) => childSet.has(r.id));
  return {
    hasExpandable: expandable.length > 0,
    allExpanded: expandable.length > 0 && expandable.every((r) => r.expanded),
    // Only the rows that actually change, so re-collapsing a mostly-closed tree
    // does not rewrite the rows already in the target state.
    changes: (next) =>
      expandable
        .filter((r) => r.expanded !== next)
        .map((r) => ({ id: r.id, expanded: next })),
  };
}

export type UseFlatExpandAllReturn = {
  hasExpandable: boolean;
  allExpanded: boolean;
  /** Flip every expandable row, in ONE batched `setExpanded`. */
  toggle: () => void;
};

/**
 * The hook form of {@link flatExpandAll}: memoized on `rows`, with the toggle
 * bound to a `setExpanded` sink.
 *
 * Two surfaces converge here — a tree's toolbar expand-all and a group
 * header's per-section toggle — so the
 * "which rows are expandable / are they all open / write only what changes"
 * decision is made once instead of once per surface.
 */
export function useFlatExpandAll<T extends TreeItem>(
  rows: readonly T[],
  setExpanded: (changes: readonly ExpandChange[]) => void | Promise<void>,
): UseFlatExpandAllReturn {
  const state = useMemo(() => flatExpandAll(rows), [rows]);

  const toggle = useCallback(() => {
    // ONE call for the whole set — the reason the seam is batch-shaped.
    void setExpanded(state.changes(!state.allExpanded));
  }, [state, setExpanded]);

  return {
    hasExpandable: state.hasExpandable,
    allExpanded: state.allExpanded,
    toggle,
  };
}
