import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  forkScope as forkScopeEndpoint,
  deleteScope as deleteScopeEndpoint,
  forkDescriptorScope as forkDescriptorScopeEndpoint,
  removeDescriptorScope as removeDescriptorScopeEndpoint,
} from "../core";
import { initRegistry, shutdownRegistry } from "./internal/registry";
import {
  configValuesServed,
  configConflictServed,
  configScopesServed,
  configConflictLocationsServed,
  configModifiedCountsServed,
  configTiersServed,
} from "./internal/resource";
import {
  handleForkScope,
  handleDeleteScope,
  handleForkDescriptorScope,
  handleRemoveDescriptorScope,
} from "./internal/scope-handlers";

export { ConfigV2 } from "./internal/contribution";
export { ConfigGitLayer, ConfigStore } from "./internal/host-services";
export {
  getConfig,
  setConfig,
  setConfigByPath,
  resetConfigByPath,
  watchConfig,
  acknowledgeConflictByPath,
  deleteOverrideByPath,
  mergeConflictByPath,
  hasConfigDocument,
  onDocumentChange,
  reloadConfigDocument,
} from "./internal/registry";
export type { ConfigDocumentTuple, ConfigWriteOpts } from "./internal/registry";
export {
  configValuesServed,
  configRegistryReady,
  configWatcherArmed,
  getAllDescriptors,
  getConfigScopeIds,
  getDescriptorByStorePath,
  getScopedDescriptors,
} from "./internal/resource";
export {
  notifyConfigDirChange,
  onConfigDirChange,
} from "./internal/config-dir-change";
export {
  forkScope,
  deleteScope,
  forkDescriptorScope,
  removeDescriptorScope,
} from "./internal/scope-fork";
export {
  registerFieldStorageProvider,
  getFieldStorageProvider,
  hasFieldStorageProvider,
} from "./internal/field-storage-providers";
export type { FieldStorageProvider } from "./internal/field-storage-providers";

export default {
  description:
    "Typed JSONC config handles for server plugins: the registry over the user-layer store (the ConfigStore host service) and the committed layer (ConfigGitLayer), its live values and the scope routes.",
  portable: true,
  contributions: [
    ...configValuesServed.declare,
    ...configConflictServed.declare,
    ...configScopesServed.declare,
    ...configConflictLocationsServed.declare,
    ...configModifiedCountsServed.declare,
    ...configTiersServed.declare,
  ],
  httpRoutes: {
    [forkScopeEndpoint.route]: handleForkScope,
    [deleteScopeEndpoint.route]: handleDeleteScope,
    [forkDescriptorScopeEndpoint.route]: handleForkDescriptorScope,
    [removeDescriptorScopeEndpoint.route]: handleRemoveDescriptorScope,
  },
  // Blocking: the config registry must be built before resources resolve, so
  // config-driven loaders don't briefly serve empty during a hot-swap.
  // `initRegistry` opens its own gate in a `finally`, so a partial failure
  // surfaces loudly per-path rather than hanging.
  async onReadyBlocking() {
    await initRegistry();
  },
  onShutdown() {
    shutdownRegistry();
  },
} satisfies ServerPluginDefinition;
