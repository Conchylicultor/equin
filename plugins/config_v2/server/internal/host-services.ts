import { defineHostService } from "@plugins/framework/plugins/server-core/core";
import type { ConfigGitLayerImpl, ConfigStoreImpl } from "../../core";

/**
 * Where this host keeps the USER config layer. The registry is portable; its
 * documents are not: the desktop keeps them as files under the namespace's
 * config dir, with a watcher and the agent-write ledger (`config_v2#machine`),
 * and a host without the computer holds them in memory.
 */
export const ConfigStore =
  defineHostService<ConfigStoreImpl>("config-v2.store");

/**
 * The committed (repo) config layer, as the registry reads it: only whether a
 * scope is committed. The desktop asks the checkout's `config/`
 * (`config_v2#machine`).
 */
export const ConfigGitLayer = defineHostService<ConfigGitLayerImpl>(
  "config-v2.git-layer",
);
