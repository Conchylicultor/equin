import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { createMemoryConfigStore } from "@plugins/config_v2/core";
import { ConfigGitLayer, ConfigStore } from "@plugins/config_v2/server";
import { undeliveredGitLayer } from "./internal/undelivered-git-layer";

export default {
  description:
    "The config host services of a host without the computer (a browser worker host): the user layer held in memory (ConfigStore) and a committed layer not yet delivered to this host (ConfigGitLayer, which throws naming the missing step). Never booted by the desktop, whose providers are config_v2#machine.",
  portable: true,
  contributions: [
    ConfigStore.provide(createMemoryConfigStore()),
    ConfigGitLayer.provide(undeliveredGitLayer),
  ],
} satisfies ServerPluginDefinition;
