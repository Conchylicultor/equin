import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import type { FieldsRecord } from "@plugins/fields/core";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { customColumnIdKind, type CustomColumnDef } from "../../core";
import { readCustomColumnDefs } from "../../shared/read-custom-column-defs";
import { useDeleteCustomColumnValues } from "./use-custom-column-values";

export interface CustomColumnDefsController {
  defs: CustomColumnDef[];
  /** Append a new column of the given field type under a generated stable id. */
  addColumn: (label: string, type: string) => void;
  renameColumn: (id: string, label: string) => void;
  /** Replace a column's opaque per-type config blob (understood only by the type). */
  setColumnConfig: (id: string, config: unknown) => void;
  deleteColumn: (id: string) => void;
}

/** Stable join key for a new column row (no collision with consumer field ids). */
function columnId(): string {
  return customColumnIdKind.mint();
}

/**
 * Reads + writes the per-surface custom-column DEFINITIONS, stored as a sibling
 * `customColumns` key in the SAME `config/<plugin>/<id>.jsonc` doc that backs the
 * view instances + sort presets (the data-view host injects that field into the
 * views descriptor — view-core never names it).
 *
 * A clone of `useSortPresets`, but takes the **resolved `ConfigDescriptor`**
 * (threaded from the data-view host) rather than resolving it off
 * `dataViewDescriptors` — this child must never import data-view (cycle). The
 * descriptor MUST be the SAME object the host registered, since
 * `useConfig`/`useSetConfig` match by reference identity. Optimistic mirror with
 * a JSON-guarded reconcile effect; writes go through immediately per discrete
 * action (explicit clicks, no debounce). `customColumns` is an independent config
 * key, so the server merges it per-key and never clobbers `views`/`sortPresets`.
 */
export function useCustomColumnDefs(
  descriptor: ConfigDescriptor<FieldsRecord> | undefined,
  dataViewId: string,
): CustomColumnDefsController {
  const deleteValues = useDeleteCustomColumnValues();

  if (!descriptor) {
    throw new Error(
      "custom-columns: useCustomColumnDefs requires a resolved config descriptor " +
        "threaded from the DataView host, but received undefined. The DataView's " +
        "storageKey has no registered viewsDescriptor — run `./equin build`.",
    );
  }

  const config = useConfig(descriptor);
  const setConfig = useSetConfig(descriptor);

  const rawDefs = (config as Record<string, unknown>).customColumns;
  const persisted = useMemo(() => readCustomColumnDefs(rawDefs), [rawDefs]);

  // Optimistic mirror of the persisted defs.
  const [mirror, setMirror] = useState<CustomColumnDef[]>(() => persisted);

  // Freshest setConfig for the immediate writes.
  const setConfigRef = useLatestRef(setConfig);

  // True only between an optimistic local mutation and config catching up, so the
  // reconcile effect doesn't clobber the optimistic value mid-flight.
  const pendingRef = useRef(false);

  // Reconcile the mirror from config when external truth advances and we have no
  // pending local write. JSON identity guards against re-render thrash.
  const persistedJson = JSON.stringify(persisted);
  useEffect(() => {
    if (pendingRef.current) return;
    setMirror((prev) => {
      const incoming = JSON.parse(persistedJson) as CustomColumnDef[];
      return JSON.stringify(prev) === JSON.stringify(incoming)
        ? prev
        : incoming;
    });
  }, [persistedJson]);

  // `commit` stays referentially stable and writes through the freshest
  // setConfig off the stable `setConfigRef.current`.
  const commit = useCallback((next: CustomColumnDef[]) => {
    pendingRef.current = true;
    setMirror(next);
    setConfigRef.current("customColumns", next);
  }, []);

  // The config truth has caught up to (or past) our optimistic write → drop the
  // pending guard so the reconcile effect resumes following external truth.
  useEffect(() => {
    if (JSON.stringify(persisted) === JSON.stringify(mirror)) {
      pendingRef.current = false;
    }
  }, [persisted, mirror]);

  const addColumn = useCallback(
    (label: string, type: string) => {
      commit([...mirror, { id: columnId(), label, type }]);
    },
    [commit, mirror],
  );

  const renameColumn = useCallback(
    (id: string, label: string) => {
      commit(mirror.map((c) => (c.id === id ? { ...c, label } : c)));
    },
    [commit, mirror],
  );

  const setColumnConfig = useCallback(
    (id: string, config: unknown) => {
      commit(mirror.map((c) => (c.id === id ? { ...c, config } : c)));
    },
    [commit, mirror],
  );

  const deleteColumn = useCallback(
    (id: string) => {
      deleteValues({ dataViewId, columnId: id });
      commit(mirror.filter((c) => c.id !== id));
    },
    [commit, mirror, deleteValues, dataViewId],
  );

  return useMemo(
    () => ({
      defs: mirror,
      addColumn,
      renameColumn,
      setColumnConfig,
      deleteColumn,
    }),
    [mirror, addColumn, renameColumn, setColumnConfig, deleteColumn],
  );
}
