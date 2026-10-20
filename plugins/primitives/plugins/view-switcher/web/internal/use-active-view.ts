import { useCallback, useMemo, useState } from "react";
import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";

/**
 * Device-local active-instance selection. The active-id is *model* state (which
 * named instance the switcher has selected), so it lives in the engine — split
 * out of data-view's old `use-view-state.ts`. Persisted under
 * the store `view-switcher.active-view`, id = `storageKey`.
 *
 * Stored in a budgeted web-storage store (see `activeViews`).
 */
const ACTIVE_SUFFIX = ":active-view";

const activeViews = defineStore({
  owner: "view-switcher.active-view",
  label: "Selected views",
  area: "local",
  cap: "32 KB",
  ttl: 365 * 24 * 60 * 60 * 1000,
  whenFull: "evict-oldest",
  schema: z.string(),
  // Pre-store keys: `${storageKey}:active-view`, the raw view id.
  legacy: {
    match: (key) => key.endsWith(ACTIVE_SUFFIX),
    adopt: (key, raw) => ({
      id: key.slice(0, -ACTIVE_SUFFIX.length),
      value: raw,
      ts: Date.now(),
    }),
  },
});

function readActive(storageKey: string): string | null {
  const read = activeViews.read(storageKey);
  return read.kind === "value" ? read.value : null;
}

export interface ActiveViewState {
  /** Persisted active-instance id (null → caller falls back to defaultView). */
  activeViewId: string | null;
  setActiveView: (viewId: string) => void;
}

export function useActiveViewId(storageKey: string): ActiveViewState {
  const [activeViewId, setActiveViewId] = useState<string | null>(() =>
    readActive(storageKey),
  );

  const setActiveView = useCallback(
    (viewId: string) => {
      activeViews.write(storageKey, viewId);
      setActiveViewId(viewId);
    },
    [storageKey],
  );

  return useMemo(
    () => ({ activeViewId, setActiveView }),
    [activeViewId, setActiveView],
  );
}
