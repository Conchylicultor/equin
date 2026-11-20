import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import type { ConfigDescriptor } from "../../core";

export const ConfigV2 = {
  // `pluginId` is the optional DOT-form plugin-id override (mirrors the server
  // ConfigV2.Register contribution); the store path is derived via asPath(id).
  // `docLabel` mirrors the server twin's extractor so both runtimes name the
  // same config id in the generated docs, instead of one half rendering as a
  // run of identical, information-free `ConfigV2.WebRegister` lines.
  WebRegister: defineSlot<{
    descriptor: ConfigDescriptor;
    pluginId?: PluginId;
  }>({
    docLabel: (c) => c.descriptor.name,
    // Settings have their own declared form and build readers (the config
    // origins, the descriptor index): not list entries of the catalog.
    catalog: {
      omitted:
        "settings are declared through their own descriptors, read by their own build steps",
    },
  }),
};
