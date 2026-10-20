import { useSyncExternalStore } from "react";
import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import {
  type PaneStore,
  usePaneStore,
} from "@plugins/primitives/plugins/pane/web";
import { useSurfaceTabId } from "@plugins/primitives/plugins/scope/plugins/surface-id/web";

// Collapse state is scoped per surface (per `PaneStore`): each Miller surface
// collapses columns independently, so collapsing a column in one mounted surface
// (e.g. one desktop window / keep-alive tab) never collapses it in another.
// Persistence is keyed by `(tabId, paneId)` so it survives navigation within a
// tab session without bleeding across surfaces.
interface SurfaceCollapse {
  state: Map<string, boolean>;
  subscribers: Set<() => void>;
}

const byStore = new WeakMap<PaneStore, SurfaceCollapse>();

function stateFor(store: PaneStore): SurfaceCollapse {
  let s = byStore.get(store);
  if (!s) {
    s = { state: new Map(), subscribers: new Set() };
    byStore.set(store, s);
  }
  return s;
}

const collapsedColumns = defineStore({
  owner: "miller.column-collapse",
  label: "Collapsed columns",
  area: "session",
  cap: "32 KB",
  ttl: Infinity,
  whenFull: "evict-oldest",
  schema: z.boolean(),
  // Pre-store keys (`miller.collapse.<tabId>.<paneId>`): dropped, not adopted.
  legacy: { match: (key) => key.startsWith("miller.collapse.") },
});

const storeId = (tabId: string, paneId: string) => `${tabId}.${paneId}`;

function read(
  s: SurfaceCollapse,
  tabId: string | undefined,
  paneId: string,
): boolean {
  if (s.state.has(paneId)) return s.state.get(paneId)!;
  let v = false;
  if (tabId !== undefined && typeof window !== "undefined") {
    const stored = collapsedColumns.read(storeId(tabId, paneId));
    v = stored.kind === "value" && stored.value;
  }
  s.state.set(paneId, v);
  return v;
}

export function useColumnCollapse(paneId: string): [boolean, () => void] {
  const store = usePaneStore();
  const tabId = useSurfaceTabId();
  const s = stateFor(store);

  const collapsed = useSyncExternalStore(
    (cb) => {
      s.subscribers.add(cb);
      return () => s.subscribers.delete(cb);
    },
    () => read(s, tabId, paneId),
    () => false,
  );

  const toggle = () => {
    const next = !s.state.get(paneId);
    s.state.set(paneId, next);
    if (tabId !== undefined)
      collapsedColumns.write(storeId(tabId, paneId), next);
    for (const fn of s.subscribers) fn();
  };

  return [collapsed, toggle];
}
