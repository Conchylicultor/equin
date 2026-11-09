import { useMemo, useSyncExternalStore } from "react";
import { z } from "zod";
import {
  defineStore,
  useStore,
  type Store,
} from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import {
  type PaneStore,
  usePaneStore,
} from "@plugins/primitives/plugins/pane/web";
import { useSurfaceTabId } from "@plugins/primitives/plugins/scope/plugins/surface-id/web";
import { MIN_COLUMN_WIDTH } from "../layout";

// The widths the USER set by dragging a divider — nothing else ever writes
// here: a column without one is its pane's declared width. Scoped per surface
// (per `PaneStore`): each Miller surface resizes columns independently, so
// dragging a divider in one mounted surface (one desktop window / keep-alive
// tab) never resizes it in another. Persistence is keyed by `(tabId, paneId)`
// so a tab keeps its widths across navigation/reload without bleeding across
// surfaces.
interface SurfaceWidths {
  /** paneId → dragged width; `null` = read, none stored. */
  state: Map<string, number | null>;
  version: number;
  subscribers: Set<() => void>;
}

const byStore = new WeakMap<PaneStore, SurfaceWidths>();

function stateFor(store: PaneStore): SurfaceWidths {
  let s = byStore.get(store);
  if (!s) {
    s = { state: new Map(), version: 0, subscribers: new Set() };
    byStore.set(store, s);
  }
  return s;
}

const widths = defineStore({
  // `.v2`: the previous owner's entries mixed real drags with the automatic
  // 50/50 split the leaf used to persist on its first child — indistinguishable
  // once stored, so they are dropped rather than adopted.
  owner: "miller.column-widths.v2",
  label: "Column widths",
  area: "local",
  cap: "64 KB",
  ttl: 30 * 24 * 60 * 60 * 1000,
  whenFull: "evict-oldest",
  schema: z.number(),
  legacy: {
    match: (key) =>
      key.startsWith("miller.width.") ||
      key.startsWith("s:miller.column-widths:") ||
      key.startsWith("s:miller.column-widths@"),
  },
});

const storeId = (tabId: string, paneId: string) => `${tabId}.${paneId}`;

function readStored(
  s: SurfaceWidths,
  persisted: Store<number>,
  tabId: string | undefined,
  paneId: string,
): number | null {
  const cached = s.state.get(paneId);
  if (cached !== undefined) return cached;
  let v: number | null = null;
  if (tabId !== undefined && typeof window !== "undefined") {
    const read = persisted.read(storeId(tabId, paneId));
    if (read.kind === "value") v = read.value;
  }
  s.state.set(paneId, v);
  return v;
}

export type WidthUpdater = number | ((prev: number) => number);

export interface ColumnWidths {
  /** The column's own width: the dragged one, else `fallback` (the pane's). */
  widthOf(paneId: string, fallback: number): number;
  /** A divider drag: stores the new width (clamped), persisted for the tab. */
  setWidth(paneId: string, next: WidthUpdater, fallback: number): void;
}

/** Records a dragged width and tells this surface's readers. */
function commit(s: SurfaceWidths, paneId: string, width: number): void {
  s.state.set(paneId, width);
  s.version++;
  for (const fn of s.subscribers) fn();
}

/** This surface's column widths; re-renders when any of them changes. */
export function useColumnWidths(): ColumnWidths {
  const store = usePaneStore();
  const tabId = useSurfaceTabId();
  const persisted = useStore(widths);
  const s = stateFor(store);

  const version = useSyncExternalStore(
    (cb) => {
      s.subscribers.add(cb);
      return () => s.subscribers.delete(cb);
    },
    () => s.version,
    () => 0,
  );

  // A new object per version, so a memoized read of `widthOf` re-runs when a
  // width changes.
  return useMemo(
    (): ColumnWidths & { version: number } => ({
      version,
      widthOf: (paneId, fallback) =>
        readStored(s, persisted, tabId, paneId) ?? fallback,
      setWidth: (paneId, next, fallback) => {
        const current = readStored(s, persisted, tabId, paneId) ?? fallback;
        const value = typeof next === "function" ? next(current) : next;
        const clamped = Math.max(MIN_COLUMN_WIDTH, Math.round(value));
        if (clamped === current && s.state.get(paneId) !== null) return;
        // A refused write is reported by the store.
        if (tabId !== undefined)
          persisted.write(storeId(tabId, paneId), clamped);
        commit(s, paneId, clamped);
      },
    }),
    [s, persisted, tabId, version],
  );
}
