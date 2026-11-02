import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefCallback,
} from "react";
import { useResizeObserverSet } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { fitAlignedColumns } from "@plugins/primitives/plugins/data-table/core";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";

/** The CSS variable holding trailing slot `index`'s width, on the list root. */
export function slotWidthVar(index: number): string {
  return `--list-slot-w-${index}`;
}

/** A slot element's ref: starts measuring it, returns its release. */
export type SlotRef = (el: HTMLElement | null) => (() => void) | undefined;

/** The room a row's title always keeps beside its trailing fields. */
const TITLE_FLOOR_REM = 6;

/** The attribute marking a row's body start — the title cell (one line) or
 *  the stacked title-and-subtitle cell — a direct child of the row's line. */
export const LIST_BODY_ATTR = "data-list-body";

/** How the trailing fields give way: each one's drop order (lower first,
 *  `undefined` last — `dropOrderOf`), and whether they are one column of lines
 *  (a stacked row) rather than side-by-side slots. */
export interface TrailingFitInput {
  dropOrders: readonly (number | undefined)[];
  stacked: boolean;
}

interface SlotState {
  /** `${key}\u0000${index}` → the widest that slot has measured under `key`. */
  max: Map<string, number>;
  /** The element → which slot of which field set it is. */
  slotOf: WeakMap<Element, { key: string; index: number }>;
  /** A row's line (observed) → its trailing cell. */
  cellOf: WeakMap<Element, HTMLElement>;
  /** Every mounted trailing cell: any connected one measures the room. */
  cells: Set<HTMLElement>;
  /** The field set the root's variables currently describe. */
  key: string;
  root: HTMLElement | null;
}

/**
 * Aligned trailing slots for a list: each trailing field draws in a slot whose
 * `min-width` is `var(--list-slot-w-<i>)`, and this hook keeps that variable
 * at the widest that slot has been on any row — written on the list root, so a
 * row never re-renders for it (a CSS variable, not React state). VirtualRows
 * positions its rows absolutely, which rules out a subgrid: the columns line up
 * by a shared width instead.
 *
 * - **Grow-only**: a slot only ever widens, so a row scrolling in with a
 *   longer value pushes the column out once and it stays — a column that
 *   shrank back as rows scroll away would make every row on screen jump.
 * - **Reset on `resetKey`** (the view and its trailing field set): another
 *   field set's widths mean nothing, so the variables describe the new set's
 *   measurements only (measured as its slots mount, before the reset lands).
 * - **Give way, never starve the title** (`shown`): the trailing cell is a
 *   rigid leaf, so trailing fields wider than the row would take the title to
 *   0px. Measured on a row (`cellRef` on its trailing cell): the room from the
 *   title's start to the line's content end — the same whatever subset shows,
 *   so the fit never oscillates — and the fields give way in drop order
 *   (`fitAlignedColumns`, the table's column fit) until the title keeps
 *   {@link TITLE_FLOOR_REM}. A dropped field's width stays measured, which is
 *   what tells the fit when it fits again. Until measured — and in a box with
 *   no layout (jsdom) — every field shows.
 */
export function useSlotWidths(
  resetKey: string,
  slotCount: number,
  fit: TrailingFitInput,
): {
  rootRef: RefCallback<HTMLElement>;
  slotRef: (index: number) => SlotRef;
  cellRef: SlotRef;
  shown: readonly boolean[];
} {
  const state = useRef<SlotState>({
    max: new Map(),
    slotOf: new WeakMap(),
    cellOf: new WeakMap(),
    cells: new Set(),
    key: resetKey,
    root: null,
  });
  // Which slots gave way, for the field set they were fitted under.
  const [dropped, setDropped] = useState<{ key: string; ids: string }>({
    key: resetKey,
    ids: "",
  });
  const fitRef = useLatestRef(fit);

  const write = useCallback((index: number) => {
    const s = state.current;
    if (s.root === null) return;
    const w = s.max.get(`${s.key}\u0000${index}`);
    if (w === undefined) s.root.style.removeProperty(slotWidthVar(index));
    else s.root.style.setProperty(slotWidthVar(index), `${w}px`);
  }, []);

  const refit = useCallback(
    (cell: HTMLElement | undefined) => {
      const s = state.current;
      cell ??= [...s.cells].find((c) => c.isConnected);
      if (cell === undefined) return;
      const budget = trailingBudget(cell);
      if (budget === null) return;
      const { dropOrders, stacked } = fitRef.current;
      const slotGap = stacked
        ? 0
        : parseFloat(getComputedStyle(cell).columnGap) || 0;
      const columns = dropOrders.map((dropOrder, index) => ({
        index,
        px: s.max.get(`${s.key}\u0000${index}`) ?? 0,
        dropOrder,
      }));
      const rem = parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      const kept = new Set(
        fitAlignedColumns(columns, {
          // The fit counts a gap per slot; side by side there is one fewer.
          budget: budget + slotGap,
          gap: slotGap,
          minLabel: TITLE_FLOOR_REM * rem,
          stacked,
        }).map((c) => c.index),
      );
      const ids = columns
        .filter((c) => !kept.has(c.index))
        .map((c) => c.index)
        .join(",");
      const key = s.key;
      setDropped((prev) =>
        prev.key === key && prev.ids === ids ? prev : { key, ids },
      );
    },
    [fitRef],
  );

  const observe = useResizeObserverSet((targets) => {
    const s = state.current;
    let grew = false;
    for (const el of targets) {
      const cell = s.cellOf.get(el);
      if (cell !== undefined) {
        refit(cell);
        continue;
      }
      const slot = s.slotOf.get(el);
      if (slot === undefined) continue;
      const width = Math.ceil(el.getBoundingClientRect().width);
      const id = `${slot.key}\u0000${slot.index}`;
      if (width <= (s.max.get(id) ?? 0)) continue;
      s.max.set(id, width);
      if (slot.key === s.key) {
        write(slot.index);
        grew = true;
      }
    }
    // A wider slot leaves the title less room.
    if (grew) refit(undefined);
  });

  // The field set changed: the root's variables describe the new one.
  useLayoutEffect(() => {
    const s = state.current;
    if (s.key === resetKey) return;
    for (const id of [...s.max.keys()]) {
      if (!id.startsWith(`${resetKey}\u0000`)) s.max.delete(id);
    }
    s.key = resetKey;
    for (let i = 0; i < slotCount; i++) write(i);
  }, [resetKey, slotCount, write]);

  // How the fields give way changed (another view shape, another priority).
  const fitKey = `${fit.stacked}\u0000${fit.dropOrders.join(",")}`;
  useLayoutEffect(() => {
    refit(undefined);
  }, [fitKey, resetKey, refit]);

  const rootRef = useCallback<RefCallback<HTMLElement>>(
    (el) => {
      state.current.root = el;
      if (el !== null) for (let i = 0; i < slotCount; i++) write(i);
    },
    [slotCount, write],
  );

  const slotRef = useCallback(
    (index: number): SlotRef =>
      (el) => {
        if (el === null) return undefined;
        state.current.slotOf.set(el, { key: resetKey, index });
        return observe(el);
      },
    [resetKey, observe],
  );

  // The row's LINE is what resizes with the list (the cell is rigid).
  const cellRef = useCallback<SlotRef>(
    (el) => {
      const line = el?.parentElement;
      if (!el || !line) return undefined;
      const s = state.current;
      s.cells.add(el);
      s.cellOf.set(line, el);
      const release = observe(line);
      return () => {
        s.cells.delete(el);
        release();
      };
    },
    [observe],
  );

  const shown = useMemo(() => {
    const gone =
      dropped.key === resetKey && dropped.ids !== ""
        ? new Set(dropped.ids.split(",").map(Number))
        : new Set<number>();
    return Array.from({ length: slotCount }, (_, i) => !gone.has(i));
  }, [dropped, resetKey, slotCount]);

  return { rootRef, slotRef, cellRef, shown };
}

/**
 * The room a row's title and its trailing fields share, in px: from the body's
 * start ({@link LIST_BODY_ATTR}) to the line's content end, less what else
 * stays in flow after the trailing cell (an always-visible action cluster) and
 * the gaps from the body to the cell. Independent of what the cell holds — it
 * is read from the line's box, never the cell's (a starving cell overflows the
 * line). `null` without a title to keep room for, or without layout (jsdom).
 */
function trailingBudget(cell: HTMLElement): number | null {
  const line = cell.parentElement;
  if (line === null) return null;
  const kids = [...line.children];
  const body = kids.find((k) => k.hasAttribute(LIST_BODY_ATTR));
  if (body === undefined) return null;
  const lineBox = line.getBoundingClientRect();
  if (lineBox.width === 0) return null;
  const lineStyle = getComputedStyle(line);
  const gap = parseFloat(lineStyle.columnGap) || 0;
  const inFlow = (el: Element): boolean => {
    const { position, display } = getComputedStyle(el);
    return (
      position !== "absolute" && position !== "fixed" && display !== "none"
    );
  };
  let end =
    lineBox.right -
    (parseFloat(lineStyle.paddingRight) || 0) -
    (parseFloat(lineStyle.borderRightWidth) || 0);
  for (const after of kids.slice(kids.indexOf(cell) + 1)) {
    if (inFlow(after)) end -= after.getBoundingClientRect().width + gap;
  }
  const between = kids
    .slice(kids.indexOf(body), kids.indexOf(cell))
    .filter(inFlow).length;
  return end - body.getBoundingClientRect().left - between * gap;
}
