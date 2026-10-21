import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigGitLayer, ConfigStore } from "@plugins/config_v2/server";
import {
  configFilesWatcher,
  initConfigWatcher,
  shutdownConfigWatcher,
} from "./internal/config-watcher";
import { fileConfigStore } from "./internal/file-store";
import { repoConfigLayer } from "./internal/repo-layer";
import { configRawFileServed } from "./internal/raw-file";

export { CONFIG_DIR } from "./internal/config-dir";

export default {
  description:
    "The desktop's config host services: the user layer as JSONC files under the namespace's config dir (watched, every agent-origin write ledgered for revert) and the committed layer read from the checkout's config/, plus the raw-file view of a document's four files.",
  contributions: [
    ConfigStore.provide(fileConfigStore),
    ConfigGitLayer.provide(repoConfigLayer),
    ...configRawFileServed.declare,
  ],
  register: [configFilesWatcher],
  // Background: the file watcher only needs to catch later edits.
  async onReady() {
    await initConfigWatcher();
  },
  async onShutdown() {
    await shutdownConfigWatcher();
  },
} satisfies MachinePluginDefinition;
