# ST6 — Extract the view-instance engine into `data-view/plugins/view-core/`

> Sub-task **ST6** of [`2026-06-15-global-unified-view-switcher.md`](./2026-06-15-global-unified-view-switcher.md).
> Structural / optional. No user-visible behavior change.

## Context

The config-driven **named-view-instance engine** (resolver + config descriptor +
debounced write-back + the editable switcher chrome) was built *inside* the
`data-view` primitive during ST3–ST5, but it was deliberately designed to be
**view-content-agnostic** — it knows only "a view-type has `{type,title,icon,…}`
and an opaque per-instance `options` blob", never `FieldDef`/rows/sort/filter.

The roadmap (ST6) called for extracting it to a standalone
`plugins/primitives/plugins/views/` once a second consumer arrived. We are
revising that: the engine is **still part of data-view's story**, so it should be
extracted into a child sub-plugin **`plugins/primitives/plugins/data-view/plugins/view-core/`**
rather than a top-level sibling primitive. `data-view` then becomes a **consumer**
of `view-core` (parent imports child) instead of its owner. This keeps the engine
inside the data-view umbrella where it's discoverable, while still drawing the
clean "engine vs. render-contract" seam so a future second consumer can depend on
`view-core` directly.

**Outcome:** `view-core` owns the generic instance model; `data-view` owns the
view-type render contract (`DataViewRenderProps`), the field/filter/sort
semantics, and the host that wires the two together. Zero behavior change; the
diff is purely a boundary refactor.

## Constraints (verified)

- **Boundary**: `boundary-config.ts` has a single catch-all `allow("plugin.** -> plugin.**")`
  and discovers plugins from the filesystem tree — a new `view-core/` needs **no**
  boundary edits and is auto-registered by `./equin build`.
- **DAG / no cycle**: parent→child (`data-view` → `view-core`) is allowed. The
  child **must never** import `@plugins/primitives/plugins/data-view/{core,web,server}`.
  There is **no automated guard** for this specific cycle (the wildcard allows it),
  so it is a **review-only invariant** — documented in `view-core/CLAUDE.md` and
  grep-checked as the last step.
- **External API is fixed**: only `defineDataView` (10 consumer call sites) and
  `DataViewSlots` (20 `fields/**` plugins) are imported externally, both from
  `data-view/web`. They **stay in data-view**. Every other symbol (`ViewInstance`,
  `DataViewId`, `viewsDescriptor`, `DataViewContribution`, `SortState`,
  `ViewState`) has **zero external importers** → free to move/drop.
- **Manifest stays put**: `data-view/shared/data-views.generated.ts` and the
  `defineDataView` marker stay in `data-view`. The codegen scrapes the literal
  `defineDataView(` string repo-wide and the manifest path is hardcoded in
  `data-views-gen.ts` + the `data-views-in-sync` check — so moving it would cost
  three tooling edits for no benefit. Instead, `view-core` is **parameterized by
  the id list**: data-view passes `dataViews.map(v => v.id)` in.

## The seam

`view-core` treats each instance's `options` as an **opaque `VariantValue`** and
never names `sort`/`filter`. data-view layers those on top — they are just keys
inside the variant value (which is exactly how they're already stored).

| Concern | Owner |
|---|---|
| Instance model `{id,name,type,options}`, resolver, config engine, debounced write-back, add/rename/duplicate/delete/reorder | **view-core** |
| Config descriptor (`viewsDescriptor`) + per-id web/server registration helpers | **view-core** |
| Active-instance selection (`:active-view` localStorage) + `defaultView` resolution | **view-core** |
| Editable switcher chrome + settings popover + variant bridge | **view-core** |
| View-type **render contract** (`DataViewSlots.View`, `DataViewContribution.component`, `DataViewRenderProps`) | data-view |
| `FieldDef`, filter types, `SortState`, `FilterGroup`, `ViewState` | data-view |
| `defineDataView`/`DataViewId` marker + the generated manifest | data-view |
| `sort`/`filter` derivation (null→asc→desc cycle), `ViewState` assembly, query/expand ephemeral (`:view-state`) | data-view |

## New plugin: `plugins/primitives/plugins/data-view/plugins/view-core/`

**`core/`** — pure types (browser-safe; imports only `fields/core`, `variant/core` types):
- `core/internal/types.ts`: `ViewTypeMeta` (`{type,title,icon,order?,hierarchical?,configSchema?}`),
  `ViewInstance` (`{id,name,type,options}`), `ViewConfigRow` (`{id,rank,name,view:VariantValue}`),
  `AddableViewType`.
- `core/index.ts`: re-export the above.

**`shared/`** — server-safe:
- `shared/internal/views-descriptor.ts`: `viewsDescriptor(id): ConfigDescriptor`
  (moved verbatim from `data-view/shared/views-config.ts` — already fully generic).
- `shared/index.ts`: `export { viewsDescriptor }`.

**`web/`**:
- `internal/resolve-instances.ts`: `ResolvedViewInstance<T extends ViewTypeMeta>`
  (`{instance:ViewInstance, viewType:SealContributions<T>}`), generic
  `useResolvedInstances<T>` / `buildInstanceFromRow<T>` (bodies unchanged; just
  `DataViewContribution` → `T extends ViewTypeMeta` and import `ViewInstance` from `../../core`).
- `internal/build-descriptors.ts`: `buildViewDescriptors(ids: string[])` →
  `{ map: Map<string,ConfigDescriptor>, entries: {id,descriptor}[] }`. Generic
  replacement for today's manifest-coupled `descriptors.ts`.
- `internal/use-views-config.ts`: the **generic opaque-options engine**. Keeps the
  optimistic-mirror / 400ms-debounce / deterministic-seed / Rank machinery
  verbatim. **Removes** `setSort`/`setFilter`/`sortFor`/`filterFor` and the
  `SortState`/`FilterGroup` imports. Exposes `viewFor(id): VariantValue | undefined`
  (reads **raw `row.view`**, not merged options — see Gotchas) and
  `updateView(id, view, opts?: {merge?: boolean})` plus add/rename/duplicate/delete/reorder.
  Takes `descriptorMap` as a param.
- `internal/use-active-view.ts`: `useActiveViewId(storageKey)` → `{activeViewId, setActiveView}`
  (the `:active-view` localStorage half of today's `use-view-state.ts`).
- `internal/use-view-model.ts`: generic `useViewModel<T>` → `ViewModelCore<T>`
  `{instances, activeId, setActiveView, viewFor, updateView, actions, available}`.
  Owns `resolveActiveId` (persisted → `defaultView` → first) and the `available`
  capability gate.
- `internal/use-view-variants.ts`: `useViewVariants(contributions: T[])` — takes
  contributions **as a param** (drops the `DataViewSlots.View` import).
- `internal/config-registrations.ts`: `buildViewConfigContributions(entries, pluginId)`
  helper (pluginId stays caller-supplied → `primitives.data-view`).
- `components/editable-view-switcher.tsx`, `components/view-settings-popover.tsx`:
  generic over `ResolvedViewInstance<T>` (shapes unchanged). The settings popover's
  save calls `actions.updateView(id, v, {merge: true})`.
- `web/index.ts`: barrel exporting the generic engine; plugin default with `contributions: []`.

**`server/`**:
- `internal/config-registrations.ts`: `buildViewConfigRegistrations(ids, pluginId)` helper.
- `server/index.ts`: `export { viewsDescriptor }` + the helper; `contributions: []`.

### view-core barrel API

- `view-core/core`: `ViewTypeMeta`, `ViewInstance`, `ViewConfigRow`, `AddableViewType` (types).
- `view-core/shared` / `view-core/server`: `viewsDescriptor`; `buildViewConfigRegistrations` (server).
- `view-core/web`: `useResolvedInstances`, `buildInstanceFromRow`, `ResolvedViewInstance`,
  `useViewModel`, `ViewModelCore`, `ViewActionsCore`, `useActiveViewId`, `useViewVariants`,
  `buildViewDescriptors`, `buildViewConfigContributions`, `EditableViewSwitcher`, `ViewSettingsPopover`.

`updateView` appears both top-level and inside `actions` to keep the existing
switcher/popover `ViewActions` shape unchanged.

## Changes in `data-view/`

- `web/slots.ts`: `DataViewContribution extends ViewTypeMeta & { component: ComponentType<DataViewRenderProps<unknown>> }`
  (import `ViewTypeMeta` from `view-core/core`); the five own meta fields collapse into the spread.
- `core/internal/types.ts`: **remove** `ViewInstance` (now in view-core). **Drop**
  it from `core/index.ts` + `web/index.ts` barrels (zero external importers — no
  re-export needed).
- `web/internal/use-data-view-model.ts` — **NEW** wrapper hook. Wraps view-core's
  `useViewModel`, layers `sortFor`/`filterFor`/`setSort`(null→asc→desc cycle)/`setFilter`
  through `viewFor`+`updateView({merge:true})`, assembles `ViewState`
  (config sort/filter + ephemeral query/expand), and **repacks into the exact
  existing `ViewModel` shape** so `data-view.tsx` render logic is untouched.
- `web/internal/use-view-ephemeral.ts` — **NEW** query/expand localStorage hook
  (`:view-state`), split out of `use-view-state.ts` (keeps the legacy-blob tolerance).
- `web/internal/descriptors.ts`: shim — `buildViewDescriptors(dataViews.map(v => v.id))`
  (still imports the manifest from `data-view/shared`).
- `web/internal/config-registrations.ts` / `server/internal/config-registrations.ts`:
  call the view-core helpers with `dataViews` ids + `primitives.data-view` pluginId.
- `shared/views-config.ts`: **deleted**; internal importers point at `view-core/shared`.
  Drop the `viewsDescriptor` re-export from both data-view barrels (zero external importers).
- `web/components/data-view.tsx`: swap `useConfigViewModel` → `useDataViewModel`;
  `useViewVariants()` → `useViewVariants(contributions)`; import
  `EditableViewSwitcher`/`ViewSettingsPopover`/`ResolvedViewInstance` from `view-core/web`.
- **Deleted** (moved to view-core): `web/internal/resolve-instances.ts`,
  `use-views-config.ts`, `use-view-model.ts`, `use-view-variants.ts`,
  `components/editable-view-switcher.tsx`, `components/view-settings-popover.tsx`.
  `use-view-state.ts` is split (active-id → view-core, query/expand → data-view), then deleted.

## Implementation sequence (dependency-ordered)

1. Scaffold `view-core/{core,web,server,shared}` barrels (empty `contributions: []` defaults) + `view-core/CLAUDE.md` stub stating the no-import-data-view invariant. `./equin build` once → confirm zero boundary errors.
2. Move pure types → `view-core/core`; add `DataViewContribution extends ViewTypeMeta` in `data-view/web/slots.ts`; drop `ViewInstance` from data-view barrels.
3. Move `viewsDescriptor` → `view-core/shared`; repoint data-view's internal importers; delete `data-view/shared/views-config.ts` + barrel re-exports.
4. Move + genericize `resolve-instances.ts` (`<T extends ViewTypeMeta>`).
5. Add `buildViewDescriptors` + config-registration helpers; rewrite data-view's `descriptors.ts` / `config-registrations.ts` (web+server) as shims.
6. Genericize `use-views-config.ts` (strip sort/filter; add `viewFor` + `updateView({merge})`; `descriptorMap` param).
7. Split `use-view-state.ts`: `useActiveViewId` → view-core, `useViewEphemeral` → data-view.
8. Move `use-view-model.ts` → generic `useViewModel<T>` (owns `resolveActiveId`, `available`, active-id).
9. Genericize `use-view-variants.ts` (contributions param).
10. Move switcher + settings popover → view-core (generic over `T`; popover uses `{merge:true}`).
11. Write data-view's `useDataViewModel` wrapper (cycle + `stateFor` + `setSort`/`setFilter` + ephemeral, repacked into the existing `ViewModel`).
12. Rewire `data-view.tsx`.
13. `./equin build` + `./equin check`; regenerate both CLAUDE.md docs.
14. Update the roadmap doc (see below).

## Seam resolutions

- **`updateView` preserve-on-save**: generic merge `{...prev, ...view}` preserves
  any host-injected key (sort/filter/future) — strictly more correct than today's
  named `sort`/`filter` re-injection. The variant sub-form always carries `type`,
  so a type change overwrites `type` + options keys; stale old-type keys linger
  inert (same as today). The settings popover passes `{merge: true}`.
- **`viewFor` reads raw `row.view`** (not the merged `instance.options`) so writes
  never persist code-only `viewOptions` keys (e.g. gallery's `renderCard`) into the
  config row. Matches today's `mergeView` reading `r.view`. For a not-yet-materialized
  default it returns the seed `{type}` so the merge spread always has a `type`.
- **Ephemeral split**: active-id is *model* state → view-core; query/expand is
  *render* state → data-view. Natural fault line, lower churn than threading
  active-id through params.

## Roadmap doc update (`2026-06-15-global-unified-view-switcher.md`)

- **"Where Layer 2 lives"** paragraph: replace "Extract to a standalone
  `plugins/primitives/plugins/views/` only when the second consumer (tasks)
  arrives — ST6." with the revised decision — extract into the child sub-plugin
  `plugins/primitives/plugins/data-view/plugins/view-core/`, with data-view as the
  consumer, regardless of a second consumer (it's a clean internal seam, not a
  shared-primitive promotion).
- **ST6 table row**: retitle to "Extract `data-view/plugins/view-core/`. Move the
  type-agnostic instance engine + config-descriptor machinery into a data-view
  child sub-plugin; data-view becomes a consumer." Keep `ST5` dep / Optional tier.
- **ST7 row**: note tasks consume `view-core` via data-view (no change to the
  consumer model — tasks still use `<DataView>`); a future *direct* `view-core`
  consumer remains possible but is not required by ST6.

## Verification

- `./equin build` succeeds; `data-views.generated.ts` unchanged (manifest
  didn't move; marker untouched).
- `./equin check` green — specifically `type-check`, `plugin-boundaries`,
  `data-views-in-sync`, `plugins-registry-in-sync`, `plugins-doc-in-sync`.
- `rg "data-view/(core|web|server)" plugins/primitives/plugins/data-view/plugins/view-core` returns **nothing** (cycle invariant holds).
- In-app smoke (Playwright) on `http://<worktree>.localhost:9000` against the only
  multi-view consumer (`sonata.library`) + one single-view consumer (e.g.
  `/agents`): switcher renders, add/rename/duplicate/reorder/delete an instance
  persists to its `config/primitives/data-view/<id>.jsonc` and survives reload,
  sort/filter on a named instance write back to its `options`, active-id stays
  device-local. Confirm gallery `coverField` options sub-form still works (variant
  bridge intact).
- Existing per-view jsdom tests (`plugins/.../{gallery,table,list}/web/__tests__/inline-edit.test.tsx`)
  still pass via `bun run test:dom plugins/primitives/plugins/data-view`.

## Critical files

- `plugins/primitives/plugins/data-view/web/internal/use-views-config.ts` (genericize)
- `plugins/primitives/plugins/data-view/web/internal/use-view-model.ts` (genericize + new wrapper)
- `plugins/primitives/plugins/data-view/web/components/data-view.tsx` (rewire)
- `plugins/primitives/plugins/data-view/web/slots.ts` (`extends ViewTypeMeta`)
- `plugins/primitives/plugins/data-view/web/internal/descriptors.ts` (shim)
- `plugins/primitives/plugins/data-view/shared/views-config.ts` (move → view-core/shared)
- `research/2026-06-15-global-unified-view-switcher.md` (roadmap update)
