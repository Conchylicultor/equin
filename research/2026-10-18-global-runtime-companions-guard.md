# Runtime companions guard: dead-end root mounts fail the build, missing companions fail the app

Track: wiki *Mental model → Plugin system → Composition* (block-6b4d4ded…), item
**[Guard]**. Mental model: block-136ef01b-5cd2-4d6a-a212-7d48b46425bf.
Predecessors: `research/2026-10-15-global-token-usage-closure-edges.md`,
`research/2026-10-17-global-companion-contributions.md`,
`research/2026-10-18-global-keyed-companions.md`,
`research/2026-10-18-global-reorder-apply-edit-split.md`.

## Context

Every runtime need we know about now ships through a derived edge: an import, a token
use, a companion or a keyed companion. Two holes remain.

1. **Build: the next one.** A plugin mounted only from `Core.Root` / `Core.Boot`, which
   nothing imports and nothing flags, reaches no composition except main (`**`). Nothing
   says so. This is exactly how sprites, the font loader and reorder dropped out of
   equin.ai.
2. **Runtime: the degrade is silent.** If a companion is missing anyway (a closure bug,
   a stale registry, a deferred tier that never loaded), the owner degrades with no
   signal:

   | Site | Today |
   |---|---|
   | `<Icon>` without `ui.icons.sprites` (`icons/web/internal/icon.tsx:100`) | an empty, correctly sized box |
   | the icon style bridge missing (`style-store.ts` `iconStyleOf`) | the default style |
   | fonts loader missing | the fallback font stack |
   | `slot-render` without reorder or error-boundary middleware (`render-slot.tsx` `.Render`, `ItemMiddlewares`) | registration order, and no isolation |
   | reorder node type missing (`reorder/web/internal/list-middleware.tsx:195,214`) | `return null` |
   | DataView `Cell` / `CellEditor` / `Filter` / `ValueCodec` / `ColumnConfig` / `Grouping` miss (six copy-pasted `resolveTypeChain` walks in `primitives/data-view/web/*-slot.ts`) | text, read-only, identity codec, not filterable or groupable |
   | DataView row whose view type has no renderer (`view-core/web/internal/resolve-instances.ts:43`) | the row is filtered out |

Goal: the build refuses an undeclared dead-end, and the running app says loudly when
a companion the repo provides is absent from the bundle.

## Design

### 1. Build: `closure:root-mounts-reached` (rung 3)

**Ambient slots.** A slot owned by the framework (`web-sdk`'s `Core.Root`, `Core.Boot`)
is mounted in every bundle. A contribution there says nothing about which capability
needs it. Read this from the slots facet: the owner is `framework.web-sdk`. Don't
hand-list slot ids.

**Rule.** Every plugin that
- contributes to an ambient slot, and
- has no incoming hard edge (`graph.hardReverse.get(id)` empty: no import, token,
  companion or usage edge)

must be in the bundle of at least one composition other than main. Resolve every
committed manifest except main (`readCompositionManifestsFromDisk` → `flattenManifest`
→ `resolveComposition(graph, flat).bundle`) and take the union. A dead-end can only
get there by being named: an app subtree, `served-baseline`, a pack, or
`selectedContributors`. Naming it anywhere is the declaration of what it is.

**Failure message.** It names the plugin, its ambient contribution, and the three
legitimate fixes:
- needed by a capability → make it a companion of that capability's slot (`companions: true` + `companion: true`; `defineRootSlot` if it mounts at the root);
- needed for being served at all → `served-baseline`;
- an opt-in feature → a pack.

It lives beside `companions-visible` / `keys-defined` in
`checks/plugins/composition-closure/check/` and gets the graph through
`buildRegistryGenContext` (memoized, shared with the other checks).

### 2. Today's dead-ends, judged one by one

The check's first run gives the exact list. Exploration (web `dependsOn` only)
expects these. `apps-core.layout` and `primitives.dom.overscroll-hint` are already in
the baseline, and `apps.mail.sync.auto-resume` is covered by `apps.mail.**`.

| Plugin | Proposed decision |
|---|---|
| `reports.*` reporters (`endpoint-errors`, `resource-errors`, `mutation-errors`, `render-loop`, `plugin-load-errors`, `theme-resolution`, `live-state-stale-drop`, `optimistic-*`, `page-undo-conflict`, `panel-overflow`, `viewport-escape`, `adaptive-bar`, `caret-flight`, `collab-hydration`, …) | Where a reporter watches one capability, it becomes a companion of that capability through a `defineRootSlot` on its owner, the way sprites belong to `ui.icons`. Example: `endpoint-errors` watches the endpoint client, so it ships wherever endpoints do. Reporters that only serve the self-improvement loop go into the `self-improvement` pack next to `reports.crash`. Each one is judged on what it watches. |
| `primitives.command-palette` | an opt-in feature → a pack (`app-chrome`, or its own) |
| `shell.global-action-bar` | opt-in: an app must be releasable without it → `app-chrome` (the chrome pack, extended by nothing served today). Not a companion of `shell.action-bar`. Its absence must render cleanly: an app without it shows no action strip, with no error and no empty gap. The website and sonata screenshots verify this. |
| `debug.render-profiler`, `debug.live-state-churn.emit` | debug instrumentation → a `diagnostics` pack |

The bundle diff (Verification §3) lists every addition. Each one is reviewed before
the push.

### 3. Runtime: a companion manifest, checked at the slot layer

The build already knows, repo-wide, which plugin provides each companion. Ship that
knowledge so the runtime can tell **"no provider exists"** (a legitimate fallback) from
**"a provider exists but this bundle lacks it"** (a closure bug, which must be loud).

- **Codegen** `companions.generated.ts` (web-sdk `core/`, committed, composition-independent, so it stays byte-stable for `plugins-registry-in-sync`):
  ```ts
  export const companionManifest = {
    unkeyed: { "<slotId>": ["ui.icons.sprites", …] },
    keyed:   { "<slotId>": { date: "fields.date.table", map: "primitives.data-view.map", … } },
  };
  ```
  It is built from the contributions facet's static companions, which are the same data
  `classifyEdges` uses, so the two cannot disagree. It sits next to `reorderable-slots-gen.ts`
  and `icon-manifest-gen.ts`.
- **Unkeyed: one generic assert in web-sdk, no per-site code.** Once the deferred tier
  has settled, for every loaded slot with `meta.companions === true`, each plugin the
  manifest names must have contributed. `useRawContributions` already stamps
  `_pluginId`. If one is missing, throw `MissingCompanionError("ui.icons needs
  ui.icons.sprites, which composition <id> does not ship")` from an effect. The crash
  collector reports it when it is present, and the console always shows it. This one
  assert covers sprites, the icon bridge, fonts, reorder, error-boundary and node types.
- **Keyed: one generic lookup, owned by the slot.** Add `slot.resolve(key | chain)` on
  slots whose `meta.companions` is keyed (web-sdk core). It returns
  `{kind:"found", c} | {kind:"missing", provider} | {kind:"none"}`. Walking a chain, a
  key the manifest assigns to a provider that isn't registered stops the walk as
  `missing`. Only a key with no provider anywhere falls through to the next ancestor.
  - The six DataView resolvers collapse onto it. This deletes the copy-pasted
    `resolveTypeChain` walk.
  - `missing` throws `MissingCompanionError` from render, inside the cell or view
    `PluginErrorBoundary`, so you see a crash card in place instead of text. This
    follows the `MissingDataCellError` precedent in `field-cell.tsx`.
  - `none` keeps today's fallback (text, identity codec, …).
  - `buildInstanceFromRow` stops filtering: an orphan view row becomes a placeholder
    instance that throws inside its boundary.
  - The reorder node-type miss goes through the same `missing` path.
- **Pending is not missing.** Before the deferred tier settles, a `missing` lookup
  renders pending (the existing loading primitive) and re-renders on settle. It is never
  the fallback and never an error. See CLAUDE.md "Not-known-yet is a state".

### 4. Docs

- `closure/CLAUDE.md`: a section on ambient slots and the dead-end rule.
- The mental-model sub-page: a "Guards" section.
- The track card: tick [Guard]. If the exit criteria hold, record the track as done.
  Otherwise file one follow-up task.

## Critical files

- `plugins/framework/plugins/tooling/plugins/checks/plugins/composition-closure/check/{index.ts,root-mounts-reached.ts}` (new)
- `plugins/framework/plugins/tooling/plugins/codegen/core/` — new `companion-manifest-gen.ts`, wired into the registry gen
- `plugins/framework/plugins/web-sdk/core/{slots.ts,companions.generated.ts,registry.ts}`, `web/context.tsx` (settle-time assert, `resolve`)
- `plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx` (`defineDispatchSlot` gets `resolve`)
- `plugins/primitives/plugins/data-view/web/{cell,cell-editor,filter,value-codec,column-config,grouping}-slot.ts`, `components/field-cell.tsx`
- `plugins/primitives/plugins/data-view/plugins/view-core/web/internal/{resolve-instances.ts,use-views-config.ts}`
- `plugins/reorder/web/internal/list-middleware.tsx`
- `plugins/plugin-meta/plugins/composition/core/{config.ts,config.test.ts}` and the reporter / capability barrels picked in §2

## Verification

1. **Unit.**
   - The check flags a fixture plugin mounted at `Core.Root` with no importer.
   - It passes the same plugin once a pack names it, or once it is a companion.
   - `slot.resolve` gives `found`, `missing`, `none`, and the chain stopping at
     `missing`.
   - The manifest gen is deterministic.
2. **Runtime (jsdom).**
   - A DataView with a date field and no `fields.date.table` registered (but in the
     manifest) shows the crash card.
   - A type with no provider anywhere still renders text.
   - An orphan view row renders its placeholder.
   - A `PluginProvider` without sprites throws `MissingCompanionError` after settle.
3. **Bundle diff.** A one-off `./singularity run` script resolves every composition
   before and after, and prints additions and removals. Expected: only the §2
   decisions. Main is unchanged.
4. `./singularity build`. Green, including the new check, `composition-closure`,
   `companions-visible`, `keys-defined`, `plugins-registry-in-sync`,
   `eager-tier-in-sync` and `plugins-doc-in-sync`.
5. **Served pages.**
   - `screenshot.ts --composition website` and `--composition sonata`: icons draw,
     with no `MissingCompanionError` in the browser log.
   - To check the loud path: temporarily negate `ui.icons.sprites` in a scratch build.
     The assert fires and `unsatisfiedExclusions` reports it. Revert.
   - Also check main at `http://<worktree>.localhost:9000`.

## Outcome (implemented 2026-10-18)

- **Build.** `closure:root-mounts-reached` matches the framework group by name
  (`Core`). Importing web-sdk's barrel from a check would load the companion
  manifest into every CLI process (`cli:codegen-manifests-not-frozen`).
  Today's 22 dead-ends:
  - 15 reporters → a `reporters` subsystem row, which `self-improvement`
    extends.
  - Debug instrumentation → `diagnostics`.
  - Command palette → `root-features`.
  - `shell.global-action-bar` → `app-chrome`. It is opt-in: an app is
    releasable without it.
  - `apps.mail.sync.auto-resume` → a companion of `apps.mail.shell`
    (`Mail.Root = defineRootSlot()`).
  - `copy-source-text` is a new finding. Its marker API lived in `core/`, and a
    web → other-plugin-`core/` import is no closure edge, so its copy handler
    shipped nowhere but main. The markers now live in `web/`, beside the
    handler, and every bundle gains it (+ `dom-selection`).
  - Root-only plugins cannot be pack `selectedContributors`: they
    soft-contribute to nothing a bundle holds. So opt-in rows list them as
    entries.
- **Shared reading.** `collectCompanionSlots` (closure core) is now the one
  reading of the companion facts. `classifyEdges` and the new manifest
  generator both use it. `defineRootSlot()` slots are marked
  `companions: true` in the slots facet.
- **Runtime.**
  - `companions.generated.ts` is a pre-barrel manifest, checked by
    `companions-in-sync`.
  - `missingCompanions(registry)` runs in App.tsx after the deferred tier
    settles and reports `client-missing-companion` (console + report).
  - `useCompanionLookup` is now the one keyed walk. All six DataView resolvers
    use it, and the view switcher's orphan rows go through
    `ViewSourceEntry.onOrphanType`.
  - Deviation: before the tier settles, a missing keyed provider resolves to
    `undefined` (today's fallback), not a pending state. The reader re-renders
    on settle and then throws.
  - Reorder node types are unkeyed companions, so the settle-time check covers
    them. Their `return null` stays for stored types nothing defines.
- **Bundle diff.** Nothing is removed anywhere. Every composition gains
  `copy-source-text` (some also `dom-selection`). The full `agent-manager`
  gains the 15 reporters and nothing beyond them.
- **Verified.**
  - `./singularity build` green, including the new checks.
  - Tests green: web-sdk, closure, composition, facets/slots, data-view
    (incl. the new `missing-companion` jsdom suite), codegen.
  - Two pre-existing `load-tiers.test.ts` failures, unchanged by this work:
    the committed `web-tiers.generated.ts` already has `studio/explorer`
    eager.
  - The deployed app logs no `[companions]` error after the deferred tier
    settles.
- **Follow-up.** Cross-runtime imports (web → `X/core`) are still not closure
  edges. `copy-source-text` was one instance; any other plugin whose `core`
  API depends on its own `web` half has the same gap, and only root mounts
  are caught today.
