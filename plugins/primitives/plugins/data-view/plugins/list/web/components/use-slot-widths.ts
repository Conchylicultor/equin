import { useCallback, useLayoutEffect, useRef, type RefCallback } from "react";
import { useResizeObserverSet } from "@plugins/primitives/plugins/dom/plugins/element-size/web";

/** The CSS variable holding trailing slot `index`'s width, on the list root. */
export function slotWidthVar(index: number): string {
  return `--list-slot-w-${index}`;
}

/** A slot element's ref: starts measuring it, returns its release. */
export type SlotRef = (el: HTMLElement | null) => (() => void) | undefined;

interface SlotState {
  /** `${key}\u0000${index}` → the widest that slot has measured under `key`. */
  max: Map<string, number>;
  /** The element → which slot of which field set it is. */
  slotOf: WeakMap<Element, { key: string; index: number }>;
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
 */
export function useSlotWidths(
  resetKey: string,
  slotCount: number,
): { rootRef: RefCallback<HTMLElement>; slotRef: (index: number) => SlotRef } {
  const state = useRef<SlotState>({
    max: new Map(),
    slotOf: new WeakMap(),
    key: resetKey,
    root: null,
  });

  const write = useCallback((index: number) => {
    const s = state.current;
    if (s.root === null) return;
    const w = s.max.get(`${s.key}\u0000${index}`);
    if (w === undefined) s.root.style.removeProperty(slotWidthVar(index));
    else s.root.style.setProperty(slotWidthVar(index), `${w}px`);
  }, []);

  const observe = useResizeObserverSet((targets) => {
    const s = state.current;
    for (const el of targets) {
      const slot = s.slotOf.get(el);
      if (slot === undefined) continue;
      const width = Math.ceil(el.getBoundingClientRect().width);
      const id = `${slot.key}\u0000${slot.index}`;
      if (width <= (s.max.get(id) ?? 0)) continue;
      s.max.set(id, width);
      if (slot.key === s.key) write(slot.index);
    }
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

  return { rootRef, slotRef };
}
