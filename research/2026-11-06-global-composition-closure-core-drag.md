# Composition closure: the cost of per-plugin granularity ("core drag")

> **Verdict (2026-11-15, statuses re-checked 2026-11-19): stop the redesign.** Neither A nor B′ is
> built: R1's module-level web loading (c8effcf12c) already removed most of the web cost, and
> equin.ai is the only deployed non-main composition, where the gain is <1% of download.
> Follow-ups kept:
> 1. An unserved live value names the value and its provider plugin. **Open**: browser hosts
>    refuse `unserved` naming the key, but not the provider (857c262733); the desktop server
>    still answers `unknown-key`, which reads as skew (a reload prompt) unless the verdict is
>    `same-build`.
> 2. A missing endpoint names itself and its provider. **Open**: the desktop server's router
>    still answers a plain `404 Not found` (`http-router` default). Browser hosts answer
>    `409 unsupported {method, path}` but don't name a provider.
> 3. Cheap splits: `debug.timeline` report parser (−19 in agent-manager) and `reports.crash`'s
>    `crashFingerprint` (−20 in jobs-events) are **open**, edges unchanged. `color-picker`'s
>    `Color` is still imported by `app-icon/core`, but now drags only 2 plugins, so it isn't
>    worth splitting.

Status: **design for review** — two complete designs to compare: **option A**
(targeted splits + a light-drag guard) and **design B′** (contract-aware
closure). Nothing implemented beyond the measurement scripts.
Task: task-1793986418-41ltj8. Follow-up of D9 (host-aware closures, 64b9906a4b).

## Context

D9 made the closure follow every import a host runs, including the cross-runtime
ones that used to be invisible (`web/` → `x/core`, `server/` → `x/core`,
`machine/` → `x/server`). Every desktop composition but main grew 15–25%
(agent-manager 888 → 982, studio 454 → 552, diagnostics 353 → 518, website
330 → 394). The closure is per PLUGIN: importing B's `core/` ships B's `web/`,
`server/`, `machine/` too. D9 hand-split four plugins
(`fields/reorder-tree/config/renderer`, `infra/launcher/runtime-env`,
`stats/cost/format`, `debug/slow-ops/sink`). Question: keep splitting by hand
(A), make the closure barrel-granular (B), or make it contract-aware (B′:
a light import ships only the barrel, plus the provider half of a contract it
binds)? A and B′ are both designed in full below, then compared side by side.

## Measurement

Script (reusable, the basis of the guard below):

```
./equin run plugins/plugin-meta/plugins/closure/scripts/measure-core-drag.ts \
  [--composition <id>,…] [--top N] [--edges N] [--dist-links <file>] [--json <out>]
```

For every composition (packs, main, base-exclusions skipped) under each declared
host, it re-derives today's closure over `(plugin, folder)` nodes from the
cross-refs facet (and **asserts it equals `resolveComposition`'s bundle**, so the
counterfactuals share its semantics), then computes:

| mode | a light-barrel import (`core/`, `data-dirs/`, `deps/`) ships… |
|---|---|
| **plugin** | the whole plugin (today) |
| **barrel** | only that barrel (`core/` imports only `core/`, so its closure is pure core). Naive option B. |
| **contract** | barrel, but an import binding a **contract** — `export const X = <factory>(` with factory ∈ endpoint, live value/collection/arm, app, route, config, id kind, field type, block, hint, capability, mandate, tag tree, entity ref, sink, token group, … — or an unnamed import ships the whole plugin. **Sound option B** (a lower bound: a function wrapping a contract still reads as a value). |
| **nav** | contract, but `defineApp` / `defineRoute` refs ship light (cross-app links optional) |
| **folder** | every barrel separately (`x/web` ships x's web + own core/shared, not its server). The floor. |

"Runtime" = the plugin ships one of its `web/ server/ machine/ central/` halves
(what registers slots, endpoints, jobs). Bytes: web = emitted JS/CSS of each
`web`/`core` artifact in the newest full-fleet dist (the web-artifacts cache's `dist-links/`);
backend = `.ts/.tsx` source of the backend folders (tests excluded). Run at
890e97bc5c.

### Headline: runtime-bearing plugins per composition (desktop)

| composition | present today | runtime today | naive barrel | **sound (contract)** | nav-soft | folder floor | web KB today → sound | backend src KB today → sound |
|---|---|---|---|---|---|---|---|---|
| agent-manager | 988 | 880 | 837 (−5%) | **847 (−4%)** | 843 | 827 | 11684 → 11359 (−2.8%) | 15267 → 14332 (−6%) |
| agent-manager-lean | 961 | 853 | 810 | **820 (−4%)** | 816 | 800 | 11460 → 11157 | 15061 → 14120 |
| home | 511 | 442 | 382 | **418 (−5%)** | 414 | 316 | 5694 → 5618 (−1.3%) | 9458 → 9392 |
| pages | 543 | 471 | 411 | **447 (−5%)** | 444 | 360 | 6233 → 6203 | 10649 → 10582 |
| settings | 413 | 355 | 294 | **328 (−8%)** | 327 | 263 | 4934 → 4887 | 8245 → 8152 |
| studio | 556 | 474 | 403 | **443 (−7%)** | 440 | 332 | 5884 → 5829 (−0.9%) | 10494 → 10269 |
| sonata | 483 | 417 | 364 | **393 (−6%)** | 391 | 358 | 5635 → 5600 | 8704 → 8675 |
| debug | 364 | 315 | 267 | **293 (−7%)** | 292 | 248 | 4463 → 4434 | 7050 → 7030 |
| deploy | 566 | 481 | 407 | **450 (−6%)** | 440 | 362 | 6239 → 6165 | 10974 → 10749 |
| file-explorer | 422 | 364 | 308 | **337 (−7%)** | 335 | 286 | 4988 → 4938 | 8267 → 8192 |
| website | 399 | 347 | 294 | **322 (−7%)** | 319 | 271 | 5246 → 5170 (−1.4%) | 7317 → 7276 |
| conversations | 775 | 676 | 580 | **622 (−8%)** | 617 | 563 | 8413 → 8067 | 14044 → 13081 |
| agent-runtime | 803 | 700 | 608 | **647 (−8%)** | 643 | 591 | 8770 → 8424 | 14354 → 13406 |
| page-editor | 598 | 519 | 448 | **493 (−5%)** | 482 | 403 | 8467 → 8434 | 11460 → 11390 |
| mcp | 498 | 423 | 359 | **392 (−7%)** | 389 | 304 | 5466 → 5372 | 10170 → 9889 |
| diagnostics | 542 | 460 | 368 (−20%) | **421 (−8%)** | 416 | 265 | 6312 → 6102 (−3.3%) | 11630 → 10732 (−8%) |
| root-features | 516 | 443 | 377 | **418 (−6%)** | 415 | 319 | 6125 → 6030 | 10464 → 10326 |

(Subsystem lenses — data, jobs-events, live-state, auth, search, history,
fields, design-system, served-baseline, reporters — follow the same pattern:
naive −14…−17%, sound −2…−8%. agent-manager-demo/browser: 941 → 929.
promo-film is `**`: unchanged.) Full output: run the script.

### What the numbers say

1. **Naive B looks like −10…−20% runtime plugins, but half of it is unsound.**
   The gap between *barrel* and *contract* is imports of contracts: `pluginTree`
   (a live value served by plugin-view's server), `settingsApp` (an app),
   `serveCompositionEndpoint`, `releaseRuns`, `compositionDetailRoute`… Today
   the per-plugin closure is what makes "a descriptor in `core/` ⇒ the half that
   serves it ships" true by construction. Drop that and those reads fail at
   runtime.
2. **Even "pure" imports hide runtime couplings** the script cannot see:
   - `infra/runtime-profiler/core`'s `runTracked` works only once
     `runtime-profiler/server` has run `import "./internal/install"` (a
     load-bearing module side effect) — 51 importers, all "pure" by symbol.
   - `fields.text.config`'s `textField` (a plain function) builds a config
     field whose editor is registered by `fields.text.config/web`; a config
     using it renders in Settings only if that half ships.
   Rules guarantee `core/` *imports* only `core/`; nothing guarantees `core/`
   *works* without its plugin's runtime halves. B would need every such
   coupling made explicit first.
3. **The sound gain is small, and mostly free already.** −4…−8% runtime
   plugins, **−1…−3% web bytes**, −1…−8% backend source. Of ~110 light-only
   targets, ~90 cost exactly 1 plugin (themselves), and most of those runtime
   halves are presence-only barrels (`infra/spawn/server`, `infra/file-sink/server`,
   `primitives/report-sink/web`: a description and no contributions) — about
   zero bytes.
4. **The cost that matters is concentrated in a handful of edges** (below):
   one split (`debug.timeline`) is 21 of agent-manager's 33 sound plugins.
5. The D9 growth is mostly genuine: even the folder floor keeps agent-manager
   at 827 runtime plugins.

### Top drag edges

Ranked by the worst single composition: runtime plugins today's closure sheds
if ONLY this target's light imports shipped light. `*` = contract symbol.

| # | target (light barrel) | worst / Σ | importing file → symbols | kind |
|---|---|---|---|---|
| 1 | `debug.timeline` core | 22 (agent-manager 21, conversations 22, agent-runtime 22) / 86 | `conversations/…/tool-call/plugins/timeline/web/components/timeline-tool-view.tsx` → `readTimelineReport, TimelineReport, TimelineReportEvent` | pure |
| 2 | `debug.read-set` core | 18 (diagnostics) | `debug/live-state-churn/emit/web/components/emit-pane.tsx` → `resourcesDebug*` | contract |
| 3 | `debug.sentinel.machine-usage` core | 11 (diagnostics) | `debug/health-monitor/{web/components/health-monitor-panel.tsx, server/internal/read-health-files.ts, core/schema.ts}` → `MACHINE_USAGE_BUCKETS…, OwnerSampleSchema` | pure |
| 4 | `release` core | 7 (studio) | `apps/studio/compositions/release/**/web` → `RELEASE_* consts, releaseRuns*, releaseHistory*, triggerReleaseEndpoint*` | contract |
| 5 | `plugin-meta.plugin-view` core | 6 (settings) / 39 in 11 compositions | `config_v2/settings/web/{internal/prune-config-tree.ts, components/config-nav.tsx}` → `pluginTree*, PluginNode` | contract |
| 6 | `apps.studio.compositions` core | 6 (deploy) | `apps/deploy/composition/web/components/composition-section.tsx` → `compositionDetailRoute*` | route |
| 7 | `debug.browser-recordings` core + data-dirs | 5 (mcp) | `infra/mcp/browser/server/internal/{tools.ts, record-call.ts}` → `RECORDED_BROWSER_TOOLS, browserRecordingsDir` | pure |
| 8 | `apps.settings.shell` core | 4 / 32 in 22 compositions | `ui/theme-engine/theme-customizer/web/panes.tsx`, `config_v2/settings/web/internal/panes.tsx`, `auth/web/panes.tsx` → `settingsApp*` | app ref |
| 9 | `infra.launcher` data-dirs | 4 (conversations, agent-runtime) / 14 | `conversations/runtime-sdk/machine/internal/paths.ts` → `socketsDir` | pure |
| 10 | `build` core | 4 (studio, deploy) | `build/serve-composition/web/internal/use-serve-composition.ts` → `serveCompositionEndpoint*` | contract |

Next: `conversations.conversation-view.drop-and-exit` 4 (`dropAndExit*`,
contract), `conversations.model-provider` 3 ×4 (`tasks-core/core` →
`FALLBACK_MODEL, ModelChoiceSchema, StoredModelSchema`, pure),
`reports.render-loop` 3 (website: `ANIMATION_HOST`, pure),
`plugin-meta.exhibits` 3 (`loadExhibits`, pure),
`conversations.conversation-view.code` 2 ×11 (`code-api/core` → `EditedFileSchema`, pure).

## Options

### A. Targeted splits + a guard

Split the pure values a heavy plugin's `core/` exports into a core-only leaf
sub-plugin (the D9 pattern), and add a check so the next import cannot
silently re-create a drag. Seven pure splits at threshold 3 (rows 1, 3, 7, 9 +
model-provider, render-loop, exhibits) recover ~all of the *sound* gain for
the compositions that matter (agent-manager 880 → ~856; conversations,
agent-runtime −26; diagnostics −11; mcp −5; website −3).

### B. Barrel/folder-granular closure

What it would change, concretely:

- **Closure engine**: nodes become `(plugin, barrel)`; `hardForward` keyed by
  the target barrel (`ApiUse.barrel` already carries it); membership gains a
  "light" state; `explainInclusion` / `impactOf*` / `removalClosure` per
  barrel; negatives must still remove whole plugins.
- **Registry codegen**: `{web,server,central}.generated.ts` per composition
  filter by the *runtime* set, not the present set (`collectEntriesWithDeps`,
  `plugin-registry-gen.ts:548`). A light plugin contributes no slot, endpoint,
  job, config registration, id-kind registration, migration.
- **Loading**: nearly free. Web artifacts are already per barrel
  (`web-artifacts`: each imported folder barrel is its own content-addressed
  artifact in the import map), and Bun resolves `core/` from source — a light
  plugin rides module resolution with no loader change.
- **Studio**: membership tint/legend for "light", the Desktop/Browser toggle
  × barrel, inclusion steps naming the barrel.
- **Boundary rules**: unchanged (`core` → `core` only already makes the light
  closure pure core). What is missing is a *semantic* rule, see hard cases.

Hard cases (each a way B silently breaks a composition):

1. **Contracts in `core/`**: ~800 `export const X = <contract factory>(` across
   the repo (248 endpoints, 148 live values, 112 live collections, 43 id kinds,
   32 routes, 31 field types, 28 configs, 20 apps, …). An import of one is a
   dependency on the half that serves/registers it. B needs the facet to
   classify every export (contract vs value) and the engine to map contract →
   serving half.
2. **Runtime halves that make `core/` work** (runtime-profiler's install side
   effect; config-field kinds whose editors live in `web/`). Invisible to any
   symbol classification; each must become an explicit edge (a companion, a
   host service) before B is safe.
3. **Cross-app refs** (`settingsApp`, `agentManagerApp`, routes): either a
   real dependency (link must work) or optional navigation — a product
   decision B forces per call site.

Gain once all of that is built: the *contract* column — −4…−8% plugins,
−1…−3% web bytes. Most of it comes from the same handful of edges A splits.

### Option A in full: splits + the light-drag guard

Split by hand, and make the guard *derive* its finding from the graph rather
than from a list, so it is the structural piece (Coding Style rung 3 — a
cross-file invariant a type cannot see). The closure stays per plugin, which
keeps "descriptor ⇒ its serving half ships" true for free.

- **The guard** — check `composition-closure:light-drag` (beside
  `composition-closure` in `plugins/framework/plugins/tooling/plugins/checks/plugins/composition-closure/check/`,
  reusing `buildRegistryGenContext`'s tree + graph):
  - For each composition (non-main, non-pack, each declared host), for each
    plugin T reached through a light barrel by imports binding **only
    non-contract** symbols, compute *alone(T)* = runtime plugins the closure
    sheds if T's light imports shipped light (the script's `barrelFor`).
  - **Fail when alone(T) ≥ 3** in any composition. Threshold: 90 of ~110
    targets cost exactly 1 (the target's own, mostly presence-only, half);
    ≥ 3 is the tail that drags *others* in — 7 pure targets today.
  - Message: composition, host, T, the importing files + symbols, the count,
    and the fix ("move these values into a core-only leaf under T — the
    `fields/reorder-tree/config` pattern").
  - Not bypassable by the next import: it is recomputed from every import in
    the graph; a new importer of the same heavy `core/` re-trips it. The only
    way out is the exempt manifest (`kind: "debt"` + task) in T's
    `exempt/index.ts`.
  - Contract-bound drags (rows 2, 4, 5, 6, 8, 10) are listed as information,
    not failures: they are real runtime dependencies, each a design question.
- **Contract classification is facet data**, not a disk read in the check:
  the cross-refs facet records, per light-barrel export, the factory its
  `export const` calls, and resolves `ApiUse.contract` in `relate()`. The
  factory set lives as data next to it; a factory missing from the set
  under-classifies (reads as a value), which makes the guard fail loudly on a
  false drag — the safe direction. This is also the first brick B would need.

### Option A — tasks

Independently landable; order matters only where stated.

1. **Measurement script** — this branch: `plugins/plugin-meta/plugins/closure/scripts/measure-core-drag.ts` + this doc.
2. **Pure splits** (each its own task, any order, no dependencies; each moves
   the named values into a core-only leaf and repoints importers):
   - 2a `debug/timeline` → leaf for `readTimelineReport` + report types (−21 agent-manager).
   - 2b `debug/sentinel/machine-usage` → leaf for buckets + `OwnerSampleSchema` (−11 diagnostics).
   - 2c `debug/browser-recordings` → leaf for the recording format + `browserRecordingsDir` (−5 mcp).
   - 2d `infra/launcher` → `socketsDir` out of its `data-dirs` into a leaf (−3/−4 agent-manager, conversations, agent-runtime).
   - 2e `conversations/model-provider` → leaf for `FALLBACK_MODEL` + model schemas (−3 ×4).
   - 2f `reports/render-loop` (`ANIMATION_HOST`), `plugin-meta/exhibits` (`loadExhibits`) — small, one task.
3. **Contract kind in the cross-refs facet** — `ApiUse.contract` (or the
   export's factory) resolved in `relate()`, factory set as data; facet tests.
   No closure behaviour change.
4. **`composition-closure:light-drag` check** — depends on 3; lands green
   after 2 (or with debt exemptions for any split not landed yet). Move the
   script's closure-over-folders into `closure/core` as a pure function
   (`lightDrag(graph, tree, manifest, host)`) shared by the check and the script.
5. **Contract drags — design questions for the user** (no code until decided):
   - 5a `config_v2/settings` reads the whole `plugin-view.tree` live value only
     to prune its nav (`prune-config-tree.ts`): serve the pruned shape from
     config_v2 itself? (−6 settings, 11 compositions.)
   - 5b Cross-app refs (`settingsApp` in 22 compositions, `agentManagerApp`,
     `compositionDetailRoute`, prototypes): make cross-app navigation optional
     — a link to an app outside the composition is a typed absent state, the
     ref read from the composition's declared apps. Measured gain small
     (nav column: ≤10 plugins), so only if wanted for its own sake.
   - 5c `debug.live-state-churn.emit` → `resourcesDebug` (18 in diagnostics):
     is the emit pane meant to depend on read-set's server?
6. **Docs** — closure `CLAUDE.md` ("The closure stays per PLUGIN…") points at
   the guard and this doc; the D9 track page gets a one-line status.

## Design B′: contract-aware closure

Every plugin stays whole on disk. An import of another plugin's light barrel
(`core/`, `data-dirs/`, `deps/`) brings only that barrel — **unless the
symbol it binds is a contract**, in which case it also brings the half of the
owner that provides the contract (and that half's own closure). Never the
whole plugin through a light import. Hidden couplings are made expressible
first, so the rule has nothing to miss; a contract whose provider is missing
fails loudly at runtime.

Measured with the script's `CONTRACT_HALF` mode (symbol-level: the factory of
the bound export, a wrapper's fixpoint, coupled plugins as their fixes would
declare them).

### 1. The contract factory list

Counts: `export const X = <factory>(` in every light barrel ("exports"), and
the distinct symbols other plugins import through a light barrel
("imported"). Provider class is the design's data; "owner folders naming it"
is what the tree does today (the script derives each contract's actual
provider folders from it — a live value served only from `machine/` ships
`machine/`, not `server/`).

| factory | exports | imported | provider class | owner folders naming it today |
|---|---|---|---|---|
| `defineEndpoint` | 248 | 93 | backend (server / machine / central) | server 95, web+server 73, web+machine 28, machine 27, machine+central 6 |
| `liveValue` | 148 | 74 | backend | web+server 51, server 35, web+machine 31, machine 19, none 7 |
| `liveCollection` | 112 | 56 | backend | server 61, web+server 42, … |
| `liveArm` | 4 | — | backend | web+server 4 |
| `entityRef` / `tagTreeEntityRef` | 68 / 2 | 17 | backend (the table's owner) | server 62, … |
| `defineExtensionShape` | 25 | 4 | backend | server 14, web+server 9 |
| `defineCapability` / `defineMandate` | 10 / 2 | 10 / 2 | backend (mandate resolution) | none 10 (leaf capability plugins, D9) / server 2 |
| `defineReportSink` / `defineRequestSink` / `defineObservationSink` | 1 / 2 / 2 | 1 / 2 / 2 | backend (the handler) | none (handled by another plugin) |
| `defineSourceSet` / `defineDeploySecret` | 1 / 1 | 1 / — | backend | — |
| `defineHostService` | 1 in core (the rest are declared in `server/`, reached through a runtime barrel already) | — | backend | — |
| `defineApp` | 20 | 17 | page (web) | web 20 |
| `defineRoute` | 32 | 19 | page | web 19, none 10 |
| `defineFieldIdentity` | 35 | — | page | web 35 |
| `defineTokenGroup` | 19 | 18 | page | web 19 (also a token edge today) |
| `defineHint` / `defineHintAnchor` / `defineHintSignal` | 7 / 12 / 1 | — / 8 / 1 | page | web |
| `defineIconFamily` / `defineVariantRegion` / `defineInlineTokenNode` | 3 / 3 / 7 | 2 / — / 1 | page | web (+server) |
| `defineConfig` | 28 | 10 | both (registered by web and server) | web+server 23, web+server+machine 4 |
| `defineIdKind` | 43 | 25 | both | web+server 32, … |
| `defineFieldType` | 31 | 28 | both (identity, renderers, storage) | none 31 (registered by the field's sub-plugins — see H3) |
| `defineBlock` / `defineContainerBlock` / `defineAnnotationBlock` | 25 / 2 / 5 | 6 / — / 3 | both | web+server |
| `defineLaunchOption` / `defineThreadResult` / `defineTagTree` | 5 / 3 / 2 | 2 / 1 / 2 | both | web+server |

Not contracts (plain declarations, consumed generically or at build time):
`defineDataDir` (81), `fieldsToZodObject` (43), `defineGuard` (22),
`defineCollectedDir` (16), `defineDep` (14), `defineFacet` (9), schema
helpers (`wholeList`, `cappedList`, `tolerantEnum`, …), `timedSync`/`timedAsync`.

Classification of the 2,979 distinct symbols imported cross-plugin through a
light barrel: **405 contracts** (endpoint 93, live value 74, live collection
56, field type 28, id kind 25, route 19, token group 18, app 17, entity ref
17, config 10, capability 10, …), **24 wrappers** (a function export whose body
names a contract of its own plugin — `readX()` around an endpoint), **63 in a
coupled plugin** (H1, H3 below), **2,487 plain values**, 0 unnamed.

The list is data in a leaf (`factory → provider class`); the factory set is a
**closed vocabulary**: a check fails on any `export const X = <factory>(` in
a light barrel whose factory is in neither the contract list nor the plain
list, so a new contract factory cannot default silently to "plain".

### 2. Hidden couplings — every case found

Search, systematic and repeatable:

- `scripts/find-core-couplings.ts` (new, beside the measurement): every
  `core/` module with module-level state (`let`, Map/Set/array/object stores,
  `globalThis` writes) whose exported writer — a function mutating it, an
  installer-named export (`set|register|install|provide|attach|declare|mark…`),
  or an exported store mutated in place — is called from a `web/ server/
  machine/ central/ shared/` file. 24 modules.
- `globalThis` / `window[…]` reads in `core/` and of `core/`-declared global
  names (14 files).
- Side-effect imports in runtime barrels (`import "./internal/…"`, 32).
- Dispatch slots (`defineDispatchSlot`) without `companions`, whose fallback
  renders a placeholder when the key's provider is absent (12).
- Process roots (`server-core/bin`) calling `core/` installers.

**Must fix: `core/` that works only after its own half ran (4).**

| # | case | how it breaks under B′ | fix |
|---|---|---|---|
| H1 | `infra/runtime-profiler/core` recorder (`runTracked`, `chargeWait`, … 51 importers): its span-context, suppression, background-lane and root-context runtimes, loader read-set sink, gate gauges and clock are installed by `server/internal/install.ts` (load-time side effect); the same install wires `server-core/core` `setProfilerHooks`, `packages/semaphore` `installLeaseContextRuntime`, `packages/timed-fs` `installFsAwait` | spans recorded with no context, silently | one declared host service (`ProfilerRuntime`, provided by `runtime-profiler/server`); the recorder, profiler hooks, lease scope and fs-await read it through `.use()`. A CLI/check process (no host) gets an explicit "no profiler" provider, not an absent one |
| H2 | `conversations/model-provider/core/stored.ts`: corruption sink defaults to `console.error`, replaced by `web/components/corruption-reporter.tsx` (`registerModelCorruptionReporter`) | B′ drops model-provider's web in settings, file-explorer, data, auth: corrupt stored models go to the console, not a report | `defineReportSink` (the report-sink primitive: buffered, replayed to its handler, a declared contract) |
| H3 | 20 field kinds (`fields/*/config`: `textField`, `intField`, `boolField`, `listField`, …): the `*Field()` factory is a plain function, but the field's editor and sample are registered by its own `web/` into `config_v2/fields`' `Fields.Renderer` / `Fields.Sample` — an **unkeyed** dispatch slot whose fallback renders "Unknown field type" | Settings shows a placeholder for every config field whose kind's `web/` did not ship | `Fields.Renderer` / `Fields.Sample` become keyed companion slots (`companions: { key: "match", space: "field-type" }`) — the existing usage-rule machinery: the editor ships whenever `config_v2/fields` and a user of the field type ship; a known type with no renderer throws `MissingCompanionError` |
| H4 | `debug/render-profiler/core` `RENDER_PROFILER_GLOBAL`: a window global installed by its `web/internal/global-api.ts`, read by `reports/render-loop/web` | render-loop attribution returns `null`, silently | the profiler API becomes a declared web contract (provided by `render-profiler/web`); absence is a typed state the detector reports, not `undefined` |

**Framework seams installed by another plugin's half (8).** They exist today
and hold only because the installer happens to ship whole. Under B′ an
installer reached only through its `core/` would drop its half — measured:
`infra/launcher` loses `server/` in agent-manager, agent-manager-lean,
conversations and agent-runtime.

| # | seam (`core/` owner) | installer | fix |
|---|---|---|---|
| H5 | `server-core` `setWatermarkSource` | `database/server` | host service |
| H6 | `server-core` `setRelationBases` | `network/live/change-feed/server` | host service |
| H7 | `server-core` `setLiveStateSnapshotHooks` / `setEpochHandoffHooks` | `live-state-snapshot/server` + `/machine` | host service |
| H8 | `server-core` `setClientBuildIdentity` | `build/server-build-id/server` | host service |
| H9 | `infra/paths` `setReleaseIdentity` | `infra/launcher/server` (dropped by B′ in 4 compositions) | host service |
| H10 | `server-core` `profilerStart` | `infra/warmup/server` (and `server-core/bin`) | host service |
| H11 | `server-core` `markServerReady` | `server-core/bin` + `debug/boot-monitor/server` | none — the process root always calls it |
| H12 | `runtime-identity` `declareRuntimeNamespace` | `server-core/bin` + `debug/sentinel` worker | none — reading it undeclared already throws |

`defineHostService` already gives the loud failure (`"x" has no provider: no
booted plugin contributes x.provide(…)`); a seam moved onto it is reached
through its owner's `server/` barrel, a runtime edge, so the closure ships the
provider by the ordinary rule.

**Benign — no fix (13 observer registries):** subscribers whose absence is the
absence of a feature, not a broken contract: `onSlowSpan` / `onSlowWait`
(slow-ops), `onSlowFsCall` (fs-wait), `onResourcePush` / `onResourceDelivery`
(churn monitor, latency ledger), `noteLoopTurn`, `recordEntrySpan`,
`registerGateGauge` (from database, host-admission, read-pool, browser-fetch),
`subscribeSlotsDeclared`, `sinkHandler` (report sinks buffer and replay),
`defineFileSink` / `defineSourceSet` registries, `collectContributions`,
`pageInput` (the browser host's page config), `web-sdk` deferred-load store
(web-core), host-fs drag hand-off.

**False positives (6):** memo caches written on read — id-chip patterns,
`ids` decoder kinds, live `followsOf`, `database` config cache, `paths` home
layout — and `adaptive-bar`'s constant.

**Dispatch slots audited (12):** only `config_v2/fields` is keyed by a value a
`core/` contract declares (H3). The page editor's blocks are keyed by
`defineBlock` (a contract: its provider ships by the rule). The other ten
(tool-call renderers, attachments, conversation items, trace engine, reports,
map, google-maps, prototype compare, agent-thread) dispatch on data (a tool
name in a transcript, a report kind) — a placeholder for data the composition
cannot render is correct, today and under B′.

Totals: **12 couplings (H1–H12): 10 to fix, 2 already safe, touching ~35
plugins** (H3 alone is 20), plus 13 benign observers and 6 false positives.

### 3. Loud failure for a missing contract — today and missing

| contract | today | missing |
|---|---|---|
| host service | throws at boot: `"x" has no provider` | — |
| keyed companion | `MissingCompanionError` | — |
| config | server `getConfig`/`setConfig`/`watchConfig` throw "descriptor … is not registered"; web `useConfigLink` throws | — |
| id kind | `ids:kind-both-runtimes` check (static) | — |
| live value / collection | a **browser** host answers `unserved` (closed key set, HTTP 404); a **desktop** server answers `unknown-key`, which the client treats as version skew (reload prompt) | the desktop server serves a closed key set too (its composition's registry): answer `unserved` with the key and its **provider plugin**, client throws `ResourceUnservedError(value, provider)` |
| endpoint | generic 404 from the router | the composition's endpoint manifest (route → provider plugin): a declared-but-unregistered route answers an error naming contract + provider; `fetchEndpoint` throws it |
| app / route | not checked | resolving an `AppRef` / route against the composition's declared apps throws (or a typed absent state, if cross-app links are made optional — question 5b) |
| field kind | "Unknown field type" placeholder | H3's companion error |

### 4. Implementation cost, per area

| area | change | size | risk |
|---|---|---|---|
| **cross-refs facet** | per `ApiUse`: `contract?: { factory, providers: RuntimeFolder[] }`, from the target's light-barrel export table (factory or wrapper fixpoint, the owner folders naming it) resolved in `relate()`; the contract-kinds leaf | M (~400 LOC + tests) | one full facet re-extraction; facet key widens to the target's light barrels (key-width check) |
| **closure engine** (`closure/core`) | `HardEdge` gains `targets` (halves of `to` it brings, beside `runtimes` = folders of `from`); `hardClosure` over (plugin, half); `Composition.halves`; membership "core only"; `explainInclusion` / `impactOf*` per half (steps name the contract: "server/ for live value `pluginTree`"); host view intersects both sides; negatives stay per plugin | L (~1000 LOC incl. tests) | load-bearing: every consumer of `bundle` (codegen, composition-closure, deploy closure-guards, approvals, Studio) must say whether it means "present" or "has half h" |
| **registry codegen** | `{web,server,central}.generated.ts` and `machineEntries` filtered per half (`collectEntriesWithDeps`, `plugin-registry-gen.ts:548`); `dependsOn` validated per half (a server plugin depending on a core-only one is an error, not a silent prune); eager tier, companion manifest, browser-host portability per half | M (~300 LOC) | `plugins-registry-in-sync` proves main unchanged (`**` ships every half); a wrong per-half filter boots a composition with a missing slot owner |
| **web artifacts / module loading** | none for `core/` (per-barrel artifacts in the import map); the composition fleet source plans from the per-half registry | S | an artifact for a `web/` barrel nothing registers must not be composed |
| **server / machine / central loaders** | none — registry-driven; `core/` resolves from source | S | — |
| **Studio composition view** | per-half membership tint and legend, the Desktop/Browser toggle × halves, inclusion steps naming the contract + provider half, a "core only" filter | M (~300 LOC UI) | display only |
| **boundary rules / checks** | unchanged import table; new: contract-kinds classified (closed vocabulary), `core-state-installs-declared` (the coupling scanner as a check: a `core/` module whose state a runtime half writes must be a host service, a contract, or declared an observer in `exempt/`), keyed dispatch on a contract key must be a companion; `composition-closure`'s per-plugin rules unchanged | M | the scanner is heuristic (one hop, by name) — a coupling it misses is a silent break; the runtime loud failures (§3) are the backstop |
| **coupling fixes** (H1–H10) | runtime-profiler host service; `Fields.*` keyed companions; corruption report sink; render-profiler web contract; 6 framework seams → host services | M–L total, each S–M, independent | H1 is load-bearing perf infra (every span) |
| **loud failures** (§3) | desktop `unserved` naming the provider; endpoint manifest 404; app-ref resolution | M | — |
| **D9 report / docs** | closure, composition, codegen CLAUDE.md; the D9 track page; `plugins-details` marks "(core only)" | S | — |

### 5. Measured savings

Runtime-bearing plugins / runtime halves / web KB / backend source KB, one
run (890e97bc5c; bytes move ±0.3% between runs as the newest dist changes).
"A after splits" = option A's seven splits applied (their pure values light,
everything else per plugin). Sound B = a contract import ships its whole
plugin, no coupling fixes. B′ = contract import ships only its provider half,
with H1/H3 declared.

| composition | today | A after splits | sound B | **B′ contract-aware** |
|---|---|---|---|---|
| agent-manager | 880 / 1178 / 11677 / 15267 | 856 / 1139 / 11404 / 14378 | 847 / 1130 / 11372 / 14332 | **848 / 1129 / 11367 / 14339** |
| home | 442 / 546 / 5697 / 9458 | 442 (no split applies) | 418 / 520 / 5621 / 9392 | **431 / 531 / 5618 / 9398** |
| settings | 355 / 416 / 4934 / 8245 | 352 / 412 / 4918 / 8240 | 328 / 385 / 4887 / 8152 | **340 / 394 / 4882 / 8158** |
| studio | 474 / 590 / 5892 / 10494 | 474 | 443 / 553 / 5837 / 10269 | **458 / 565 / 5830 / 10275** |
| deploy | 481 / 604 / 6237 / 10974 | 481 | 450 / 567 / 6163 / 10749 | **465 / 581 / 6159 / 10757** |
| website | 347 / 390 / 5245 / 7317 | 344 / 386 / 5199 / 7296 | 322 / 363 / 5170 / 7276 | **335 / 376 / 5189 / 7284** |
| diagnostics | 460 / 588 / 6324 / 11630 | 449 / 570 / 6228 / 10824 | 421 / 537 / 6114 / 10732 | **433 / 547 / 6071 / 10739** |
| conversations | 676 / 891 / 8416 / 14044 | 650 / 849 / 8127 / 13144 | 622 / 820 / 8089 / 13081 | **636 / 831 / 8088 / 13088** |

Reading it:

- B′ ≈ sound B in halves and bytes; it ships up to ~15 more plugins than
  sound B (home +13, settings +12, agent-manager +1) because it is *correct*
  where sound B is not (H3's field-kind `web/` halves come back by the
  companion rule).
- Where A's splits apply (agent-manager, conversations, diagnostics), A
  already gets ~75% of B′'s plugin saving and ~90% of its bytes.
- Elsewhere (home, studio, deploy, pages, sonata, …) A does nothing and B′
  saves 11–16 runtime plugins — but ≤1.5% of web bytes and ≤2% of backend
  source: the tail is mostly presence-only halves.
- B′ vs today, overall: −2.5…−6% runtime plugins, −3…−7% halves, −0.3…−4%
  web bytes, −0.6…−8% backend source.

### 6. What guard remains

The light-drag guard becomes unnecessary: under B′ a plain-value import
cannot drag a runtime half, by construction. What remains guards the
*classification* the rule relies on:

- `contract-kinds:classified` — every light-barrel factory is in the contract
  or the plain list (a new factory cannot read as plain by default).
- `core-state-installs-declared` — no new hidden coupling (the scanner as a
  check; observers declared in `exempt/`).
- Keyed dispatch on a contract-declared key must be a companion slot.
- Contract drags stay visible, not failing: Studio's inclusion steps name the
  contract and the half it brought.

### Design B′ — tasks

Independently landable; ordered by dependency.

1. **B′-1 Contract kinds as facet data** — the contract-kinds leaf
   (`factory → provider class`, the plain list), `ApiUse.contract` in the
   cross-refs facet (factory, wrapper fixpoint, provider folders), and the
   `contract-kinds:classified` check. No behaviour change; the measurement
   script reads the facet instead of disk.
2. **B′-2 Coupling fixes** — parallel, each its own task, no dependency on 1:
   - 2a H1: runtime-profiler runtimes as one host service (recorder, profiler
     hooks, lease scope, fs-await read it; explicit no-host provider for CLI).
   - 2b H3: `Fields.Renderer` / `Fields.Sample` keyed companions in the
     `field-type` space; the "Unknown field type" fallback becomes
     `MissingCompanionError` for a known type.
   - 2c H2: model-provider corruption through `defineReportSink`.
   - 2d H4: render-profiler API as a declared web contract, absence typed.
   - 2e H5–H10: the six framework seams as host services.
3. **B′-3 Loud missing contracts** — parallel with 2:
   - 3a desktop server answers `unserved` naming the provider plugin; client
     `ResourceUnservedError`.
   - 3b endpoint manifest per composition; 404 naming contract + provider.
   - 3c app / route refs resolved against the composition's declared apps.
4. **B′-4 `core-state-installs-declared` check** — after 2 (lands green), from
   `scripts/find-core-couplings.ts`; observers (the 13) declared in their
   owners' `exempt/` manifests.
5. **B′-5 Closure engine per half** — after 1, 2, 4. `HardEdge.targets`,
   (plugin, half) closure, `Composition.halves`, per-half membership /
   explain / impact, host view; tests on the real tree (main unchanged).
6. **B′-6 Codegen per half** — after 5. Registries and `machineEntries` per
   half, `dependsOn` validated per half, eager tier / companion manifest /
   browser-host portability per half; `plugins-registry-in-sync` proves main
   byte-identical.
7. **B′-7 Studio per-half view** — after 5, parallel with 6.
8. **B′-8 Fleet planning** — after 6: the composition fleet source plans from
   the per-half registry.
9. **B′-9 Docs + D9 report** — closure / composition / codegen CLAUDE.md, the
   D9 page; the measurement script kept as the regression read.

Tasks 2 and 3 are worth landing whatever is decided about 5–8: each fixes a
silent failure that exists today (console-only corruption reports, the
"Unknown field type" placeholder, a profiler-less render-loop, seams held by
accident, desktop `unknown-key` read as skew).

## Side-by-side

| | Option A: splits + light-drag guard | Design B′: contract-aware closure |
|---|---|---|
| **Savings** (runtime plugins / web bytes vs today) | agent-manager −24 / −2.3%, conversations −26, diagnostics −11, mcp −5, website −3; **0 elsewhere** | agent-manager −32 / −2.7%, conversations −40, diagnostics −27 / −4%, studio −16, deploy −16, home −11; **every composition −2.5…−6% plugins, −0.3…−4% web** |
| **New plugins** | 7 core-only leaves now, one more each time the guard trips | 0 |
| **Durability against future imports** | the guard fails the build on the next drag ≥ 3; the fix is another split (more tiny plugins) | structural: a plain-value import cannot drag; a new contract factory must be classified (check) |
| **Implementation cost** | S–M: 6 split tasks + facet contract flag + one check | L: facet + closure engine per half + codegen + Studio + 10 coupling fixes + 3 loud failures + 2 checks (≈ 9 tasks, 3 of them M–L) |
| **Runtime risk** | low: the closure semantics do not change | medium: a coupling the scanner misses ships a `core/` without its half — mitigated by §3's loud failures (live, endpoint, app, companion, host service) and the two checks; main is unaffected (`**`) |

## Recommendation

**B′, staged**, because it is the clean structural fix and the one the user
asked for (no tiny plugins, durable against the next import) — with an
honest note on size: the bytes at stake are small (−1…−4% web), so the
engine work (tasks 5–8) should be gated on stages 1–3, which carry most of
the value on their own:

1. Land B′-1, B′-2 and B′-3 first (parallel). They make every hidden
   coupling expressible and every missing contract loud — real bugs today —
   and they are the prerequisites B′ cannot do without.
2. Re-run the measurement on the facet data (B′-1 makes the counterfactual
   exact) and decide on B′-5…8 with those numbers.
3. Do not start option A's splits: under B′ they are unnecessary, and the
   light-drag guard is never built.

If B′-5…8 are judged not worth their cost after step 2, option A remains
complete above, and its guard can reuse B′-1's facet data unchanged.

## Verification

- Script: `./equin run plugins/plugin-meta/plugins/closure/scripts/measure-core-drag.ts --composition agent-manager`
  — after each split, the row's *runtime today* drops by the table's number
  and the target leaves the drag list.
- The script asserts its per-folder re-derivation equals `resolveComposition`
  for every composition × host, so a closure-semantics change shows up as a
  thrown error, not a wrong number.
- Check (task 4): `./equin check composition-closure:light-drag` fails on a
  fixture importing a pure value from a heavy plugin's `core/`, passes after
  the split; `./equin test plugins/plugin-meta/plugins/closure` for the pure
  function.
- B′: `./equin run plugins/plugin-meta/plugins/closure/scripts/find-core-couplings.ts`
  lists every `core/` module whose state a runtime half writes; after B′-2 the
  OWN rows are gone and the rest are declared observers. The measurement's
  COMPARISON block prints today / A after splits / sound B / B′ per
  composition; after B′-6 the real `resolveComposition` halves must equal its
  `CONTRACT_HALF` column (the script's equality assertion moves to that mode).
- B′ loud failures: on a composition built without a contract's provider,
  subscribing to its live value throws `ResourceUnservedError` naming the
  value and the provider plugin (e2e on a served composition).
