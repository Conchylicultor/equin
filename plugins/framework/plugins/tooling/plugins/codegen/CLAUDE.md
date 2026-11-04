# codegen

Build-time generators run by `./equin build`: the plugin registries, the
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
bundle's portable server barrels, the portable barrels `bin/browser-host.ts`
loads, and — to a fixpoint — the portable host provider (`EdgeGraph.hostProviders`:
a plugin whose `server/index.ts` provides a host service, which no composition
bundles) providing each host service the graph's code declares
(`core/host-services.ts`, the text parsers in `parse-utils`; exactly one, else
it throws naming the service and candidates). Negatives are never flipped, so
a negated plugin (`review/plugin-changes`) stays out. Every
server barrel the graph's code reaches must be in it, or it throws with the
import chain — the worker's boot assert, moved to build. Reach is measured by
`importClosures` (`tooling/import-closure`): ONE union `Bun.build` for the
entry, then one per fixpoint round over only the members no earlier closure
reached — an import chain is computed only when reporting a failure. Emitted as
`bin/browser-host.generated.ts` (`hostEntries`, `hostProviders`), held by
`plugins-registry-in-sync`; the rule is pinned by `core/browser-host-gen.test.ts`.

**Portability is derived, never declared.** "Portable" is
`serverPortabilityOf(repo)` (`boundaries/core/portability.ts`): a server
barrel whose static closure loads no module that imports a platform API, uses
a host-only value, or declares a host service no portable `server/` barrel
provides — one union closure over every server barrel (the module graph's
bundler view; each module's facts a file record), shared per snapshot
(`resolveHostGraph` takes it as its `portability` input, so a test injects
it). There is no per-plugin flag and no opt-out: a plugin joins or leaves the
worker when its closure changes, which shows up as a diff of the committed
`bin/browser-host.generated.ts` in the same change. A barrel portable by its
imports but desktop by meaning moves its desktop part to `machine/`, or its
composition leaves it out.

Derived once per snapshot: `inferBrowserHostGraph` / `deriveBrowserHostGraph`
are memoized on the `RegistryGenContext` (`browserHostGraphs`), so its four
callers (the generator, `plugins-registry-in-sync`,
`browser-host:contributions-covered`, `config-v2:registrations-paired`) holding
one ctx — a check run's file set yields one — pay one derivation. The coverage
guard's file reading is memoized there too (`sourceScans`, see below). The
generator reports each host as three build-profiler spans
(`browserHostInfer:<host>`, `browserHostCoverage:<host>`,
`browserHostWrite:<host>`); `scripts/measure-browser-host-guard.ts` times the
derivation the way build and a check pass pay for it.

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
fetcher (`useFetchEndpoint`, a `FetchEndpoint`, `useEndpointMutation`) — a module is the page's or the scope's, never both.

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
  routes, or a core-owned one: the resource runtime's own
  (`RESOURCE_HTTP_ROUTE`) or central's (`CENTRAL_RESOURCE_HTTP_ROUTE`, mounted
  by central-core's boot, not a barrel — the one route no `httpRoutes` holds;
  its live-state URL is only built for a central read, which this guard
  already requires `needsMachine`) — whether
  another barrel routes it or none does. A route is read only from a barrel's
  `httpRoutes` object: every key must be `[decl.route]` (a `defineEndpoint`
  with a literal `route:`) or a `"METHOD /path"` literal, and any other key
  (a constant, a template with a substitution, a spread) THROWS naming the
  barrel and the key — a route the scan cannot read is never silently
  dropped. A raw route is still a declaration: `rawEndpointHandler` /
  `machineHandler` wrap its handler, and its consumers build an `AssetPath` /
  `AssetBase` from it (`infra/endpoints`).
- **Config** — the arm that needs the barrels' contributions
  (`resolveHostConfigCoverage`) cannot run in this barrel-free phase; it runs
  in `config-v2:registrations-paired` over `collectConfigRegistrations`. No
  `needsMachine` escape.
- **Contributions** (`resolveHostContributionCoverage`, run by this plugin's
  `browser-host:contributions-covered` check, which imports the barrels): a
  scoped web plugin whose `server/` barrel the host does not boot must not
  contribute to a kind a graph member declares — the member would answer the
  scope without it (a task category's label, a list's exposed column). The
  declaring plugin of each kind is read statically (parse-utils'
  `parseServerContributionDeclarations` over every `defineServerContribution`
  call — the same reading the contributions facet takes server companion
  kinds from); a kind declared `absentOnHost: { reason }` (`Trigger`, `ReportKind`:
  its contributor's own reaction or bookkeeping, read by nothing a host
  serves) is not this arm's, nor is a host service's provider. Cleared by
  making the barrel portable or moving the contribution into a portable
  `server/` half. No exemption.

Each failure names the key or route, the declaration's file, up to three
readers (file:line), every plugin in the repo serving it and why that one is
outside the graph: desktop-only `machine/`, central, not in the composition,
or not portable — with the modules of its closure that need the computer and
the import chain to each (`serverBarrelBlockers`, over `serverPortabilityOf`'s
`offenders`; never empty). The reads it
found are emitted as `hostReads` in the page side's
`core/browser-host.generated.ts`; the owner's boot test holds the booted
graph's `Resource.Declare` set to them. Pinned by
`core/browser-host-coverage.test.ts`.

The reading is one `SourceScans` per snapshot (`createSourceScans`, held on
the ctx as `sourceScans()`): each file is read once and masked at most once
(`maskSource`), every later reading — imports, declared descriptors,
endpoints, register calls — reuses that mask (the parse-utils and
resource-vocabulary scanners take the caller's `masked`), and the repo-wide
facts (the serving wrappers, every backend barrel's routes, each plugin's
descriptor index) are derived once and shared by every host. A repo-wide pass
text-filters before it masks: a backend file naming no register marker and no
wrapper (or a barrel not mentioning `httpRoutes`) is never parsed.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Plugin doc generation and registry codegen
- Core:
  - Uses: 134 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `plugin-meta/parse-utils` ×20
    - `config_v2` ×16
    - `framework/plugin-id` ×15
    - `network/live/resource-vocabulary` ×10
    - `plugin-meta/plugin-records` ×10
    - `framework/slot-declaration` ×6
    - `packages/timed-fs` ×6
    - `plugin-meta/barrel-import` ×6
    - `plugin-meta/closure` ×5
    - `plugin-meta/composition` ×5
    - `plugin-meta/facets` ×5
    - `infra/host-fs/user-path` ×4
    - `plugin-meta/plugin-tree` ×4
    - `config_v2/ledger` ×2
    - `framework/tooling/boundaries` ×2
    - `framework/tooling/format` ×2
    - `network/live/resource-protocol` ×2
    - `fields/reorder-tree.REORDER_NODE_LEGEND`
    - `framework/tooling/guards/agent-policy.agentPolicySettings`
    - `framework/tooling/lint.loadLintContributions`
    - `framework/tooling/web-artifacts.COMPOSITION_SPECIFIERS`
    - `framework/tooling.loadRepoSnapshot`
    - `infra/namespace.MAIN_COMPOSITION_ID`
    - `packages/macrotask-yield.yieldMacrotask`
    - `packages/semaphore.createSemaphore`
    - `plugin-meta/facets/contributions.contributionsFacetDef`
    - `plugin-meta/facets/exemptions.exemptionsFacetDef`
    - `plugin-meta/facets/slots.slotsFacetDef`
    - `primitives/css/ui-kit.APP_STYLESHEET_PATH`
    - `ui/icons/icon-sets.renderSymbolNameFiles`
    - `ui/icons.isIconRefModule`
  - Exports (types):
    - `AuthoredOverrideSeedResult`
    - `BarrelEvaluation`
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
    - `WatchedSlotHit`
    - `WebSlotContribution`
  - Exports (values):
    - `appDeclarationsManifestPath`
    - `assertSlotsDeclared`
    - `barrelStubsPath`
    - `buildBarrelFreeTree`
    - `buildEnrichedTree`
    - `buildRegistryGenContext`
    - `CLAUDE_SETTINGS_REL_PATH`
    - `claudeSettingsPath`
    - `collectAllPlugins`
    - `collectBareSpecifiers`
    - `collectDataViews`
    - `collectedDirNamedCompositionRegistryPath`
    - `collectedDirRegistryPath`
    - `collectEntriesWithDeps`
    - `collectExemptRuleIds`
    - `collectFieldEagerBarrels`
    - `collectIconManifest`
    - `collectImportGraph`
    - `collectTokenGroups`
    - `collectTokenGroupVars`
    - `collectWebSlotContributions`
    - `COLOR_TOKEN_REF_GROUPS`
    - `colorTokenRefPath`
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
    - `evaluateAllBarrels`
    - `evaluateWebBarrels`
    - `EXEMPT_RULE_IDS_REL_PATH`
    - `exemptRuleIdsPath`
    - `extractRuntimeImportSpecifiers`
    - `fieldsEagerManifestPath`
    - `fileConfigProxy`
    - `formatGenerated`
    - `generateBarrelStubs`
    - `generateBrowserHosts`
    - `generateClaudeSettings`
    - `generateColorTokenRef`
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
    - `iconManifestPath`
    - `inferBrowserHostGraph`
    - `isAppContent`
    - `listNamedCompositionRegistries`
    - `listReviewMarkedOverrides`
    - `loadConfigDescriptorsByOriginPath`
    - `mainBundle`
    - `mainComposition`
    - `parseCustomUtilities`
    - `parseNamedCompositionRegistryFileName`
    - `parseSpaceRamp`
    - `pluginClaudeMdPath`
    - `pluginCompactDocPath`
    - `pluginDetailsDocPath`
    - `pluginReferenceMdPath`
    - `postWebManifests`
    - `preBarrelManifests`
    - `propagateConfigToUser`
    - `readCompositionManifestsFromDisk`
    - `readDeclaredApps`
    - `readDefineApp`
    - `readEffectiveConfigFromDisk`
    - `readGitLayerConfig`
    - `recordSlotNaming`
    - `regenerateManifestCodegen`
    - `regenerateRegistryCodegen`
    - `renderAppDeclarationsManifest`
    - `renderBarrelStubs`
    - `renderBrowserHost`
    - `renderBrowserHostScope`
    - `renderClaudeSettings`
    - `renderCollectedDirRegistry`
    - `renderColorTokenRef`
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
  - Uses tokens: `ui/tokens/shadow --shadow`
- Exemptions:
  - Exempts itself from:
    - `boundaries/no-platform-api` — `core/authored-override-seed.ts`, `core/barrel-stubs-gen.ts`, `core/claude-settings-gen.ts`, `core/config-origin-gen.ts`, `core/custom-utilities-gen.ts`, `core/data-views-gen.ts`, `core/declared-apps.ts`, `core/docgen.ts`, `core/evaluated-barrels.ts`, `core/fields-eager-gen.ts`, `core/file-scans.ts`, `core/git-layer-config.ts`, `core/icon-manifest-gen.ts`, `core/import-graph.ts`, `core/override-legend-stamp.ts`, `core/package-names.ts`, `core/plugin-registry-gen.ts`, `core/pre-barrel-guard.ts`, `core/slot-declaration-guard.ts`, `core/space-ramp-gen.ts`, `core/test-helpers-doc.ts`, `core/write-generated.ts` (debt)
    - `marker-scan-safety/no-adhoc-marker-scan` — `core/browser-host-coverage.ts` (sanctioned)
    - `user-path/no-unproven-claim` — `core/test-helpers-doc.ts` (sanctioned)

<!-- AUTOGENERATED:END -->
