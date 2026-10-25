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

/**
 * Where the URL holds the active view, when it does: the read and write of one
 * address key (a pane's `;view`, see `usePaneViewParam`). Structural, so this
 * primitive names no router.
 */
export interface ActiveViewUrl {
  /** The id the address names, `undefined` when it names none. */
  value: string | undefined;
  /** Write the id into the address (in place — no history entry). */
  set: (viewId: string) => void;
}

export interface ActiveViewState {
  /** Persisted active-instance id (null → caller falls back to defaultView). */
  activeViewId: string | null;
  /**
   * The id the URL names, when the selection is bound to one. It outranks the
   * persisted id — but only once the caller has checked it names a real view.
   */
  urlViewId: string | undefined;
  /** Select a view: written to this device's store AND, when bound, the URL. */
  setActiveView: (viewId: string) => void;
}

/**
 * The active view of the surface `storageKey`: the device-local selection —
 * the per-device default, what a bare address opens — and, with `url`, the
 * address's own. Selecting writes both, so the address always names what is on
 * screen while the device still remembers it for next time.
 */
export function useActiveViewId(
  storageKey: string,
  url?: ActiveViewUrl | null,
): ActiveViewState {
  const [activeViewId, setActiveViewId] = useState<string | null>(() =>
    readActive(storageKey),
  );

  const setUrl = url?.set;
  const setActiveView = useCallback(
    (viewId: string) => {
      activeViews.write(storageKey, viewId);
      setActiveViewId(viewId);
      setUrl?.(viewId);
    },
    [storageKey, setUrl],
  );

  const urlViewId = url?.value;
  return useMemo(
    () => ({ activeViewId, urlViewId, setActiveView }),
    [activeViewId, urlViewId, setActiveView],
  );
}
