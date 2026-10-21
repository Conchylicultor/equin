export { defineConfig } from "./internal/define-config";
export { defineConfigMigration } from "./internal/config-migration";
export type { ConfigMigration } from "./internal/config-migration";
export type {
  Disposable,
  JsonValue,
  ConfigDescriptor,
  ConfigSource,
  ConfigValues,
  OriginDefaultsFrom,
} from "./internal/types";
export {
  configValues,
  configV2ValuesSchema,
  configV2ValidationIssueSchema,
  configV2ConflictEntrySchema,
  configV2ConflictsSchema,
  configConflict,
  configV2TiersSchema,
  configTiers,
  configV2ScopesSchema,
  configV2ScopesMapSchema,
  configScopes,
  configV2ConflictLocationsSchema,
  configV2ConflictMapSchema,
  configConflictLocations,
  configV2ModifiedCountsSchema,
  configModifiedCounts,
  configRawFile,
} from "./internal/resource";
export type {
  ConfigV2Values,
  ConfigV2ValidationIssue,
  ConfigV2ConflictEntry,
  ConfigV2Conflicts,
  ConfigV2Tiers,
  ConfigV2Scopes,
  ConfigV2ScopesMap,
  ConfigV2ConflictLocations,
  ConfigV2ConflictMap,
  ConfigV2ModifiedCounts,
} from "./internal/resource";
export type { ConfigProxy } from "./internal/config-proxy";
export {
  computeHash,
  stringifyConfigValue,
  codeConfigProxy,
  readonlyProxy,
} from "./internal/config-proxy";
export {
  effective,
  hasConflict,
  propagate,
  threeWayMerge,
  readTypedConfig,
  readTypedConfigWithLayer,
  validationIssues,
} from "./internal/tier-logic";
export type { ResolvedLayer, ResolvedConfig } from "./internal/tier-logic";
export { resolveGitLayer } from "./internal/git-layer";
export type { GitLayerDocument } from "./internal/git-layer";
export {
  createMemoryConfigStore,
  configFileRelPath,
  scopeSegment,
  storePathParts,
} from "./internal/store";
export type {
  ConfigDocRef,
  ConfigDocumentFile,
  ConfigFileRef,
  ConfigGitLayerImpl,
  ConfigStoreImpl,
} from "./internal/store";
export {
  setConfigField,
  forkScope,
  deleteScope,
  forkDescriptorScope,
  removeDescriptorScope,
} from "./internal/endpoints";
export { REVIEW_MARKER, hasReviewMarker } from "./internal/review-marker";
export { withOverrideLegend } from "./internal/override-legend";
export { APP_SCOPE_DIR, scopeAppId, appScopeId } from "./internal/scope-format";
export { configFileOwner } from "./internal/config-file-owner";
export {
  mapConfigLists,
  normalizeCollectionItems,
} from "./internal/collections";
export type { ConfigListVisitor } from "./internal/collections";
export {
  orphanFileRoleSchema,
  orphanRiskClassSchema,
  orphanReasonSchema,
  orphanFileSchema,
  orphanEntrySchema,
  orphanReportSchema,
} from "./internal/orphan-report";
export type {
  OrphanFileRole,
  OrphanRiskClass,
  OrphanReason,
  OrphanFile,
  OrphanEntry,
  OrphanReport,
} from "./internal/orphan-report";
