import { useCallback, useSyncExternalStore } from "react";
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

const MIN_WIDTH = 200;

// Column widths are scoped per surface (per `PaneStore`): each Miller surface
// resizes columns independently, so dragging a divider in one mounted surface
// (e.g. one desktop window / keep-alive tab) never resizes it in another.
// Persistence is keyed by `(tabId, paneId)` so a tab keeps its widths across
// navigation/reload without bleeding across surfaces.
interface SurfaceWidths {
  state: Map<string, number>;
  subscribers: Set<() => void>;
}

const byStore = new WeakMap<PaneStore, SurfaceWidths>();

function stateFor(store: PaneStore): SurfaceWidths {
  let s = byStore.get(store);
  if (!s) {
    s = { state: new Map(), subscribers: new Set() };
    byStore.set(store, s);
  }
  return s;
}

const widths = defineStore({
  owner: "miller.column-widths",
  label: "Column widths",
  area: "local",
  cap: "64 KB",
  ttl: 30 * 24 * 60 * 60 * 1000,
  whenFull: "evict-oldest",
  schema: z.number(),
  // Pre-store keys (`miller.width.<tabId>.<paneId>`): dropped, not adopted.
  legacy: { match: (key) => key.startsWith("miller.width.") },
});

const storeId = (tabId: string, paneId: string) => `${tabId}.${paneId}`;

/** Whether a column has a width the user set, in the composition scope this renders in. */
export function useHasStoredWidth(): (
  tabId: string | undefined,
  paneId: string,
) => boolean {
  const persisted = useStore(widths);
  return useCallback(
    (tabId, paneId) =>
      tabId !== undefined &&
      persisted.read(storeId(tabId, paneId)).kind === "value",
    [persisted],
  );
}

function readStored(
  persisted: Store<number>,
  tabId: string | undefined,
  paneId: string,
): number | undefined {
  if (tabId === undefined) return undefined;
  const read = persisted.read(storeId(tabId, paneId));
  return read.kind === "value" ? read.value : undefined;
}

function persistWidth(
  persisted: Store<number>,
  tabId: string | undefined,
  paneId: string,
  width: number,
) {
  if (tabId === undefined) return;
  // A refused write is reported by the store.
  persisted.write(storeId(tabId, paneId), width);
}

type WidthUpdater = number | ((prev: number) => number);

function getWidth(
  s: SurfaceWidths,
  persisted: Store<number>,
  tabId: string | undefined,
  paneId: string,
  defaultWidth: number,
): number {
  if (!s.state.has(paneId)) {
    s.state.set(paneId, readStored(persisted, tabId, paneId) ?? defaultWidth);
  }
  return s.state.get(paneId)!;
}

export function useColumnWidth(
  paneId: string,
  defaultWidth: number,
): [number, (next: WidthUpdater) => void] {
  const store = usePaneStore();
  const tabId = useSurfaceTabId();
  const persisted = useStore(widths);
  const s = stateFor(store);

  const width = useSyncExternalStore(
    (cb) => {
      s.subscribers.add(cb);
      return () => s.subscribers.delete(cb);
    },
    () => getWidth(s, persisted, tabId, paneId, defaultWidth),
    () => defaultWidth,
  );

  const setWidth = (next: WidthUpdater) => {
    const current = s.state.get(paneId)!;
    const value = typeof next === "function" ? next(current) : next;
    const clamped = Math.max(MIN_WIDTH, value);
    if (clamped === s.state.get(paneId)) return;
    s.state.set(paneId, clamped);
    persistWidth(persisted, tabId, paneId, clamped);
    for (const fn of s.subscribers) fn();
  };

  return [width, setWidth];
}
