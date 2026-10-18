export { webCollectedDir } from "./collected-dir";
export {
  defineSlot,
  defineSlotFacade,
  defineRootSlot,
  Core,
  slots,
} from "./slots";
export type {
  Slot,
  SlotOptions,
  CompanionFlag,
  RootSlot,
  RootContribution,
} from "./slots";
export { UNSAFE_unsealSlotComponent } from "./sealed-component";
export type {
  SealedComponent,
  SealContributions,
  SealedMeta,
} from "./sealed-component";
export {
  PluginProvider,
  useComposition,
  useRawContributions,
  SLOT_READ_TIMING_PREFIX,
} from "./context";
export type { CompositionIdentity, SlotReadDetail } from "./context";
export { createPluginRegistry } from "./registry";
export {
  MissingCompanionError,
  missingCompanions,
  useCompanionLookup,
} from "./companions";
export type { PluginRegistry } from "./registry";
export type {
  PluginDefinition,
  LoadedPlugin,
  Contribution,
  DocMeta,
} from "./types";
export { loadPlugins } from "./loader";
export type { PluginEntry, PluginLoadError } from "./loader";
export { partitionWebEntries, isDeferredPluginPath } from "./load-tiers";
export {
  useDeferredLoadComplete,
  useFailedPluginPaths,
  getDeferredLoadState,
  subscribeDeferredLoadState,
  markDeferredPluginsLoaded,
  markDeferredLoadComplete,
  markDeferredPluginsFailed,
  hasLoadErrorUnder,
  useHasLoadErrorUnder,
  pluginLoadReportSink,
} from "./deferred-load-store";
export type {
  DeferredLoadState,
  PluginLoadReport,
} from "./deferred-load-store";
