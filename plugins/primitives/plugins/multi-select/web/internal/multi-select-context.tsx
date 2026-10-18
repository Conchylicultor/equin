import { createContext, useContext, useReducer, type Dispatch } from "react";
import {
  nextRowSelection,
  type RowSelectionGesture,
} from "@plugins/primitives/plugins/tree/core";

export type MultiSelectState = {
  orderedIds: readonly string[];
  selectedIds: Set<string>;
  anchorId: string | null;
  isActive: boolean;
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
  if (next === prev) return state;
  return {
    ...state,
    selectedIds: new Set(next.selected),
    anchorId: next.anchor,
    isActive: next.selected.size > 0,
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
      // Prune selected IDs that are no longer in the ordered set
      const idSet = new Set(action.ids);
      const pruned = new Set<string>();
      for (const id of state.selectedIds) {
        if (idSet.has(id)) pruned.add(id);
      }
      const anchorId =
        state.anchorId && idSet.has(state.anchorId) ? state.anchorId : null;
      return {
        orderedIds: action.ids,
        selectedIds: pruned,
        anchorId,
        isActive: pruned.size > 0,
      };
    }
  }
}

const initialState: MultiSelectState = {
  orderedIds: [],
  selectedIds: new Set(),
  anchorId: null,
  isActive: false,
};

export function useMultiSelectReducer() {
  return useReducer(multiSelectReducer, initialState);
}
