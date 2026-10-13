import { useMemo } from "react";
import { useRawContributions } from "@plugins/framework/plugins/web-sdk/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import { pluginIdSegments } from "@plugins/framework/plugins/plugin-id/core";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import { storePathOf, storePluginId } from "./store-path";
import { ConfigV2 } from "./slots";

export interface ConfigRegistration {
  /**
   * The descriptor MINUS its code defaults, deliberately.
   *
   * `defaults` has to stay on `ConfigDescriptor` — `useConfig` falls back to it
   * for the pre-hydration window — but this registration is how descriptors reach
   * the settings pane, and the settings pane must never diff against the code
   * default. What the repo commits is the git layer (the generated origin ⊕ any
   * committed authored override), and "modified" means the user layer supplied
   * the value; the server answers that per field via `config-v2.tiers`. Three
   * surfaces each re-derived it from `defaults` instead, so a config with a
   * committed override read as permanently modified and every reorder slot always
   * did. Withholding the ingredient is what stops a fourth from appearing.
   */
  descriptor: Omit<ConfigDescriptor, "defaults">;
  /**
   * Canonical DOT-form plugin id this config is *stored* under — the slot-owner
   * when a contribution overrides `pluginId` (e.g. reorder planting each slot's
   * directive under the slot's defining plugin), else the registering plugin.
   * Matches `PluginNode.id`, so the settings tree groups under the owning plugin.
   */
  pluginId: PluginId;
  /** Display label: the store plugin's leaf segment, == its `PluginNode.name`. */
  pluginName: string;
  storePath: string;
}

export function useConfigRegistrations(): ConfigRegistration[] {
  const raw = useRawContributions(ConfigV2.WebRegister);
  return useMemo(
    () =>
      raw
        .filter((c) => storePluginId(c))
        .map((c) => {
          // Single chokepoint: pluginId, pluginName, and storePath all derive
          // from storePluginId (the explicit override, else the registering
          // plugin) so the UI grouping can never drift from the on-disk path.
          const id = storePluginId(c)!;
          const segs = pluginIdSegments(id);
          return {
            descriptor: c.descriptor as ConfigDescriptor,
            pluginId: id,
            pluginName: segs.at(-1) ?? id,
            storePath: storePathOf(c)!,
          };
        }),
    [raw],
  );
}
