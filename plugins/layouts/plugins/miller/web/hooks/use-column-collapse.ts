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

// Collapse state is scoped per surface (per `PaneStore`): each Miller surface
// collapses columns independently, so collapsing a column in one mounted surface
// (e.g. one desktop window / keep-alive tab) never collapses it in another.
// Keyed by the column's pane-slot uuid, persisted by `(tabId, uuid)` so it
// survives navigation within a tab session without bleeding across surfaces.
interface SurfaceCollapse {
  state: Map<string, boolean>;
  version: number;
  subscribers: Set<() => void>;
}

const byStore = new WeakMap<PaneStore, SurfaceCollapse>();

function stateFor(store: PaneStore): SurfaceCollapse {
  let s = byStore.get(store);
  if (!s) {
    s = { state: new Map(), version: 0, subscribers: new Set() };
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

const storeId = (tabId: string, id: string) => `${tabId}.${id}`;

function read(
  s: SurfaceCollapse,
  persisted: Store<boolean>,
  tabId: string | undefined,
  id: string,
): boolean {
  const cached = s.state.get(id);
  if (cached !== undefined) return cached;
  let v = false;
  if (tabId !== undefined && typeof window !== "undefined") {
    const stored = persisted.read(storeId(tabId, id));
    v = stored.kind === "value" && stored.value;
  }
  s.state.set(id, v);
  return v;
}

export interface CollapsedColumns {
  isCollapsed(id: string): boolean;
  toggle(id: string): void;
}

/** Records a toggle and tells this surface's readers. */
function commit(s: SurfaceCollapse, id: string, value: boolean): void {
  s.state.set(id, value);
  s.version++;
  for (const fn of s.subscribers) fn();
}

/** This surface's user-collapsed columns; re-renders when one toggles. */
export function useCollapsedColumns(): CollapsedColumns {
  const store = usePaneStore();
  const tabId = useSurfaceTabId();
  const persisted = useStore(collapsedColumns);
  const s = stateFor(store);

  const version = useSyncExternalStore(
    (cb) => {
      s.subscribers.add(cb);
      return () => s.subscribers.delete(cb);
    },
    () => s.version,
    () => 0,
  );

  // A new object per version, so a memoized read of `isCollapsed` re-runs.
  return useMemo(
    (): CollapsedColumns & { version: number } => ({
      version,
      isCollapsed: (id) => read(s, persisted, tabId, id),
      toggle: (id) => {
        const next = !read(s, persisted, tabId, id);
        if (tabId !== undefined) persisted.write(storeId(tabId, id), next);
        commit(s, id, next);
      },
    }),
    [s, persisted, tabId, version],
  );
}
