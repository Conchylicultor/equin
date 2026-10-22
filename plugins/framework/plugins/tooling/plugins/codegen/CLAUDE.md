# codegen

Build-time generators run by `./singularity build`: the plugin registries, the
docs, and derived manifests such as the web load tiers.

## Eager tier: preload pins (`core/eager-tier-gen.ts`)

A plugin declaring a resource with `preload: "boot"` / `"boot-and-keep"` is
pinned into the eager web tier, and the manifest names the keys it preloads.
The keys come from the resource vocabulary (`tooling/resource-vocabulary`), not
from the factory name: `preloadedKeysIn` reads each call's mints through
`mintsOf` — the same reading the docs facet uses — and pushes only the mints the
flag reaches (`preloadable`). So `requires` decides the key: a `liveCollection`
with `default` preloads `k` (its window), one declared `all` preloads `k` (the
whole ordered set), a lookup-only one preloads nothing — and a spec setting both
`default` and `all` throws instead of pinning `k` twice (`unless` is its
complement: a `liveValue` mints a plain `k` unless it is `paged`, whose `k`
is a keyed window, never preloaded). `mintsOf` runs BEFORE
the `preload:` test, so a spec whose fields are not in the call's text (an
identifier, a wrapper call, `{ … } as const`) throws, naming file and line,
rather than reading as "not preloaded". A factory's own declaration
(`function liveValue(…)`) is no call and is skipped. Pinned by
`core/eager-tier-gen.test.ts`.

## Browser hosts: an inferred graph (`core/browser-host-gen.ts`)

A plugin with `bin/browser-host.composition.ts`
(`export const hostComposition = "<name>";`, read by regex, never evaluated)
declares a browser host. `deriveBrowserHostGraph` infers its worker graph from
that composition, the way the desktop boots every plugin of its own: the
bundle's `portable: true` server barrels (`isPortableServerBarrel`,
`parse-utils`), the portable barrels `bin/browser-host.ts` loads, and — to a
fixpoint — the `base-exclusions`-negated portable barrel providing each host
service the graph's code declares (`core/host-services.ts`; exactly one, else
it throws naming the service and candidates). Negatives are never flipped, so
a negated plugin providing nothing (`review/plugin-changes`) stays out. Every
server barrel the graph's `importClosure` reaches must be in it, or it throws
with the import chain — the worker's boot assert, moved to build. Emitted as
`bin/browser-host.generated.ts` (`hostEntries`, `hostProviders`), held by
`plugins-registry-in-sync`; the rule is pinned by `core/browser-host-gen.test.ts`.

The page side comes from the same derivation: `core/browser-host.generated.ts`
(`browserHost`: the composition's id, home, web plugins — bundle ∩ web barrels —
and the worker's `start`), the scope `<PluginScope>` renders the host's subtree
in. The scope is an upper bound: a page whose own composition lacks a scoped
plugin renders less, so nothing ties it to the compositions shipping the host.
It is a registry-phase output (barrel-free, written before any barrel import),
which `pre-barrel-manifests-complete` allows a barrel to reach.

### The coverage guard (`core/browser-host-coverage.ts`)

`deriveBrowserHostGraph` = `inferBrowserHostGraph` + `resolveHostCoverage`: a
host whose scoped page uses something its worker cannot answer is not emitted
— the derivation throws, so a gap fails codegen, `build` and
`plugins-registry-in-sync` (`push`). **Nothing exempts it**: a gap is cleared
by making the serving barrel portable, splitting what it serves into a
portable `server/` half, or declaring the declaration `needsMachine`. Read
from source text, never evaluated, over every non-test file of each scoped
web plugin's `web/` and own `shared/`, plus every `web/` / `shared/` / `core/`
helper module a reader imports a name from (resolved through barrels and
re-exports to the declaring file). A file importing `pageTransport` (or the
page pipeline's client accessors) is PAGE-BOUND (sanctioned by
`networking/no-page-transport`, which has no inline opt-out): its endpoints
and raw `/api` URLs are the page's, its live reads are still the scope's
(`useLive` goes through the context transport), and it may hold no scope
fetcher (`useFetchEndpoint`, a `FetchEndpoint`, `useEndpoint`,
`useEndpointMutation`) — a module is the page's or the scope's, never both.

- **Live reads** — a declaration it imports (the resource vocabulary's
  `buildDescriptorIndex`, which also reads `needsMachine` and
  `origin: "central"`) is served when a graph member's `server/` registers its
  key (`registerCallTarget`, the docs facet's reading, plus serving wrappers:
  a function handing its first parameter to a register call), or declares
  `needsMachine`. A central read must be `needsMachine` (no browser host runs
  central).
- **Endpoints** — a declaration it imports (`endpointExports`, parse-utils) is
  served when a member's `server/` `httpRoutes` routes it, or declares
  `needsMachine`; a raw `"/api/<prefix>…` literal must hit a prefix a member
  routes (a prefix no backend barrel routes — the resource runtime's, the
  asset mirror's — is not judged).
- **Config** — the arm that needs the barrels' contributions
  (`resolveHostConfigCoverage`) cannot run in this barrel-free phase; it runs
  in `config-v2:registrations-paired` over `collectConfigRegistrations`. No
  `needsMachine` escape.
- **Contributions** (`resolveHostContributionCoverage`, run by this plugin's
  `browser-host:contributions-covered` check, which imports the barrels): a
  scoped web plugin whose `server/` barrel the host does not boot must not
  contribute to a kind a graph member declares — the member would answer the
  scope without it (a task category's label, a list's exposed column). The
  declaring plugin of each kind is read statically
  (`parseServerContributionDeclarations` over every `defineServerContribution`
  call); a kind declared `absentOnHost: { reason }` (`Trigger`, `ReportKind`:
  its contributor's own reaction or bookkeeping, read by nothing a host
  serves) is not this arm's, nor is a host service's provider. Cleared by
  making the barrel portable or moving the contribution into a portable
  `server/` half. No exemption.

Each failure names the key or route, the declaration's file, up to three
readers (file:line), every plugin in the repo serving it and why that one is
outside the graph: desktop-only `machine/`, central, not in the composition,
or not portable — with the non-portable barrels it reaches (import chain) and
its own modules that need the computer (`serverBarrelBlockers`). The reads it
found are emitted as `hostReads` in the page side's
`core/browser-host.generated.ts`; the owner's boot test holds the booted
graph's `Resource.Declare` set to them. Pinned by
`core/browser-host-coverage.test.ts`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Plugin doc generation and registry codegen
- Core:
  - Uses: 109 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `plugin-meta/parse-utils` ×16
    - `config_v2` ×15
    - `framework/plugin-id` ×14
    - `framework/tooling/resource-vocabulary` ×10
    - `plugin-meta/closure` ×7
    - `plugin-meta/barrel-import` ×6
    - `plugin-meta/composition` ×5
    - `plugin-meta/facets` ×5
    - `plugin-meta/plugin-tree` ×4
    - `framework/slot-declaration` ×3
    - `config_v2/ledger` ×2
    - `framework/tooling/boundaries` ×2
    - `framework/tooling/format` ×2
    - `framework/tooling/import-closure` ×2
    - `framework/tooling` ×2
    - `infra/namespace` ×2
    - `packages/macrotask-yield` ×2
    - `fields/reorder-tree.REORDER_NODE_LEGEND`
    - `framework/tooling/lint.loadLintContributions`
    - `framework/tooling/web-artifacts.COMPOSITION_SPECIFIERS`
    - `packages/resource-protocol.RESOURCE_HTTP_ROUTE`
    - `packages/semaphore.createSemaphore`
    - `plugin-meta/facets/contributions.contributionsFacetDef`
    - `plugin-meta/facets/exemptions.exemptionsFacetDef`
    - `plugin-meta/facets/slots.slotsFacetDef`
    - `primitives/css/ui-kit.APP_STYLESHEET_PATH`
    - `ui/icons.isIconRefModule`
  - Exports (types):
    - `AuthoredOverrideSeedResult`
    - `BrowserHostDecl`
    - `CodegenStep`
    - `CollectedRawEntry`
    - `DeclaredApp`
    - `DerivedBrowserHostGraph`
    - `DiscoveredCollectedDir`
    - `EagerTierResult`
    - `GenerateDocsOptions`
    - `HostConfigRegistration`
    - `HostContributionBarrel`
    - `HostRead`
    - `HostServiceDecl`
    - `InferredBrowserHostGraph`
    - `MainComposition`
    - `OriginAnnotationsPreparer`
    - `OriginAnnotationsProvider`
    - `OriginDefaultsPreparer`
    - `OriginDefaultsProvider`
    - `PreBarrelManifest`
    - `PreloadOwner`
    - `RampDecl`
    - `RegenCodegenOptions`
    - `RegistryCodegenResult`
    - `RegistryComposition`
    - `RegistryGenContext`
    - `ReorderableSlotEntry`
    - `ServerContributionKindDecl`
    - `WatchedSlotHit`
  - Exports (values):
    - `assertSlotsDeclared`
    - `barrelStubsPath`
    - `baseExclusionServerBarrels`
    - `buildBarrelFreeTree`
    - `buildEnrichedTree`
    - `buildRegistryGenContext`
    - `collectAllPlugins`
    - `collectBareSpecifiers`
    - `collectDataViews`
    - `collectedDirNamedCompositionRegistryPath`
    - `collectedDirRegistryPath`
    - `collectEntriesWithDeps`
    - `collectExemptableRuleIds`
    - `collectFieldEagerBarrels`
    - `collectIconManifest`
    - `collectImportGraph`
    - `collectTokenGroupVars`
    - `committedRegistryBundle`
    - `companionManifestPath`
    - `compositionFilteredRegistries`
    - `compositionRegistryFileName`
    - `compositionRegistryPath`
    - `compositionRegistryRedirects`
    - `computeEagerTier`
    - `customUtilitiesManifestPath`
    - `dataViewsManifestPath`
    - `declareSlotsFromBarrels`
    - `deriveBrowserHostGraph`
    - `discoverBrowserHosts`
    - `discoverCollectedDirs`
    - `discoverCollectedDirsIn`
    - `eagerTierManifestPath`
    - `EXEMPT_RULE_IDS_REL_PATH`
    - `exemptRuleIdsPath`
    - `extractRuntimeImportSpecifiers`
    - `fieldsEagerManifestPath`
    - `fileConfigProxy`
    - `formatGenerated`
    - `generateBarrelStubs`
    - `generateBrowserHosts`
    - `generateCompositionRegistry`
    - `generateConfigOrigins`
    - `generateCustomUtilities`
    - `generateDataViews`
    - `generateEagerTier`
    - `generateExemptRuleIds`
    - `generateFieldsEager`
    - `generatePluginDocs`
    - `generatePluginRegistry`
    - `generateReorderableSlots`
    - `generateSpaceRamp`
    - `generateTokenGroupVars`
    - `hostServicesByName`
    - `iconManifestPath`
    - `inferBrowserHostGraph`
    - `isAppContent`
    - `listNamedCompositionRegistries`
    - `listReviewMarkedOverrides`
    - `loadConfigDescriptorsByOriginPath`
    - `mainBundle`
    - `mainComposition`
    - `parseCustomUtilities`
    - `parseHostServiceDeclarations`
    - `parseNamedCompositionRegistryFileName`
    - `parseServerContributionDeclarations`
    - `parseSpaceRamp`
    - `pluginClaudeMdPath`
    - `pluginCompactDocPath`
    - `pluginDetailsDocPath`
    - `pluginReferenceMdPath`
    - `postWebManifests`
    - `preBarrelManifests`
    - `propagateConfigToUser`
    - `providedServiceNames`
    - `readCompositionManifestsFromDisk`
    - `readDeclaredApps`
    - `readDefineApp`
    - `readEffectiveConfigFromDisk`
    - `readGitLayerConfig`
    - `regenerateManifestCodegen`
    - `regenerateRegistryCodegen`
    - `renderBarrelStubs`
    - `renderBrowserHost`
    - `renderBrowserHostScope`
    - `renderCollectedDirRegistry`
    - `renderCompactDoc`
    - `renderCompanionManifest`
    - `renderConfigOriginContent`
    - `renderCustomUtilities`
    - `renderDataViewsManifest`
    - `renderDetailsDoc`
    - `renderEagerTierManifest`
    - `renderEmptyCollectedDirRegistry`
    - `renderExemptRuleIds`
    - `renderFieldsEagerManifest`
    - `renderIconManifest`
    - `renderPluginClaudeMd`
    - `renderPluginReferenceMd`
    - `renderReorderableSlotsManifest`
    - `renderSpaceRamp`
    - `renderThemeDeclarationsManifest`
    - `renderTokenGroupVarsManifest`
    - `reorderableSlotsManifestPath`
    - `resolveHostConfigCoverage`
    - `resolveHostContributionCoverage`
    - `resolveImportSpecifier`
    - `resolveMainComposition`
    - `resolveOriginAnnotations`
    - `resolveOriginDefaults`
    - `resolveRegistryHome`
    - `seedAuthoredOverrides`
    - `serverBarrelBlockers`
    - `setDefaultOriginAnnotations`
    - `setDefaultOriginAnnotationsPreparer`
    - `setDefaultOriginDefaults`
    - `setDefaultOriginDefaultsPreparer`
    - `spaceRampManifestPath`
    - `standardPluginDirs`
    - `standardPluginDirsFromSnapshot`
    - `standardPluginDirsIn`
    - `themeDeclarationsManifestPath`
    - `tokenGroupVarsManifestPath`
    - `withPackageName`
    - `writeGenerated`
    - `writePreBarrelManifest`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/density --control-height-xs`
    - `ui/tokens/density --pad-card`
    - `ui/tokens/density --pad-chip-x`
    - `ui/tokens/density --pad-chip-y`
    - `ui/tokens/density --pad-row-x`
    - `ui/tokens/density --pad-row-y`
    - `ui/tokens/shadow --shadow`
- Exemptions:
  - Exempts itself from:
    - `boundaries/no-platform-api` — `core/app-css-utilities.ts`, `core/authored-override-seed.ts`, `core/barrel-free-tree.ts`, `core/barrel-stubs-gen.ts`, `core/companion-manifest-gen.ts`, `core/config-origin-gen.ts`, `core/custom-utilities-gen.ts`, `core/data-views-gen.ts`, `core/declared-apps.ts`, `core/docgen.ts`, `core/eager-tier-gen.ts`, `core/enriched-tree.ts`, `core/exempt-rule-ids-gen.ts`, `core/fields-eager-gen.ts`, `core/git-layer-config.ts`, `core/icon-manifest-gen.ts`, `core/import-graph.ts`, `core/override-legend-stamp.ts`, `core/package-names.ts`, `core/plugin-registry-gen.ts`, `core/pre-barrel-guard.ts`, `core/reorderable-slots-gen.ts`, `core/slot-declaration-guard.ts`, `core/space-ramp-gen.ts`, `core/test-helpers-doc.ts`, `core/theme-declarations-gen.ts`, `core/token-group-vars-gen.ts`, `core/write-generated.ts` (debt)
    - `marker-scan-safety/no-adhoc-marker-scan` — `core/browser-host-coverage.ts` (sanctioned)

<!-- AUTOGENERATED:END -->
