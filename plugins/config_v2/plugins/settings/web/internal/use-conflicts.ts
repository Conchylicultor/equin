import { useCallback } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import type { ResourceResult } from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  configConflict,
  configConflictLocations,
} from "@plugins/config_v2/core";
import type {
  ConfigV2ConflictEntry,
  ConfigV2ConflictLocations,
  ConfigV2ConflictMap,
} from "@plugins/config_v2/core";

// One descriptor's conflict entry (or null) for the selected scope. Raw gateable
// result — never collapse loading/error into `null` (that hides "not known" from
// "genuinely no conflict"). Callers gate. `scopeId` selects the scope (undefined
// = Base). Keyed per-path so opening one descriptor recomputes only that one.
export function useConflict(
  storePath: string,
  scopeId?: string,
): ResourceResult<ConfigV2ConflictEntry | null> {
  return useLive(configConflict, { path: storePath, scopeId });
}

// Every conflicting storePath mapped to WHERE it conflicts (base and/or named
// app scopes) — the aggregate that makes a scoped-only conflict both visible and
// locatable without opening the descriptor. Gate on `status` like useConflict.
export function useConflictMap(): ResourceResult<ConfigV2ConflictMap> {
  return useLive(configConflictLocations);
}

// One descriptor's slice of that map, as a stable accessor. `undefined` means
// "no conflict anywhere" — and, while the resource is still loading or its read
// failed, "we don't know", which the detail pane's scope-tab dots and
// conflict-elsewhere banner render as nothing rather than as a claim (a failure
// keeps its last-known map, when it has one). (The nav needs the two apart — its
// filters read them — so it reads `useConflictMap` directly.)
export function useConflictLocationsOf(): (
  storePath: string,
) => ConfigV2ConflictLocations | undefined {
  const res = useConflictMap();
  const map = foldResource(res, {
    loading: () => undefined,
    error: (_error, stale) => stale,
    ready: (data) => data,
  });
  return useCallback((storePath: string) => map?.[storePath], [map]);
}
