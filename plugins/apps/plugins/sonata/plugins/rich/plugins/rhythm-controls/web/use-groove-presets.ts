import { useCallback, useMemo, useState } from "react";
import { arrayMove } from "@plugins/primitives/plugins/sortable-list/web";
import { useConfigResult, useSetConfig } from "@plugins/config_v2/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import {
  foldResource,
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import type { GrooveFields } from "../shared/groove";
import {
  groovePresetsConfig,
  type GroovePreset,
} from "../shared/groove-presets";

/** The saved groove presets and their writers. */
export interface GroovePresetsController {
  presets: readonly GroovePreset[];
  /** Append a preset holding `from`'s content; returns its new stable id. */
  save: (name: string, from: GrooveFields) => string;
  /** Overwrite preset `id`'s content with `from`'s (its name is kept). */
  update: (id: string, from: GrooveFields) => void;
  remove: (id: string) => void;
  /** Move preset `id` to where preset `overId` stands (a drag-and-drop drop). */
  move: (id: string, overId: string) => void;
}

/** A new preset's stable list id — minted client-side so the optimistic row
 *  and the persisted row share identity across the round-trip. */
function newPresetId(): string {
  return `groove-${crypto.randomUUID()}`;
}

/** A preset's content taken from a groove (its provenance is not content). */
function contentOf(from: GrooveFields) {
  return {
    chord: from.chord,
    bass: from.bass,
    chordFigurationId: from.chordFigurationId,
    bassFigurationId: from.bassFigurationId,
  };
}

/** A pending local write: the list it produced and the config list it replaced. */
interface PresetOverlay {
  list: readonly GroovePreset[];
  basis: readonly GroovePreset[];
}

/** The overlay while the config still holds the list it was written over, else the config. */
function effectiveList(
  overlay: PresetOverlay | null,
  persisted: readonly GroovePreset[],
): readonly GroovePreset[] {
  return overlay !== null && overlay.basis === persisted
    ? overlay.list
    : persisted;
}

/**
 * The global saved groove presets (`groovePresetsConfig`) and their writers —
 * `loading` until the config document is known (never the seeds standing in
 * for the user's own list), `error` when it failed to load.
 *
 * Writes are optimistic: an overlay list renders immediately and gives way as
 * soon as the config pushes a new list. Every writer takes an UPDATER over
 * the freshest list, read off a ref that is written FORWARD on each commit, so
 * two writes in one tick (delete, then save) both land — the precedent is
 * data-view's `useSortPresets`. Deliberately not a `setState` updater: the
 * config write beside it is a side effect, and React runs state updaters twice
 * under StrictMode.
 */
export function useGroovePresets(): ResourceResult<GroovePresetsController> {
  const config = useConfigResult(groovePresetsConfig);
  const setConfig = useSetConfig(groovePresetsConfig);
  const setConfigRef = useLatestRef(setConfig);

  // Pending local list, tagged with the config list it was written over
  // (null: none — follow the config). It applies only while the config still
  // holds that same list: the config's next push supersedes it, so nothing
  // ever has to clear it.
  const [overlay, setOverlay] = useState<PresetOverlay | null>(null);
  const overlayRef = useLatestRef(overlay);

  // The config's list as last known — `null` only before it ever loaded,
  // when no writer is handed out (the controller exists on the ready arm only).
  const persisted = foldResource(config, {
    loading: () => null,
    error: (_error, stale) => stale?.presets ?? null,
    ready: (data) => data.presets,
  });
  const persistedRef = useLatestRef(persisted);

  const commit = useCallback(
    (update: (prev: readonly GroovePreset[]) => GroovePreset[]) => {
      const persistedNow = persistedRef.current;
      if (persistedNow === null) {
        throw new Error("useGroovePresets: a write before the presets loaded");
      }
      const next = update(effectiveList(overlayRef.current, persistedNow));
      const tagged = { list: next, basis: persistedNow };
      overlayRef.current = tagged;
      setOverlay(tagged);
      setConfigRef.current("presets", next);
    },
    [overlayRef, persistedRef, setConfigRef],
  );

  const save = useCallback(
    (name: string, from: GrooveFields): string => {
      const id = newPresetId();
      commit((prev) => [...prev, { id, name, ...contentOf(from) }]);
      return id;
    },
    [commit],
  );

  const update = useCallback(
    (id: string, from: GrooveFields) => {
      commit((prev) => {
        if (!prev.some((p) => p.id === id)) {
          throw new Error(`useGroovePresets: no preset "${id}" to update`);
        }
        return prev.map((p) =>
          p.id === id ? { ...p, ...contentOf(from) } : p,
        );
      });
    },
    [commit],
  );

  const remove = useCallback(
    (id: string) => {
      commit((prev) => prev.filter((p) => p.id !== id));
    },
    [commit],
  );

  const move = useCallback(
    (id: string, overId: string) => {
      commit((prev) => {
        const from = prev.findIndex((p) => p.id === id);
        const to = prev.findIndex((p) => p.id === overId);
        if (from === -1 || to === -1) {
          throw new Error(
            `useGroovePresets: cannot move "${id}" onto "${overId}"`,
          );
        }
        return arrayMove([...prev], from, to);
      });
    },
    [commit],
  );

  return useMemo(
    () =>
      mapResource(config, (data) => ({
        presets: effectiveList(overlay, data.presets),
        save,
        update,
        remove,
        move,
      })),
    [config, overlay, save, update, remove, move],
  );
}
