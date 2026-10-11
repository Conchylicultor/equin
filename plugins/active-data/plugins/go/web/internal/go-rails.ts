import { useSyncExternalStore } from "react";
import type { LexicalEditor } from "lexical";

/**
 * Where a multi-line draft region's rail sits, in the editor root's content
 * coordinates (the box `GoRegionPlugin` paints, right edge). The region plugin
 * measures it; the region's close marker draws the ✕ there.
 */
export interface RailBox {
  left: number;
  top: number;
  height: number;
}

/** Width of a draft box's rail, reserved on the root's right padding. */
export const RAIL_WIDTH = 28;

interface RailStore {
  rails: ReadonlyMap<string, RailBox>;
  listeners: Set<() => void>;
}

const stores = new WeakMap<LexicalEditor, RailStore>();

function storeOf(editor: LexicalEditor): RailStore {
  let store = stores.get(editor);
  if (!store) {
    store = { rails: new Map(), listeners: new Set() };
    stores.set(editor, store);
  }
  return store;
}

const same = (a: RailBox | undefined, b: RailBox | undefined) =>
  a?.left === b?.left && a?.top === b?.top && a?.height === b?.height;

/** Publishes the rails of an editor's block regions, keyed by close marker. */
export function setRails(
  editor: LexicalEditor,
  rails: ReadonlyMap<string, RailBox>,
) {
  const store = storeOf(editor);
  const prev = store.rails;
  if (
    prev.size === rails.size &&
    [...rails].every(([key, box]) => same(prev.get(key), box))
  ) {
    return;
  }
  store.rails = rails;
  for (const listener of store.listeners) listener();
}

/** The rail of the region `closeKey` closes, or undefined for an inline one. */
export function useRail(
  editor: LexicalEditor,
  closeKey: string,
): RailBox | undefined {
  const store = storeOf(editor);
  return useSyncExternalStore(
    (listener) => {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    () => store.rails.get(closeKey),
  );
}
