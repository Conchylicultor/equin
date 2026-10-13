import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { presetIdKind, type SortPreset, type SortRule } from "../../core";
import { dataViewDescriptors } from "./descriptors";
import { presetRulesFromLive, readSortPresets } from "./sort-presets";

export interface SortPresetsController {
  presets: SortPreset[];
  /** Append a new preset under an explicit stable id. Takes the LIVE rules and
   *  stores only the user ones — pinned rules belong to the view. */
  savePreset: (label: string, rules: SortRule[]) => void;
  deletePreset: (id: string) => void;
  renamePreset: (id: string, label: string) => void;
  /**
   * Put a deleted preset back where it was — the other half of the one-click
   * trash on a preset row, whose toast offers Undo. Takes the INDEX as well as
   * the preset because a preset's position in the list is part of what the user
   * had; restoring it onto the end would be a different list.
   *
   * Idempotent on identity: a preset already present is moved rather than
   * duplicated, so a double Undo cannot mint a twin.
   */
  restorePreset: (preset: SortPreset, index: number) => void;
}

/** Stable id for a new preset row (`presetIdKind`) — minted client-side, so
 *  the optimistic row and the persisted row share identity across the round-trip. */
function presetId(): string {
  return presetIdKind.mint();
}

/**
 * Reads + writes the per-surface saved sort presets, stored as a sibling
 * `sortPresets` key in the SAME `config/<plugin>/<id>.jsonc` doc that backs the
 * view instances (the data-view host injects that field into the views
 * descriptor — view-core never names it). The descriptor is resolved off the
 * shared `dataViewDescriptors` map by reference identity, exactly as
 * `useViewsConfig` does (throw loud if the id is unknown).
 *
 * Optimistic mirror with a JSON-guarded reconcile effect mirrors
 * `useViewsConfig`, but writes go through **immediately** on each discrete action
 * (no debounce — these are explicit clicks, unlike sort typing). `sortPresets` is
 * an independent config key, so the server merges it per-key over the freshest
 * base — it never clobbers `views` (and vice-versa).
 */
export function useSortPresets(storageKey: string): SortPresetsController {
  const descriptor = dataViewDescriptors.get(storageKey);
  if (!descriptor) {
    throw new Error(
      `data-view: no registered descriptor for storageKey "${storageKey}". ` +
        `Declare it (e.g. defineDataView("${storageKey}")) under the plugin's ` +
        `web/ and run \`./singularity build\` to regenerate the manifest.`,
    );
  }

  const config = useConfig(descriptor);
  const setConfig = useSetConfig(descriptor);

  const persisted = useMemo(
    () => readSortPresets(config.sortPresets),
    [config.sortPresets],
  );

  // Optimistic mirror of the persisted presets.
  const [mirror, setMirror] = useState<SortPreset[]>(() => persisted);

  // Freshest setConfig for the immediate writes.
  const setConfigRef = useLatestRef(setConfig);

  // True only between an optimistic local mutation and the config catching up,
  // so the reconcile effect doesn't clobber the optimistic value mid-flight.
  const pendingRef = useRef(false);

  // Reconcile the mirror from config when external truth advances and we have no
  // pending local write. JSON identity guards against re-render thrash.
  const persistedJson = JSON.stringify(persisted);
  useEffect(() => {
    if (pendingRef.current) return;
    setMirror((prev) => {
      const incoming = JSON.parse(persistedJson) as SortPreset[];
      return JSON.stringify(prev) === JSON.stringify(incoming)
        ? prev
        : incoming;
    });
  }, [persistedJson]);

  // Freshest mirror for the updater below, so `commit` closes over nothing.
  const mirrorRef = useLatestRef(mirror);

  // `commit` stays referentially stable and writes through the freshest
  // setConfig off the stable `setConfigRef.current`.
  //
  // It takes an UPDATER rather than the next list, and reads `prev` off a ref
  // rather than out of a closure: two actions between renders (delete, then Undo
  // from the toast) would otherwise both compute from the same stale list and
  // the second would silently drop the first. Deliberately NOT a `setMirror`
  // updater — the config write beside it is a side effect, and React invokes a
  // state updater twice under StrictMode.
  //
  // The ref is written FORWARD after the update for the same reason: it is
  // otherwise only refreshed in render, so back-to-back commits in one tick
  // would each read the pre-tick list. The render-phase write then re-lands the
  // identical value.
  const commit = useCallback((update: (prev: SortPreset[]) => SortPreset[]) => {
    const next = update(mirrorRef.current);
    pendingRef.current = true;
    mirrorRef.current = next;
    setMirror(next);
    setConfigRef.current("sortPresets", next);
  }, []);

  // The config truth has caught up to (or past) our optimistic write → drop the
  // pending guard so the reconcile effect resumes following external truth.
  useEffect(() => {
    if (JSON.stringify(persisted) === JSON.stringify(mirror)) {
      pendingRef.current = false;
    }
  }, [persisted, mirror]);

  const savePreset = useCallback(
    (label: string, rules: SortRule[]) => {
      commit((prev) => [
        ...prev,
        { id: presetId(), label, rules: presetRulesFromLive(rules) },
      ]);
    },
    [commit],
  );

  const deletePreset = useCallback(
    (id: string) => {
      commit((prev) => prev.filter((p) => p.id !== id));
    },
    [commit],
  );

  const renamePreset = useCallback(
    (id: string, label: string) => {
      commit((prev) => prev.map((p) => (p.id === id ? { ...p, label } : p)));
    },
    [commit],
  );

  const restorePreset = useCallback(
    (preset: SortPreset, index: number) => {
      commit((prev) => {
        const without = prev.filter((p) => p.id !== preset.id);
        // Clamped, not asserted: presets can have left the list from another
        // tab while the toast was on screen, and landing at the end is a better
        // answer there than throwing at the user who pressed Undo.
        without.splice(Math.min(index, without.length), 0, preset);
        return without;
      });
    },
    [commit],
  );

  return useMemo(
    () => ({
      presets: mirror,
      savePreset,
      deletePreset,
      renamePreset,
      restorePreset,
    }),
    [mirror, savePreset, deletePreset, renamePreset, restorePreset],
  );
}
