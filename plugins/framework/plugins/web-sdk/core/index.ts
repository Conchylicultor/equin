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
  RootScope,
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
  useScopedOutContributions,
  SLOT_READ_TIMING_PREFIX,
  PluginScope,
  usePluginScopeId,
  useScopePlugins,
} from "./context";
export { catalogMismatches } from "./catalog";
export type {
  CompositionIdentity,
  OnDemandPlugins,
  ScopePluginsState,
  ScopedComposition,
  SlotReadDetail,
  EntryFact,
} from "./context";
export { createPluginRegistry } from "./registry";
export { MissingCompanionError, useCompanionLookup } from "./companions";
export type { PluginRegistry } from "./registry";
export type {
  PluginDefinition,
  LoadedPlugin,
  Contribution,
  DocMeta,
} from "./types";
export { loadPlugins } from "./loader";
export type { PluginEntry, PluginLoadError } from "./loader";
export {
  loadAcrossReachLoss,
  markPageReach,
  pageReachLostSince,
  whenPageCanFetch,
} from "./page-reach";
export type { ReachMark } from "./page-reach";
export {
  partitionWebEntries,
  planDeferredLoad,
  isDeferredPluginPath,
} from "./load-tiers";
export {
  hasFirstPaintHolds,
  holdFirstPaint,
  takeFirstPaintHolds,
} from "./first-paint-holds";
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
