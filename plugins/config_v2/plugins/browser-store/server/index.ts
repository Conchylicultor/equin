import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { createMemoryConfigStore } from "@plugins/config_v2/core";
import { ConfigGitLayer, ConfigStore } from "@plugins/config_v2/server";

export default {
  description:
    "The user config layer of a host without the computer (a browser worker host): held in memory (ConfigStore), each document propagated from the host's committed layer (ConfigGitLayer) on first touch, so it starts as a fresh user's. Never booted by the desktop, whose provider is config_v2#machine.",
  portable: true,
  contributions: [
    // `get()` runs lazily, on the first store call — the registry's init, after
    // boot has collected and checked every host service.
    ConfigStore.provide(
      createMemoryConfigStore({
        propagatedFrom: (storePath) => ConfigGitLayer.get().document(storePath),
      }),
    ),
  ],
} satisfies ServerPluginDefinition;
