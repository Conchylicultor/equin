import { createContext, useContext, type Dispatch } from "react";
import {
  nextRowSelection,
  type RowSelectionGesture,
} from "@plugins/primitives/plugins/tree/core";

/** A selection as it is kept across a remount / reload (JSON, view tier). */
export type KeptSelection = {
  selected: string[];
  anchor: string | null;
};

export type MultiSelectState = {
  orderedIds: readonly string[];
  selectedIds: Set<string>;
  anchorId: string | null;
  isActive: boolean;
  /**
   * What of the kept selection still waits for its rows: a remount reads it
   * before the list has (fully) loaded — a tree's child rows, a later page —
   * so each kept id is added to the selection when its row arrives, never
   * pruned for not being there yet. Nothing is written back meanwhile. Any
   * gesture that touches the selection (clear included) ends it. `null` once
   * every kept id has arrived.
   */
  restoring: KeptSelection | null;
};

export type MultiSelectAction =
  | { type: "TOGGLE"; id: string; shiftKey: boolean }
  | { type: "SET_RANGE"; anchorId: string; targetId: string }
  | { type: "SELECT_ALL" }
  | { type: "CLEAR_ALL" }
  | { type: "SET_ORDERED_IDS"; ids: readonly string[] };

type MultiSelectContextValue = {
  state: MultiSelectState;
  dispatch: Dispatch<MultiSelectAction>;
};

const MultiSelectContext = createContext<MultiSelectContextValue | null>(null);

export function useMultiSelectContext(): MultiSelectContextValue {
  const ctx = useContext(MultiSelectContext);
  if (!ctx)
    throw new Error(
      "useMultiSelect* must be used inside <MultiSelectProvider>",
    );
  return ctx;
}

export { MultiSelectContext };

function shallowEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * The selection half of the state, moved by the tree primitive's ONE row
 * selection reducer (`nextRowSelection`, tree/core) — the range and anchor
 * rules a DataView's Finder-style selection uses too. `isActive` follows the
 * set; the reducer's identity bail-out (same members, same anchor → the same
 * object) becomes this reducer's.
 */
function withSelection(
  state: MultiSelectState,
  gesture: RowSelectionGesture,
): MultiSelectState {
  const prev = { selected: state.selectedIds, anchor: state.anchorId };
  const next = nextRowSelection(prev, gesture, state.orderedIds);
  // A gesture ends a restore even when it changes nothing shown (a clear
  // before the kept rows landed must not let them come back).
  if (next === prev)
    return state.restoring === null ? state : { ...state, restoring: null };
  return {
    ...state,
    selectedIds: new Set(next.selected),
    anchorId: next.anchor,
    isActive: next.selected.size > 0,
    restoring: null,
  };
}

export function multiSelectReducer(
  state: MultiSelectState,
  action: MultiSelectAction,
): MultiSelectState {
  switch (action.type) {
    case "TOGGLE":
      // A checkbox's shift-click ADDS the span to what is checked; a plain or
      // meta/ctrl click toggles the one box.
      return withSelection(
        state,
        action.shiftKey
          ? { kind: "range", id: action.id, additive: true }
          : { kind: "toggle", id: action.id },
      );

    case "SET_RANGE": {
      // Replace the selection with exactly the contiguous range
      // [anchorId..targetId] (document-style range select, as opposed to the
      // additive TOGGLE+shift behavior). No-op if either id is unknown.
      //
      // A range drag re-dispatches the SAME range many times a second — once per
      // pointermove, and once per animation frame while the pointer sits parked
      // at a scrolling viewport edge. The reducer hands back the identical state
      // object then, so React bails out of the render entirely; without it every
      // row in the list re-renders at 60fps for a selection that did not change.
      // The anchor is part of what this case writes (extendTo / shift-arrow read
      // it), so an identical set under a moved anchor is still a real change.
      const { anchorId, targetId } = action;
      if (
        !state.orderedIds.includes(anchorId) ||
        !state.orderedIds.includes(targetId)
      )
        return state;
      const anchored =
        state.anchorId === anchorId
          ? state
          : { ...state, anchorId, isActive: state.selectedIds.size > 0 };
      return withSelection(anchored, { kind: "range", id: targetId });
    }

    case "SELECT_ALL":
      return withSelection(state, { kind: "all" });

    case "CLEAR_ALL":
      return withSelection(state, { kind: "clear" });

    case "SET_ORDERED_IDS": {
      if (shallowEqual(state.orderedIds, action.ids)) return state;
      // Prune selected IDs that are no longer in the ordered set.
      const idSet = new Set(action.ids);
      const selected = new Set<string>();
      for (const id of state.selectedIds) if (idSet.has(id)) selected.add(id);
      let anchorId =
        state.anchorId && idSet.has(state.anchorId) ? state.anchorId : null;
      // Kept ids whose rows are here now join the selection; the rest wait.
      let restoring = state.restoring;
      if (restoring !== null) {
        const waiting: string[] = [];
        for (const id of restoring.selected)
          if (idSet.has(id)) selected.add(id);
          else waiting.push(id);
        let waitingAnchor = restoring.anchor;
        if (waitingAnchor !== null && idSet.has(waitingAnchor)) {
          anchorId = waitingAnchor;
          waitingAnchor = null;
        }
        restoring =
          waiting.length === 0
            ? null
            : { selected: waiting, anchor: waitingAnchor };
      }
      return {
        orderedIds: action.ids,
        selectedIds: selected,
        anchorId,
        isActive: selected.size > 0,
        restoring,
      };
    }
  }
}

/**
 * The state a provider mounts with: the kept selection waiting for its rows,
 * applied at once when they are already here (no empty first frame).
 */
export function initialMultiSelectState({
  kept,
  orderedIds,
}: {
  kept: KeptSelection;
  orderedIds: readonly string[];
}): MultiSelectState {
  return multiSelectReducer(
    {
      orderedIds: [],
      selectedIds: new Set(),
      anchorId: null,
      isActive: false,
      restoring: kept.selected.length > 0 ? kept : null,
    },
    { type: "SET_ORDERED_IDS", ids: orderedIds },
  );
}
