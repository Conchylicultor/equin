import { useCallback, useMemo, useState } from "react";
import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import type { ExpandChange } from "@plugins/primitives/plugins/tree/core";

/**
 * Per-instance **render** state: each instance's `{ query, expanded }` (plus
 * the group-by and whole-view collapse flags). The
 * active-instance selection is *model* state and lives in view-core
 * (`useActiveViewId`); durable `sort`/`filter` live on the instance's config row
 * (the config-backed engine owns them). The reader stays tolerant of legacy blobs
 * that still carry `sort`/`filter`/`query` keys (they are simply ignored).
 *
 * State split (see CLAUDE.md):
 *   - active id           → view-core `${storageKey}:active-view`   (device-local)
 *   - expand + collapse   → `${storageKey}:view-state`              (device-local)
 *     (group-by sections AND, on a sections surface, the whole view)
 *   - query               → `${storageKey}:view-query`              (per browser tab)
 *
 * **The search query is deliberately NOT device-local.** Durable narrowings are
 * the config row's (sort / filter / group-by) and render as visible chips; a
 * query is an ad-hoc gesture that outlives its intent if it survives a browser
 * restart, leaving a filtered subset that reads as the view's whole contents.
 * `sessionStorage` keeps the only property worth persisting (an F5 does not lose
 * your place) while a new tab / browser restart start clean. Scope is the
 * *browser* tab (the `primitives/scope/tab-id` precedent), not an app tab — two app
 * tabs on one surface share a query, exactly as they did before.
 */

const STATE_SUFFIX = ":view-state";
const QUERY_SUFFIX = ":view-query";

/** The durable half — device-local, survives a browser restart. */
export interface LocalViewState {
  expanded: Record<string, boolean>;
  /** Collapsed group-by section keys (absence = expanded). */
  collapsedSections: string[];
  /**
   * The whole VIEW folded to its header — a view rendered as one section of a
   * `{ kind: "sections" }` surface. A view-level flag, deliberately not a key in
   * `collapsedSections`: those are the view's own group-by values, and no
   * sentinel key can be guaranteed never to be one.
   */
  collapsed: boolean;
}
type LocalMap = Record<string, LocalViewState>;

/** The transient half — one query per view instance, scoped to the browser tab. */
type QueryMap = Record<string, string>;

const EMPTY_LOCAL: LocalViewState = {
  expanded: {},
  collapsedSections: [],
  collapsed: false,
};

// ---------------------------------------------------------------------------
// Web Storage: the two halves are budgeted stores keyed by the surface's
// `storageKey`. Pre-store keys (`${storageKey}:view-state` / `:view-query`, raw
// JSON map, no envelope) are adopted on first use.
// ---------------------------------------------------------------------------

const localViewStateSchema = z.object({
  expanded: z.record(z.string(), z.boolean()).default({}),
  collapsedSections: z.array(z.string()).default([]),
  collapsed: z.boolean().default(false),
});
const localMapSchema = z.record(z.string(), localViewStateSchema);
const queryMapSchema = z.record(z.string(), z.string());

/** Adopt an old `${storageKey}${suffix}` key: its raw value was the JSON map. */
function adoptSuffixed(suffix: string) {
  return (key: string, raw: string) => {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (err) {
      if (err instanceof SyntaxError) return null;
      throw err;
    }
    return { id: key.slice(0, -suffix.length), value, ts: Date.now() };
  };
}

const viewStates = defineStore({
  owner: "data-view.view-state",
  label: "List view states",
  area: "local",
  cap: "512 KB",
  ttl: 90 * 24 * 60 * 60 * 1000,
  whenFull: "evict-oldest",
  schema: localMapSchema,
  legacy: {
    match: (key) => key.endsWith(STATE_SUFFIX),
    adopt: adoptSuffixed(STATE_SUFFIX),
  },
});

const viewQueries = defineStore({
  owner: "data-view.view-queries",
  label: "List view searches",
  area: "session",
  cap: "64 KB",
  ttl: Infinity,
  whenFull: "evict-oldest",
  schema: queryMapSchema,
  legacy: {
    match: (key) => key.endsWith(QUERY_SUFFIX),
    adopt: adoptSuffixed(QUERY_SUFFIX),
  },
});

function readLocalMap(storageKey: string): LocalMap {
  const read = viewStates.read(storageKey);
  return read.kind === "value" ? read.value : {};
}

function readQueryMap(storageKey: string): QueryMap {
  const read = viewQueries.read(storageKey);
  return read.kind === "value" ? read.value : {};
}

export interface EphemeralViewState {
  /** Per-instance device-local render state (expanded / collapsedSections /
   *  collapsed) — the STORED blob, so it keeps its identity until a write to
   *  this view replaces it (the model's cached getters key on it). */
  localFor: (viewId: string) => LocalViewState;
  /** This browser tab's search query for the instance. */
  queryFor: (viewId: string) => string;
  setQuery: (viewId: string, query: string) => void;
  /** Apply a whole expand/collapse batch in ONE localStorage write. */
  setExpanded: (viewId: string, changes: readonly ExpandChange[]) => void;
  /** Collapse/expand a group-by section (device-local; absence = expanded). */
  setSectionCollapsed: (
    viewId: string,
    key: string,
    collapsed: boolean,
  ) => void;
  /** Fold/unfold the whole view as one section of a sections surface. */
  setViewCollapsed: (viewId: string, collapsed: boolean) => void;
}

/**
 * Slim Web-Storage ephemeral render state: expand/collapse in `localStorage`,
 * the search query in `sessionStorage`. Active-id lives in view-core; durable
 * sort/filter live on the config row.
 */
export function useViewEphemeral(storageKey: string): EphemeralViewState {
  const [localMap, setLocalMap] = useState<LocalMap>(() =>
    readLocalMap(storageKey),
  );
  const [queryMap, setQueryMap] = useState<QueryMap>(() =>
    readQueryMap(storageKey),
  );

  const writeLocal = useCallback(
    (viewId: string, mutate: (prev: LocalViewState) => LocalViewState) => {
      setLocalMap((prev) => {
        const current = prev[viewId] ?? EMPTY_LOCAL;
        const next = { ...prev, [viewId]: mutate(current) };
        viewStates.write(storageKey, next);
        return next;
      });
    },
    [storageKey],
  );

  const localFor = useCallback(
    (viewId: string): LocalViewState => localMap[viewId] ?? EMPTY_LOCAL,
    [localMap],
  );
  const queryFor = useCallback(
    (viewId: string): string => queryMap[viewId] ?? "",
    [queryMap],
  );

  const setQuery = useCallback(
    (viewId: string, query: string) => {
      setQueryMap((prev) => {
        const next = { ...prev, [viewId]: query };
        viewQueries.write(storageKey, next);
        return next;
      });
    },
    [storageKey],
  );

  const setExpanded = useCallback(
    (viewId: string, changes: readonly ExpandChange[]) => {
      if (changes.length === 0) return;
      // `writeLocal` JSON.stringifies the WHOLE per-surface map, so the batch
      // must land in a single mutate: a per-row call would re-serialize a map
      // growing to N keys N times — quadratic on expand-all over a large tree.
      writeLocal(viewId, (prev) => {
        const expanded = { ...prev.expanded };
        for (const c of changes) expanded[c.id] = c.expanded;
        return { ...prev, expanded };
      });
    },
    [writeLocal],
  );

  const setSectionCollapsed = useCallback(
    (viewId: string, key: string, collapsed: boolean) => {
      writeLocal(viewId, (prev) => {
        const set = new Set(prev.collapsedSections);
        if (collapsed) set.add(key);
        else set.delete(key);
        return { ...prev, collapsedSections: [...set] };
      });
    },
    [writeLocal],
  );

  const setViewCollapsed = useCallback(
    (viewId: string, collapsed: boolean) => {
      writeLocal(viewId, (prev) => ({ ...prev, collapsed }));
    },
    [writeLocal],
  );

  return useMemo(
    () => ({
      localFor,
      queryFor,
      setQuery,
      setExpanded,
      setSectionCollapsed,
      setViewCollapsed,
    }),
    [
      localFor,
      queryFor,
      setQuery,
      setExpanded,
      setSectionCollapsed,
      setViewCollapsed,
    ],
  );
}
