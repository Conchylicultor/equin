// The two plugin-tree constructors live in their own modules, one per tier of
// the ordering `barrel-free-tree` → `slot-declaration-guard` → `enriched-tree`:
// the enriched tree runs the slot-declaration pass before anything can read a
// plugin's `contributions`, and the guard needs a barrel-free tree to know which
// plugins the registry omits. The module layout is what makes that order
// unskippable; the barrel still exports both names, so no consumer moves.
export { buildBarrelFreeTree } from "./barrel-free-tree";
export { buildEnrichedTree } from "./enriched-tree";

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
  collectedDirRegistryPath,
  committedRegistryBundle,
  collectedDirNamedCompositionRegistryPath,
  compositionRegistryFileName,
  compositionRegistryPath,
  compositionFilteredRegistries,
  compositionRegistryRedirects,
  collectBareSpecifiers,
  collectEntriesWithDeps,
  discoverCollectedDirs,
  discoverCollectedDirsIn,
  generateCompositionRegistry,
  generatePluginRegistry,
  listNamedCompositionRegistries,
  parseNamedCompositionRegistryFileName,
  renderCollectedDirRegistry,
  renderEmptyCollectedDirRegistry,
  resolveRegistryHome,
  buildRegistryGenContext,
  standardPluginDirs,
  standardPluginDirsFromSnapshot,
  standardPluginDirsIn,
  type CollectedRawEntry,
  type DiscoveredCollectedDir,
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
  fileConfigProxy,
  generateConfigOrigins,
  propagateConfigToUser,
  readEffectiveConfigFromDisk,
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

// Build-ONLY: the committed config layer resolved and bundled for the browser
// server, one per resident composition (gitignored, beside the web
// registries). Runs after seeding.
export {
  collectConfigGitLayer,
  generateConfigGitLayer,
  renderConfigGitLayer,
} from "./config-git-layer-gen";

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
  generateTokenGroupVars,
  renderTokenGroupVarsManifest,
  tokenGroupVarsManifestPath,
} from "./token-group-vars-gen";

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
// pipeline shared by `./singularity build` and the push-time `regen-generated`
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
  preBarrelManifests,
  postWebManifests,
  writePreBarrelManifest,
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
  collectExemptableRuleIds,
  EXEMPT_RULE_IDS_REL_PATH,
  exemptRuleIdsPath,
  generateExemptRuleIds,
  renderExemptRuleIds,
} from "./exempt-rule-ids-gen";
export {
  deriveBrowserHostGraph,
  discoverBrowserHosts,
  generateBrowserHosts,
  renderBrowserHost,
} from "./browser-host-gen";
export type {
  BrowserHostDecl,
  DerivedBrowserHostGraph,
} from "./browser-host-gen";
// Host services read statically — the browser-host derivation's reading,
// shared with `host-services:provider-placement`.
export {
  baseExclusionServerBarrels,
  hostServicesByName,
  parseHostServiceDeclarations,
  providedServiceNames,
} from "./host-services";
export type { HostServiceDecl } from "./host-services";
