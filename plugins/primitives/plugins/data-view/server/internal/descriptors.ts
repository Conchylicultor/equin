import { viewsDescriptor } from "@plugins/primitives/plugins/data-view/plugins/view-core/server";
import type { ConfigDescriptor, Disposable } from "@plugins/config_v2/core";
import { getConfig, watchConfig } from "@plugins/config_v2/server";
import { dataViews } from "../../shared/data-views.generated";
import { presetsExtraFields } from "../../shared/sort-presets-field";
import { customColumnsExtraFields } from "../../shared/custom-columns-field";
import { viewMigrations } from "../../shared/view-migrations";

/**
 * The sibling config fields merged into every per-id `viewsDescriptor` — the
 * server twin of the web `extraFields` constant. ONE identity-stable module
 * constant; disjoint keys (`sortPresets` + `filterPresets` + `customColumns`),
 * so merge. Shared by the config registrations and the descriptor map below so
 * both resolve the SAME per-id `viewsDescriptor` (the cache keys by id alone).
 */
export const extraFields = {
  ...presetsExtraFields,
  ...customColumnsExtraFields,
};

/**
 * The reference-stable `ConfigDescriptor` per DataView id for the server runtime —
 * the server twin of the web `dataViewDescriptors`. Built off the SAME per-id
 * `viewsDescriptor` cache the config registrations use, so `getConfig(descriptor)`
 * reads the exact doc a `ConfigV2.Register` planted. This is what lets a server
 * plugin (custom-columns' scoped column set) resolve a surface's config by
 * `dataViewId`, independent of the web.
 */
export const dataViewDescriptors: Map<string, ConfigDescriptor> = new Map(
  dataViews.map((v) => [
    v.id,
    viewsDescriptor(v.id, extraFields, viewMigrations),
  ]),
);

/**
 * Read the parsed config doc for one DataView surface by id (`views` +
 * `sortPresets` + `filterPresets` + `customColumns`), or `{}` for an
 * unregistered id (fail-soft). data-view owns the config descriptors, so this is
 * the single server-side entry point other plugins (e.g. custom-columns'
 * scoped column set) use to resolve a surface's config opaquely — without
 * rebuilding the descriptor map.
 */
export function readDataViewConfigDoc(
  dataViewId: string,
): Record<string, unknown> {
  const descriptor = dataViewDescriptors.get(dataViewId);
  return descriptor ? (getConfig(descriptor) as Record<string, unknown>) : {};
}

/**
 * Watch one DataView surface's config doc (every write, the view state's
 * included — a watcher compares what it reads). Throws for an unregistered id,
 * and before the config registry is ready (call it from `onReady`).
 */
export function watchDataViewConfigDoc(
  dataViewId: string,
  cb: (doc: Record<string, unknown>) => void,
): Disposable {
  const descriptor = dataViewDescriptors.get(dataViewId);
  if (!descriptor) {
    throw new Error(
      `watchDataViewConfigDoc: no DataView "${dataViewId}" is registered (defineDataView).`,
    );
  }
  return watchConfig(descriptor, (values) =>
    cb(values as Record<string, unknown>),
  );
}
