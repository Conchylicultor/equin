import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { createMemoryConfigStore } from "@plugins/config_v2/core";
import { ConfigGitLayer, ConfigStore } from "@plugins/config_v2/server";
import { hostStorage } from "@plugins/framework/plugins/browser-server/plugins/host-storage/core";

export default {
  description:
    "The user config layer of a host without the computer (a browser worker host): held in memory (ConfigStore) and written through to the host's declared storage (kept across reloads when it is persistent), each document propagated from the host's committed layer (ConfigGitLayer) on first touch, so it starts as a fresh user's. Never booted by the desktop, whose provider is config_v2#machine.",
  contributions: [
    // `get()` runs lazily, on the first store call — the registry's init, after
    // boot has collected and checked every host service.
    ConfigStore.provide(
      createMemoryConfigStore({
        propagatedFrom: (storePath) => ConfigGitLayer.get().document(storePath),
        // A config document holds no instant: a snapshot's shift leaves it.
        persist: () =>
          hostStorage().store("config", { shiftTime: (doc) => doc }),
      }),
    ),
  ],
} satisfies ServerPluginDefinition;
