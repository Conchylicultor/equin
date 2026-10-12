import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import type { CompositionManifest } from "@plugins/plugin-meta/plugins/closure/core";
import { compositionsConfig } from "./config";

/**
 * One stored composition manifest config item: a {@link CompositionManifest}
 * plus the list field's `id` identity. Derived from the config descriptor's
 * `manifests` field so the shape stays in lockstep with
 * {@link compositionsConfig} (`{ id, name, entryPoints, selectedContributors }`).
 */
export type CompositionManifestItem =
  (typeof compositionsConfig)["fields"]["manifests"]["defaultValue"][number];

/**
 * Drop the list field's `id` identity (and the engine-opaque metadata the
 * closure engine never reads — `category`, `excludes`, and `serve`, the last
 * being the declared serve mode) and present a stored config item
 * as the engine's {@link CompositionManifest}. The id arrays are stored as plain
 * `string[]` (config_v2's string-list field), so we cast at the config boundary
 * to the branded `PluginId[]` exactly like `core/data.ts`'s schema validates
 * the wire shape — that the ids resolve to real plugins is the `composition-closure`
 * check's job. `extends` carries through verbatim (composition names, resolved by
 * `flattenManifest` before closure).
 */
export function manifestItemToManifest(
  item: CompositionManifestItem,
): CompositionManifest {
  return {
    name: item.name,
    entryPoints: item.entryPoints as PluginId[],
    selectedContributors: item.selectedContributors as PluginId[],
    extends: [...item.extends],
  };
}
