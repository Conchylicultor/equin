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

export interface ColumnWidths {
  /** The width the user dragged the column to, or null (none). */
  stored(paneId: string): number | null;
  /** The end of a divider drag: stores the new width (clamped), persisted for the tab. */
  setWidth(paneId: string, width: number): void;
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

  // A new object per version, so a memoized read of `stored` re-runs when a
  // width changes.
  return useMemo(
    (): ColumnWidths & { version: number } => ({
      version,
      stored: (paneId) => readStored(s, persisted, tabId, paneId),
      setWidth: (paneId, width) => {
        const clamped = Math.max(MIN_COLUMN_WIDTH, Math.round(width));
        if (clamped === readStored(s, persisted, tabId, paneId)) return;
        // A refused write is reported by the store.
        if (tabId !== undefined)
          persisted.write(storeId(tabId, paneId), clamped);
        commit(s, paneId, clamped);
      },
    }),
    [s, persisted, tabId, version],
  );
}
