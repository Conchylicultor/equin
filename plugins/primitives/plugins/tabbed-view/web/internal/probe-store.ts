import { useSyncExternalStore } from "react";

/** Every tab's probed answers: whether it is available, and its badge. */
export interface ProbeSnapshot<Badge> {
  available: ReadonlyMap<string, boolean>;
  badge: ReadonlyMap<string, Badge | null>;
}

/**
 * One host's per-tab hook answers. Hooks can't run in a filter, so each tab's
 * `useAvailable` / `useBadge` runs in its own probe component (the
 * detail-sections gate technique) that reports here from a layout effect — a
 * store write, so the host re-renders before the browser paints.
 */
export function createProbeStore<Badge>() {
  let snapshot: ProbeSnapshot<Badge> = {
    available: new Map(),
    badge: new Map(),
  };
  const listeners = new Set<() => void>();
  function set<K extends keyof ProbeSnapshot<Badge>>(
    key: K,
    id: string,
    value: ProbeSnapshot<Badge>[K] extends ReadonlyMap<string, infer V>
      ? V
      : never,
  ): void {
    const current = snapshot[key] as ReadonlyMap<string, unknown>;
    if (current.has(id) && current.get(id) === value) return;
    const next = new Map(current);
    next.set(id, value);
    snapshot = { ...snapshot, [key]: next };
    for (const l of listeners) l();
  }
  function remove(key: keyof ProbeSnapshot<Badge>, id: string): void {
    if (!snapshot[key].has(id)) return;
    const next = new Map(snapshot[key] as ReadonlyMap<string, unknown>);
    next.delete(id);
    snapshot = { ...snapshot, [key]: next };
    for (const l of listeners) l();
  }
  return {
    set,
    remove,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSnapshot: () => snapshot,
  };
}
export type ProbeStore<Badge> = ReturnType<typeof createProbeStore<Badge>>;

/**
 * The probes' answers, re-rendering on every report. A static render reads
 * them as they stand: no probe's layout effect runs there, so it reads none.
 */
export function useProbes<Badge>(
  store: ProbeStore<Badge>,
): ProbeSnapshot<Badge> {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}
