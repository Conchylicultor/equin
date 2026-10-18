/**
 * A set of selected rows plus the anchor a range grows from — Finder's
 * selection. The anchor is the "primary" row: the one a click or a toggle last
 * landed on, which a Shift-click or Shift+arrow spans from.
 */
export interface RowSelectionState {
  selected: ReadonlySet<string>;
  anchor: string | null;
}

/**
 * The gestures that change a row selection:
 *
 * - `click` — a plain click: exactly this row, which becomes the anchor.
 * - `toggle` — ⌘/Ctrl-click: flip this row, which becomes the anchor.
 * - `range` — Shift-click: every row between the anchor and this one. It
 *   REPLACES the selection (Finder / Explorer); `additive` keeps what is
 *   selected outside the span instead (a checkbox list's shift-click). The
 *   anchor stays where it was. Without a usable anchor it is a `click`
 *   (`additive`: the row is added and becomes the anchor).
 * - `extend` — Shift+↑/↓: a `range` to the row `delta` steps from `from`
 *   (the focused row), clamped to the ends. See {@link extendTarget}.
 * - `all` — ⌘/Ctrl+A: every row; the anchor is kept.
 * - `clear` — Escape: nothing, no anchor.
 */
export type RowSelectionGesture =
  | { kind: "click"; id: string }
  | { kind: "toggle"; id: string }
  | { kind: "range"; id: string; additive?: boolean }
  | { kind: "extend"; from: string; delta: number }
  | { kind: "all" }
  | { kind: "clear" };

/**
 * The row `delta` steps from `from` in `orderedIds`, clamped to the ends —
 * where an `extend` gesture moves the range's far end (and the keyboard's
 * focus). `null` when `from` is not one of the rows.
 */
export function extendTarget(
  orderedIds: readonly string[],
  from: string,
  delta: number,
): string | null {
  const i = orderedIds.indexOf(from);
  if (i === -1) return null;
  const j = Math.min(orderedIds.length - 1, Math.max(0, i + delta));
  return orderedIds[j]!;
}

/**
 * Apply one gesture to a row selection. Ranges run over `orderedIds` — the rows
 * AS PAINTED (a tree's visible lines), so a collapsed folder's children are
 * never swept into a Shift-click range.
 *
 * Returns `state` itself when nothing changed (same members, same anchor), so a
 * React reducer or setter bails out of the render: a range drag re-applies the
 * same range many times a second.
 */
export function nextRowSelection(
  state: RowSelectionState,
  gesture: RowSelectionGesture,
  orderedIds: readonly string[],
): RowSelectionState {
  return settle(state, apply(state, gesture, orderedIds));
}

function apply(
  state: RowSelectionState,
  gesture: RowSelectionGesture,
  orderedIds: readonly string[],
): RowSelectionState {
  switch (gesture.kind) {
    case "click":
      return { selected: new Set([gesture.id]), anchor: gesture.id };
    case "toggle": {
      const selected = new Set(state.selected);
      if (selected.has(gesture.id)) selected.delete(gesture.id);
      else selected.add(gesture.id);
      return { selected, anchor: gesture.id };
    }
    case "range":
      return range(state, gesture.id, gesture.additive === true, orderedIds);
    case "extend": {
      const target = extendTarget(orderedIds, gesture.from, gesture.delta);
      if (target === null) return state;
      // A range has to start somewhere: with no anchor, the focused row is it.
      const anchored =
        state.anchor !== null && orderedIds.includes(state.anchor)
          ? state
          : { ...state, anchor: gesture.from };
      return range(anchored, target, false, orderedIds);
    }
    case "all":
      return { selected: new Set(orderedIds), anchor: state.anchor };
    case "clear":
      return { selected: new Set(), anchor: null };
  }
}

function range(
  state: RowSelectionState,
  id: string,
  additive: boolean,
  orderedIds: readonly string[],
): RowSelectionState {
  const from = state.anchor === null ? -1 : orderedIds.indexOf(state.anchor);
  const to = orderedIds.indexOf(id);
  if (from === -1 || to === -1) {
    if (!additive) return { selected: new Set([id]), anchor: id };
    return { selected: new Set([...state.selected, id]), anchor: id };
  }
  const selected = new Set(additive ? state.selected : []);
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  for (let i = lo; i <= hi; i++) selected.add(orderedIds[i]!);
  return { selected, anchor: state.anchor };
}

/** `prev` itself when `next` says the same thing. */
function settle(
  prev: RowSelectionState,
  next: RowSelectionState,
): RowSelectionState {
  if (next === prev) return prev;
  if (next.anchor !== prev.anchor) return next;
  if (next.selected.size !== prev.selected.size) return next;
  for (const id of next.selected) if (!prev.selected.has(id)) return next;
  return prev;
}
