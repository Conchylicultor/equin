import { buildViewDescriptors } from "@plugins/primitives/plugins/data-view/plugins/view-core/web";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import { dataViews } from "../../shared/data-views.generated";
import { presetsExtraFields } from "../../shared/sort-presets-field";
import { customColumnsExtraFields } from "../../shared/custom-columns-field";
import { viewMigrations } from "../../shared/view-migrations";
import type { DataViewId } from "../../core";

/**
 * The sibling config fields merged into every per-id `viewsDescriptor`. ONE
 * identity-stable module constant (the `viewsDescriptor` cache keys by id alone,
 * so the extra-fields object must keep a stable reference per runtime). Keys are
 * disjoint (`sortPresets` + `filterPresets` + `customColumns`) — merge, never replace.
 */
const extraFields = { ...presetsExtraFields, ...customColumnsExtraFields };

/**
 * The per-DataView-id `views` descriptors for the web runtime. data-view owns the
 * manifest (the scraped `defineDataView(...)` id list, each entry carrying its
 * *defining* plugin id); the generic engine (view-core) builds the descriptors
 * from that id list. Each entry is then joined with its `pluginId` so the
 * `ConfigV2.WebRegister` plants the config under the consuming plugin's tree
 * (`config/<asPath(pluginId)>/<id>.jsonc`).
 *
 * `useConfig`/`useSetConfig` match a config registration by descriptor *reference
 * identity*, so the descriptor passed to `ConfigV2.WebRegister` in `web/index.ts`
 * and the one looked up by `useViewModel` MUST be the same object — both come off
 * this single `map`.
 */
const { map, entries } = buildViewDescriptors(
  dataViews.map((v) => v.id),
  extraFields,
  viewMigrations,
);

const pluginIdById = new Map(
  dataViews.map((v) => [v.id, asPluginId(v.pluginId)]),
);

export const dataViewDescriptors = map;
export const dataViewDescriptorEntries = entries.map((e) => ({
  ...e,
  pluginId: pluginIdById.get(e.id)!,
}));

/**
 * Resolve the reference-stable `ConfigDescriptor` for a DataView id — the SAME
 * object the barrels registered with `ConfigV2.WebRegister` (`useConfig`/
 * `useSetConfig` match by `===`). Exposed from the web barrel so cross-plugin
 * contributors (e.g. custom-columns' field-extension + Fields setting) resolve
 * the identical descriptor without importing data-view internals. Generic — names
 * no contributor.
 */
export function getDataViewDescriptor(
  id: DataViewId,
): ConfigDescriptor | undefined {
  return dataViewDescriptors.get(id);
}
