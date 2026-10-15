# composition

The **composition manifest registry** — owns the named compositions of the repo
as runtime-editable data. A composition is a `CompositionManifest`
(`{ name, entryPoints, selectedContributors, extends? }`, **owned by and imported
from** [`closure`](../closure/CLAUDE.md) — never redefined here) plus a
`category` (organisation metadata only — `app | profile | subsystem | pack`,
NOT consumed by the engine); this plugin is the *registry* that stores them, the
engine is the algorithm that resolves them. Sibling of `closure` / `plugin-tree`
/ `facets` under `plugin-meta`; ships `core` / `web` / `server` barrels.

## Taxonomy & seeds

The config `default` seeds the whole repo's compositions, grouped by `category`:
**app** (one lean baseline per top-level `Apps.App`, entry = the app shell
umbrella), **profile** (variants of one app along the self-improvement axis — the
worked example is `agent-manager` full vs. `agent-manager-lean`), **subsystem**
(infra closures used as building blocks / inspection lenses — `data`,
`jobs-events`, `live-state`, `auth`, …), and **pack** (entry-less contributor
SETs apps opt into via `extends`; `self-improvement` is the pack the
agent-manager profile pulls in). The full bundle is never enforced at runtime
yet — compositions remain a Studio inspection concept; releasing/runtime-gating
is future work.

## Manifests are a config_v2 config — no codegen

Manifests live in a [`config_v2`](../../../config_v2/CLAUDE.md) config named
`compositions` (`core/config.ts`, `defineConfig` + a `listField` of
`{ name, category (enum), entryPoints (string-list), selectedContributors
(string-list), extends (string-list), serve (enum) }`). This replaces
the former collected-dir / barrel registry: there is **no**
`composition.generated.ts`, `loadCompositions()`, or
`<plugin>/composition/index.ts` — creating or editing a manifest is now a plain
runtime write, no `./singularity build` required.

The config's `default` seeds the full repo taxonomy (apps / profiles /
subsystems / packs — see above). The agent-manager anchor demo is the
`profile` pair: a full `agent-manager` that `extends: ["self-improvement"]` and
an `agent-manager-lean` that does not, so the flattened full \ lean contributor
difference is exactly the self-improvement pack. Each seed carries an **explicit
stable `id` + `rank`** (the list field only auto-injects those on UI "Add"), so
seeded rows are editable and ordered; ranks are the leading fractional-index
keys (`"a0"`, `"a1"`, `"a2"`, …).

Because config_v2 carries a built-in **git layer** (committed default) and
**user layer** (runtime override), a manifest set edited in the UI lands in the
per-worktree user config. There is **no runtime path back to the committed
default**: change it by editing the `core/config.ts` seeds and pushing.

- `core/config.ts` — the `compositionsConfig` descriptor (core-safe: imported by
  web, server, and the future build-time check).
- `core/manifest-map.ts` — `manifestItemToManifest(item)` drops the list `id` /
  `rank` and the engine-opaque `category`, carries `extends` through verbatim,
  and casts the id arrays to `PluginId[]` at the config boundary, plus the
  `CompositionManifestItem` type (a manifest + `category` + its `id` / `rank`).
- `server/index.ts` registers the config (`ConfigV2.Register`); `web/index.ts`
  registers it on the client (`ConfigV2.WebRegister`).

## `base-exclusions` — the one row that subtracts

Every other row in this registry says what it INCLUDES. `base-exclusions` (id and
name both `BASE_EXCLUSIONS_ID`, from `infra/namespace`) says what is **not in any
app**, and every composition inherits it: `flattenManifest` folds this row into
every manifest **unconditionally, not through `extends`**. An exclusion written
once therefore holds for compositions that do not exist yet, instead of holding
only for the rows whose author remembered to reference it — the property
`singularity.disabled` in a `package.json` used to have.

Three rules, all enforced by `composition-closure`:

- **The row exists exactly once.** `flattenManifest` resolves it BY NAME, so a
  second row would silently shadow the first and a missing one would make every
  inherited exclusion vanish without a word — the same reason main's row is pinned
  to exactly one.
- **Negatives only** — every `entryPoints` entry starts with `!`, and
  `selectedContributors` is `[]`. A positive here would be a way to force a plugin
  INTO every composition from a place nobody looks; that is `served-baseline`'s
  job, done through `extends`, where the row that opted in shows it.
- **`serve: "off"`**, and the id is reserved. The row resolves to an empty bundle,
  so there is nothing a serve build could put behind a `base-exclusions`
  namespace. `assertCompositionId` accepts it exactly as it accepts main's id;
  `assertServableCompositionNamespace` refuses both.

**Opting back in** is the engine's existing protection rule: a composition that
names the plugin — as an entry positive or a selected contributor — wins over the
inherited negative, and nothing cascades. Naming an *importer* of the excluded
plugin is NOT an opt-out: the importer survives, drags the plugin back through its
hard closure, and `resolveComposition` reports it in `unsatisfiedExclusions` with
the import chain rather than guessing which of the two the author meant.

The seed carries one negative, `!review.plugin-changes.**` — the migration of the
`singularity.disabled: true` flag that used to live in
`plugins/review/plugins/plugin-changes/package.json`. It resolves to the same
twelve plugins that flag's closure did (the plugin, its two sub-plugins, and the
nine `plugin-meta.facets.<f>.render-diff` adapters that import it), because a
negative cascades to descendants and transitive importers exactly as the disabled
closure did. One mechanism decides membership now, and it is this one.

## Override is forbidden — by construction

The manifest vocabulary is **additive only** (`entryPoints`,
`selectedContributors`, and `extends` — which only unions in another
composition's additive vocabulary). There is no field that replaces or redirects
a plugin's file, so override is *inexpressible*; resolution is a pure union /
hard-closure with the one asymmetry above — negatives subtract, and a local
positive always wins over a negative from anywhere, so the union direction is
never in doubt. The `composition-closure` check
(`framework/tooling/checks`) adds validity (ids resolve, names unique, every
selection is a genuine load-bearing soft option) by reading the committed
git-layer config off disk — runtime-only (user-layer) manifests are never
closure-checked.

## `excludes` — the dual of `extends` (a check-time assertion, not engine input)

Each manifest also carries `excludes: string[]` — composition NAMES whose plugins
this composition's bundle must stay **disjoint** from. It is the mirror of
`extends`: where `extends` unions a bundle IN, `excludes` asserts a bundle is
ABSENT. This is the **self-containment guard** — an app excludes the
agent/worktree/git infra bundles it must ship without (e.g. Sonata excludes
`["agent-runtime", "auth"]`; `auth` is a separate bundle, forbidden on demand).

`excludes` is **NOT** a `CompositionManifest` (engine) field — it is engine-opaque
config metadata like `category` / `id` / `rank`, so `manifestItemToManifest` drops
it and the additive-only resolution invariant above is untouched. It is read and
enforced solely by the `composition-closure` check, which fails if the
composition's resolved hard closure intersects the **containment** (entries +
contributors + their subtrees) of any excluded bundle. The forbidden bundles are
ordinary compositions in this config (the `agent-runtime` subsystem aggregates the
worktree / git-watcher / claude-cli taproots and the agent-manager shell via
`extends`) — so what counts as forbidden infra is plain editable data, never
hardcoded in the check.

## `serve` — one enum, because two fields admit a meaningless state

`serve` (`core/serve-mode.ts`) says **whether** a composition is meant to be live
here and, for the automatic modes, **how often** it may be rebuilt:
`off | manual | push | hourly | daily | weekly`. One field rather than a
served-flag plus a mode, so "rebuild on push but not served" has no spelling.

A mode's whole content is a rate limit — `autoRebuildIntervalMs`, a total
`Record` so a new mode is a tsc error rather than one that silently never fires
(`null` = never automatic, `push` = 0). That is what lets every edge of the build
convergence loop evaluate every mode through one predicate. `SERVE_MODE_OPTIONS`
is the single source the config field and every picker read, so the set and its
labels cannot drift apart.

Still **intent, never liveness** — `activatedCompositionIds` answers "who did
someone say should be live", the `composition.json` marker answers "what is". And
engine-opaque, like `category` / `excludes`: `manifestItemToManifest` drops it.

## `home` — the app owning `/` is the composition's call

`home` is a `defineApp` id: the app bare `/` redirects to (and the app launcher
opens) when this composition is deployed. Which app is the homepage is a
property of what is deployed, so no app can claim it in code — `Apps.App` has
no `default` flag, and there is no first-registered fallback. `""` only for a
bundle holding no app (subsystems without an app shell, packs).

`resolveCompositionHome` (`core/home.ts`) is the one verdict: the home app, no
app, or an error (missing / not an app / not in the bundle / home without apps).
`composition-closure` fails on an error; registry codegen throws on one and
otherwise bakes `composition = { id, home }` into every composition registry,
which `App.tsx` hands to `PluginProvider` and apps-core reads via
`useComposition()` → `useHomeApp()` — at build time, never a request.
Engine-opaque: `manifestItemToManifest` drops it. Studio edits it in the
composition detail pane's Home app section (`useManifestActions().setHome`).

## Studio data: server + web runtimes

Beyond the registry, this plugin ships the **Studio closure data**:

- **`server/`** serves the `composition.data` live value (`compositionData`,
  declared in `core/data.ts`; external, on-demand, `changes: "notified"` by
  plugin-tree's `onPluginTreeChanged` while a tab holds it, ETagged by
  `pluginTreeGeneration()`, throttled 2 s): it reads the cached facets tree from `plugin-tree` (watcher-invalidated, warmed
  post-boot on main) and derives `{ graph: SerializedEdgeGraph, allIds }` —
  code-derived structure only, with **no membership field of any kind**. Which
  plugins are in the app is a pure function of that graph plus the manifests,
  and the client holds both, so shipping the answer would be a second spelling
  free to drift from the engine's (see `useAppExclusions` below). The derivation
  (classify + serialize + one id scan, ~10ms) is memoized per tree identity (WeakMap), so it
  re-runs exactly when plugin-tree's memo rebuilds — a live plugin change
  reaches every open tab, never served stale. Manifests are **not** in
  this value; they are user data read client-side from the `compositions`
  config. The graph is serialized via `closure/core`'s `serializeEdgeGraph` so
  it crosses the wire as plain JSON; the membership/inclusion/impact algorithms
  then run entirely client-side.
- **`web/`** owns the **manifest read/write API** over the config:
  `useManifestItems()` returns the raw config items (`{ id, rank, name,
  entryPoints, selectedContributors }[]`) for the Studio list + editing;
  `useManifestActions()` returns `{ save(draft, editingId?), remove(id),
  setServeMode(id, mode) }` built
  on `useSetConfig` — `save` upserts (replace by `editingId`, else append a new
  item with a fresh `id` + `rank` via `crypto.randomUUID()` + `Rank.between`,
  mirroring the `list` field renderer). Consumers go through this API so they
  never touch `config_v2` directly (collection-consumer separation).

  `save` and `remove` **throw** for the two committed-source rows —
  `isCommittedSourceComposition(id)`, i.e. main's and `base-exclusions`. Codegen
  resolves main's closure off the GIT layer to emit the registries and the docs,
  so a user-layer edit to either row could never move a generated file: it would
  be a stored change that means nothing. Every surface that offers those
  controls reads the same predicate and renders them inert (Studio's entry-point
  editor read-only with a pointer at `core/config.ts`, Save disabled, Delete
  absent), so the throw is the loud boundary beneath them, never the
  user-facing refusal.
- **`web/`** answers "what does the app actually ship?" with `useAppExclusions()`
  — it resolves the `singularity` composition IN THE BROWSER (`flattenManifest`
  folds the base row's negatives in) and returns `{ kind: "pending" }` or
  `{ kind: "ready", excluded, negatedTargets }`. `excluded` is every id outside
  main's bundle; `negatedTargets` is the subset a manifest negated by name, which
  is how the explorer badge tells *Not in the app* from *Not in the app
  (cascade)*. Resolved once per (graph, config) pair — the badge asks from every
  one of ~900 tree rows.
- **`web/`** also exposes `useCompositionData()` (fetch + deserialize-once,
  sourcing `manifests` from `useManifestItems()` mapped through
  `manifestItemToManifest`, so engine consumers keep their `CompositionManifest[]`
  shape) and the
  module-level **active-composition store** (`useSyncExternalStore`): the working
  DRAFT `CompositionManifest`, with `setActiveComposition` / `pinAsRoot` /
  `updateActiveDraft` / `clearActive`, plus a derived `useActiveMembership()` map
  recomputed exactly **once per (active, graph) change** (not per row). Causality
  hooks `useInclusion(node)` / `useImpact(node)` wrap the engine's
  `explainInclusion` / `impact*` against the active draft. Studio sub-plugins and
  `plugin-view` import these from `composition/web`.
- **Compare slot (Increment 3).** The store also holds a second
  `compareWith: CompositionManifest | null` (`setCompareComposition`,
  `useCompareComposition`). When BOTH active and compareWith are set
  (`useIsCompareMode()` → true), `useDiffMap()` returns a
  `Map<PluginId, DiffState>` (`"only-a" | "only-b" | "both" | "neither"`) derived
  exactly **once per (active, compareWith, graph) change** by comparing the two
  `resolveComposition(graph, …).bundle` sets: in both → `both`, only active(A) →
  `only-a`, only compareWith(B) → `only-b`, else `neither`. `useDiffMap()` is
  `null` outside compare mode, so the single-composition membership path is
  untouched. `clearActive()` clears the compare slot too.

## Tests

`core/config.test.ts` is pure logic (no generated registry, no server): it
asserts the config `default` seeds parse against the descriptor schema, that the
taxonomy is populated (app / profile / subsystem / pack), each seed maps to a
valid `CompositionManifest` via `manifestItemToManifest` (only packs may omit
entry points), the `self-improvement` pack holds exactly the self-improvement
set, and that the **flattened** agent-manager full-vs-lean `selectedContributors`
difference (via `flattenManifest`) is exactly that pack. It also pins the
`base-exclusions` row — present exactly once, negatives-only, empty
`selectedContributors`, `serve: "off"`, carrying `!review.plugin-changes.**` —
and that main's entry points are still exactly `["**"]`, since the exclusion
deliberately does not live there.

`core/namespace.test.ts` pins the split between "may be called this" and "may be
served under this", including the two ids where the answers differ
(`singularity`, `base-exclusions`).

Run with `./singularity test plugins/plugin-meta/plugins/composition`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Web hooks + active-composition store for the Studio closure visualization: fetches and deserializes the edge graph once, holds the working draft, and derives membership / inclusion / impact client-side. Owns the manifest read/write API over the compositions config_v2 config. Serves the classified edge graph for the Studio closure visualization; registers the runtime-editable compositions config.
- Web:
  - Contributes: `ConfigV2.WebRegister` "compositions"
  - Uses:
    - `config_v2.ConfigV2`
    - `config_v2.useConfig`
    - `config_v2.useSetConfig`
    - `network/live.useLive`
    - `primitives/live-state.mapResource`
    - `primitives/live-state.ResourceError`
    - `primitives/live-state.ResourceResult`
  - Exports (types):
    - `AppExclusions`
    - `CompositionDataResult`
    - `CompositionGraph`
    - `CompositionInclusion`
    - `DiffState`
    - `ImpactResult`
    - `ManifestActions`
  - Exports (values):
    - `clearActive`
    - `pinAsRoot`
    - `setActiveComposition`
    - `setCompareComposition`
    - `updateActiveDraft`
    - `useActiveComposition`
    - `useActiveMembership`
    - `useAppExclusions`
    - `useCompareComposition`
    - `useCompositionData`
    - `useCompositionIncludes`
    - `useDiffMap`
    - `useEnsureCompositionData`
    - `useGraph`
    - `useImpact`
    - `useInclusion`
    - `useIsCompareMode`
    - `useManifestActions`
    - `useManifestItemByName`
    - `useManifestItems`
- Server:
  - Contributes:
    - `ConfigV2.Register` "compositions"
    - `resource.declare` "composition.data"
  - Uses:
    - `config_v2.ConfigV2`
    - `network/live.serveValue`
    - `plugin-meta/plugin-tree.getFacetsTreeCached`
    - `plugin-meta/plugin-tree.onPluginTreeChanged`
    - `plugin-meta/plugin-tree.pluginTreeGeneration`
  - Resources: `composition.data` (invalidate, notified)
- Core:
  - Uses:
    - `config_v2.defineConfig`
    - `fields/enum/config.enumField`
    - `fields/list/config.listField`
    - `fields/string-list/config.stringListField`
    - `fields/text/config.textField`
    - `infra/namespace.BASE_EXCLUSIONS_ID`
    - `infra/namespace.MAIN_COMPOSITION_ID`
    - `infra/namespace.NAMESPACE_LABEL_RE`
    - `network/live.liveValue`
  - Exports (types):
    - `CompositionData`
    - `CompositionHome`
    - `CompositionHomeError`
    - `CompositionManifestItem`
    - `ServeMode`
    - `ServeModeOption`
  - Exports (values):
    - `activatedCompositionIds`
    - `assertCompositionId`
    - `assertCompositionName`
    - `assertServableCompositionNamespace`
    - `autoRebuildIntervalMs`
    - `compositionData`
    - `compositionsConfig`
    - `isCommittedSourceComposition`
    - `isServableCompositionId`
    - `isServed`
    - `manifestItemToManifest`
    - `RESERVED_COMPOSITION_NAMESPACES`
    - `resolveCompositionHome`
    - `SERVE_MODE_OPTIONS`
    - `SERVE_MODES`
    - `serveModeLabel`
- Cross-plugin:
  - Imported by:
    - `apps/deploy/analytics/dashboard`
    - `apps/deploy/composition`
    - `apps/deploy/deployments`
    - `apps/deploy/local-serve`
    - `apps/studio/compositions`
    - `apps/studio/compositions/contributors`
    - `apps/studio/compositions/draft-actions`
    - `apps/studio/compositions/entry-points`
    - `apps/studio/compositions/home`
    - `apps/studio/compositions/membership-summary`
    - `apps/studio/compositions/release`
    - `apps/studio/explorer/excluded`
    - `apps/studio/explorer/membership`
    - `apps/studio/graph`
    - `build/serve-composition`
    - `framework/tooling/codegen`
    - `plugin-meta/plugin-view/dependencies`
    - `plugin-meta/plugin-view/inclusion`

<!-- AUTOGENERATED:END -->
