// The pass every memo of the tree family hangs off: the caller's file set (a
// check run's, or a writing pass's that re-takes it per evaluation phase).
export {
  codegenPassOver,
  writingCodegenPass,
  type CodegenPass,
} from "./codegen-pass";

// The two plugin-tree constructors: the barrel-free tree (the plugin records)
// and the enriched one (the same records, enriched with the evaluated barrels
// and the slot naming settled over them — `evaluated-barrels.ts`).
export { buildBarrelFreeTree } from "./barrel-free-tree";
export { buildEnrichedTree } from "./enriched-tree";
export {
  evaluateAllBarrels,
  evaluateWebBarrels,
  recordSlotNaming,
} from "./evaluated-barrels";
export type { BarrelEvaluation } from "./evaluated-barrels";

export {
  collectAllPlugins,
  generatePluginDocs,
  pluginClaudeMdPath,
  pluginCompactDocPath,
  pluginDetailsDocPath,
  pluginReferenceMdPath,
  renderCompactDoc,
  renderDetailsDoc,
  renderPluginClaudeMd,
  renderPluginReferenceMd,
  type GenerateDocsOptions,
} from "./docgen";

// The composition-name vocabulary (COMPOSITION_NAME_RE, assertCompositionName,
// RESERVED_COMPOSITION_NAMESPACES, assertServableCompositionNamespace) is NOT
// re-exported here. It lives in `@plugins/plugin-meta/plugins/composition/core`,
// a zero-import module web and server can reach too — this barrel imports `fs`
// at module scope, so a pass-through from here would keep the vocabulary
// unreachable from those runtimes while looking available.
export {
  committedRegistryBundle,
  collectBareSpecifiers,
  collectEntriesWithDeps,
  generateCompositionRegistry,
  generatePluginRegistry,
  renderBackendEntry,
  renderCollectedDirRegistry,
  renderEmptyCollectedDirRegistry,
  resolveRegistryHome,
  buildRegistryGenContext,
  type CollectedRawEntry,
  type RegistryComposition,
  type RegistryGenContext,
} from "./plugin-registry-gen";
export {
  readDeclaredApps,
  readDefineApp,
  type DeclaredApp,
} from "./declared-apps";

export {
  computeEagerTier,
  eagerTierManifestPath,
  generateEagerTier,
  isAppContent,
  renderEagerTierManifest,
  type PreloadOwner,
  type EagerTierResult,
  type WatchedSlotHit,
} from "./eager-tier-gen";

// defineCollectedDir / CollectedDirDef / isCollectedDirDef now live in the
// dependency-free leaf @plugins/framework/plugins/tooling/plugins/collected-dir/core
// (the runtimes import the marker from there without forming a cycle through
// plugin-tree/facets, which codegen depends on).

export {
  generateConfigOrigins,
  propagateConfigToUser,
  renderConfigOriginContent,
  loadConfigDescriptorsByOriginPath,
  resolveOriginAnnotations,
  setDefaultOriginAnnotations,
  setDefaultOriginAnnotationsPreparer,
  resolveOriginDefaults,
  setDefaultOriginDefaults,
  setDefaultOriginDefaultsPreparer,
  type OriginAnnotationsProvider,
  type OriginAnnotationsPreparer,
  type OriginDefaultsProvider,
  type OriginDefaultsPreparer,
} from "./config-origin-gen";

// Build-ONLY seeding of the mandatory (`requiresAuthoredOverride`) config
// overrides, plus the marker scan `regen-generated` asserts on. Deliberately NOT
// part of `regenerateManifestCodegen` — see the note in regen-pipeline.ts.
export {
  seedAuthoredOverrides,
  listReviewMarkedOverrides,
  type AuthoredOverrideSeedResult,
} from "./authored-override-seed";

// Importing this module registers the reorder contribution catalog as the
// default origin-annotations preparer (side effect at load). Both the build
// step and the `config-origins-in-sync` check import this barrel, so both
// processes emit identical contribution-catalog comments in generated origins.
export {
  generateReorderableSlots,
  renderReorderableSlotsManifest,
  reorderableSlotsManifestPath,
  type ReorderableSlotEntry,
} from "./reorderable-slots-gen";

export {
  renderThemeDeclarationsManifest,
  themeDeclarationsManifestPath,
} from "./theme-declarations-gen";

export {
  collectWebSlotContributions,
  type WebSlotContribution,
} from "./web-slot-contributions";

export {
  appDeclarationsManifestPath,
  renderAppDeclarationsManifest,
} from "./app-declarations-gen";

export {
  companionManifestPath,
  renderCompanionManifest,
} from "./companion-manifest-gen";

export {
  assertSlotsDeclared,
  declareSlotsFromBarrels,
} from "./slot-declaration-guard";

export {
  collectDataViews,
  generateDataViews,
  renderDataViewsManifest,
  dataViewsManifestPath,
} from "./data-views-gen";

export {
  collectFieldEagerBarrels,
  generateFieldsEager,
  renderFieldsEagerManifest,
  fieldsEagerManifestPath,
} from "./fields-eager-gen";

// The GIT-LAYER config read (committed origin + committed overrides, stale
// origins ignored), and the one question every generator asks of it: which
// plugins does the app's own composition bundle? Shared by codegen and the
// in-sync checks so both derive identical filtered/annotated output from the
// committed manifests.
export { readGitLayerConfig } from "./git-layer-config";
export {
  mainBundle,
  mainComposition,
  readCompositionManifestsFromDisk,
  resolveMainComposition,
  type MainComposition,
} from "./main-bundle";

export {
  generateBarrelStubs,
  renderBarrelStubs,
  barrelStubsPath,
} from "./barrel-stubs-gen";

export {
  collectTokenGroupVars,
  collectTokenGroups,
  generateTokenGroupVars,
  renderTokenGroupVarsManifest,
  tokenGroupVarsManifestPath,
} from "./token-group-vars-gen";

export {
  COLOR_TOKEN_REF_GROUPS,
  colorTokenRefPath,
  generateColorTokenRef,
  renderColorTokenRef,
} from "./color-token-ref-gen";

export {
  generateCustomUtilities,
  renderCustomUtilities,
  customUtilitiesManifestPath,
  parseCustomUtilities,
} from "./custom-utilities-gen";

export {
  generateSpaceRamp,
  renderSpaceRamp,
  spaceRampManifestPath,
  parseSpaceRamp,
  type RampDecl,
} from "./space-ramp-gen";

export {
  collectIconManifest,
  iconManifestPath,
  renderIconManifest,
} from "./icon-manifest-gen";

// Single source of truth for the ordered, non-migration repo-tree codegen
// pipeline shared by `./equin build` and the push-time `regen-generated`
// normalize step, so the two can never drift apart.
export {
  regenerateRegistryCodegen,
  regenerateManifestCodegen,
  type CodegenStep,
  type RegenCodegenOptions,
  type RegistryCodegenResult,
} from "./regen-pipeline";

// The pre-barrel manifest set — the single source of truth for which
// `*.generated.ts` files MUST be regenerated before the first barrel import.
// Read by both the runtime freeze-point guard and the static completeness check.
export {
  compositionManifestRedirects,
  preBarrelManifests,
  postWebManifests,
  writePreBarrelManifest,
  type HostedComposition,
  type PreBarrelManifest,
} from "./pre-barrel-manifests";

// Static module-import-graph helpers used by the `pre-barrel-manifests-complete`
// check to prove no barrel reaches an unregistered `*.generated.ts` at load.
export {
  collectImportGraph,
  extractRuntimeImportSpecifiers,
  resolveImportSpecifier,
} from "./import-graph";

// The ONE write seam for every generated artifact. The emitters write through
// `writeGenerated`; the `*-in-sync` checks compare disk against
// `formatGenerated({ file, content: renderX(...) })`. Both call the same one, so
// the bytes an emitter produces and the bytes a check asserts cannot drift.
export { formatGenerated, writeGenerated } from "./write-generated";

// A plugin `package.json`'s derived `"name"` written in place (one-line diff).
// The build writes every plugin's; `plugin move` writes the moved ones itself,
// before any install can see a stale or duplicate workspace name.
export { withPackageName } from "./package-names";
export {
  collectExemptRuleIds,
  EXEMPT_RULE_IDS_REL_PATH,
  exemptRuleIdsPath,
  generateExemptRuleIds,
  renderExemptRuleIds,
} from "./exempt-rule-ids-gen";
export {
  CLAUDE_SETTINGS_REL_PATH,
  claudeSettingsPath,
  generateClaudeSettings,
  renderClaudeSettings,
} from "./claude-settings-gen";
export {
  discoverBrowserHosts,
  scopedOnlyWebPlugins,
} from "./browser-host-scope";
export type { BrowserHostDecl } from "./browser-host-scope";
export {
  deriveBrowserHostGraph,
  inferBrowserHostGraph,
  generateBrowserHosts,
  renderBrowserHost,
  renderBrowserHostScope,
} from "./browser-host-gen";
export type {
  DerivedBrowserHostGraph,
  InferredBrowserHostGraph,
} from "./browser-host-gen";
export {
  discoverStaticHost,
  generateStaticHosts,
  renderStaticHostFile,
} from "./static-host-gen";
export type { StaticHostDecl } from "./static-host-gen";
// The browser host's coverage guard: everything its scoped page reads, calls
// or registers has an answer on the host (served, or `needsMachine`). The
// static arms run inside `deriveBrowserHostGraph`; the config and
// contributions arms read the barrels' contributions, so checks run them
// (`config-v2:registrations-paired`, `browser-host:contributions-covered`).
export {
  resolveHostConfigCoverage,
  resolveHostContributionCoverage,
  serverBarrelBlockers,
} from "./browser-host-coverage";
export type {
  HostConfigRegistration,
  HostContributionBarrel,
  HostRead,
} from "./browser-host-coverage";
