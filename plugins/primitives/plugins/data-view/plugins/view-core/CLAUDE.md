# view-core

The **type-agnostic named-view-instance engine** extracted out of the `data-view`
primitive. It owns the generic instance model (`{ id, name, type, options }`), the
config-descriptor machinery (`viewsDescriptor`), the resolver, the
optimistic-mirror / debounced write-back engine, the active-id selection, and the
editable view-switcher chrome. `data-view` is a **consumer**: it layers the
view-content semantics (`FieldDef`/rows/sort/filter, the `DataViewRenderProps`
render contract) on top.

## Config is the single source of truth

There is **no code synthesis** of default view-instances. `useViewsConfig` reads
the authored `config.views` rows **only** — an empty config means **no
instances** (the consumer renders a placeholder). It reads them through
`useConfigResult` (not `useConfig`) and exposes **`ready`**: while the config document has
not arrived, zero instances means "we don't know", not "there are none", and the consumer
must render a loading state instead of an empty-state claim. Authored rows may be **terse**
(`{ name, view }`): `normalizeRows` derives `id` (explicit `id` ?? slug(name) ??
`view-${index}`) and `rank` (explicit ?? a generated `Rank.between` sequence
following array order) on read, and the same normalization runs in the reconcile
effect. The first UI edit materializes from the authored rows (or `[]`), never
from code. `buildInstanceFromRow` resolves a row's `view.type` → renderer (and
powers the add-view menu); `useResolvedInstances` (the old default-synthesis
resolver) was removed.

**Author an explicit `id` on every view row** (bare slug, e.g. `{ "id": "all",
"name": "All", … }`). The `config-stable-list-ids` check enforces this repo-wide:
a view instance's `id` keys the durable `data_view_row_order` rows, so an omitted
id — filled in as a content-derived `auto-<hash>` — would silently change on
rename/filter-edit/reinsert and orphan the user's saved per-view row order.

Each per-id descriptor is registered under the **consuming plugin's** tree: the
consumer passes a per-entry `pluginId` to `buildViewConfigContributions` (web) /
`buildViewConfigRegistrations` (server), so config_v2 derives
`config/<asPath(pluginId)>/<id>.jsonc`.

## The seam

The engine treats each instance's `options` as an **opaque `VariantValue`** and
**never names `sort`/`filter`** (or any other host concern). A consumer layers
those on as keys inside the variant value:

- `viewFor(id)` returns the **raw** `view` value off the (normalized) config row
  (the variant blob `{ type, ...opts }`), not the merged code+config options — so a
  host write never persists code-only `viewOptions` keys. `undefined` only for an
  unknown id; an authored row always carries a `type`, so a merge spread always
  carries a `type`.
- `updateView(id, view, { merge: true })` shallow-merges `{ ...prev, ...view }`,
  preserving any host-injected key the caller didn't carry (sort/filter/future).

The host (data-view's `useDataViewModel`) wraps `useViewModel` and re-derives
`sortFor`/`filterFor`/`setSort`/`setFilter` through `viewFor` + `updateView`.

### Generic `extraFields` extension point (does NOT breach the seam)

`viewsDescriptor(id, extraFields?)` accepts an optional `FieldsRecord` of
consumer-owned **sibling config fields**, merged next to `views` in the per-id
config doc. It is the seam-safe way for a consumer to persist additional keys in
the same git-committable, per-app-scopable config file —
`buildViewDescriptors(ids, extraFields?)` (web) and
`buildViewConfigRegistrations(entries, extraFields?)` (server) thread it through.

The engine **never names or reads** these fields — they are opaque storage. The
consumer declares the field def AND reads it back itself (via its own
`useConfig(descriptor)`), so the invariant "view-core never names
`sort`/`filter`/any host concern" still holds: the engine knows nothing about
*what* the extra field means. data-view's saved **sort presets** are the worked
example — data-view declares `sortPresets` (a nested `listField`) in
`shared/sort-presets-field.ts`, injects it here, and reads it through its own
`useSortPresets` hook. Pass a **stable module-constant** `extraFields` per runtime
(one per consumer): the per-id descriptor cache keys by id alone, so a varying
field set per id would alias.

## The source axis

A view surface can bind its instances to N **sources**. The engine stays
type-agnostic about what a source *is*: a config row's optional `source` key is
an **opaque lookup key** resolved through the caller-supplied
`ViewSourceEntry[]` list (core type). Each entry carries what used to be the
flat `(contributions, hasHierarchy, viewOptions)` triple, plus `id` (matched
against `row.source`; `undefined` = the implicit sole source — every
single-source consumer passes exactly one such entry), `title`/`icon` (add-menu
group chrome), and the `views` whitelist.

- **Row model.** `ViewConfigRow` / `ViewInstance` carry `source?: string`.
  `normalizeRows` (own module, `web/internal/normalize-rows.ts`) preserves it
  via **conditional spread**, so a source-less row's JSON stays byte-identical
  (`{ id, name, view }`, no `source` key) — the JSON-identity reconcile in
  `useViewsConfig` depends on that. Every mutator preserves it (`{...r}`
  spreads; `duplicateView` copies it explicitly; `addView(type, sourceId?)`
  stamps it on the seed row and resolves the seed title from that source's own
  contributions). Locked by tests (`normalize-rows.test.ts`,
  `web/__tests__/use-views-config.test.tsx`).
- **`source` is NOT declared in the descriptor's `itemFields`** — deliberately.
  The `views` listField item schema is `.passthrough()`, so the key survives
  the read path as-is; a declared *defaulted* field would be healed onto every
  existing row of every surface as `source: ""` (mass config diff, and `""` ≠
  absent). Consequence: the Settings-pane FieldRenderer shows no `source`
  editor — it is stamped by `addView`, never hand-edited there.
- **Resolution.** `buildInstanceFromRow(row, entries)` finds the entry by
  `row.source` (both possibly `undefined`); **no entry → fail-soft `null`**
  (the row stays in config, skipped — mirroring the orphan view-type hazard),
  then the usual type lookup / hierarchical gate / options merge run against
  that entry's own `contributions` / `hasHierarchy` / `viewOptions`.
- **`views` whitelist gates addability, not authored rows.** The per-entry
  whitelist filters that entry's add-menu group (`AddableSource.types`) only;
  `buildInstanceFromRow` deliberately ignores it, so an authored row of a
  non-whitelisted type still renders — the exact single-source semantics the
  flat `views` prop always had.
- **Grouped add menu.** `ViewActionsCore.availableSources: AddableSource[]`
  (one group per entry) replaces the flat `available`; `addView(type,
  sourceId?)`. `EditableViewSwitcher` renders one `DropdownMenuSection` per
  source (label = source title — a groupless label would crash the menu), with
  a byte-identical flat-item fast path when there is exactly one untitled
  source.
- **The settings popover's type picker is per-instance, and shares the add
  menu's gate.** `usableTypes(entry)` (`web/internal/usable-types.ts`) is the ONE
  gate — contributions ∩ `views` whitelist ∩ the hierarchical gate — read by both
  `availableSources` (the `+` menu) and `actions.variantsFor(id)` (the popover's
  `variantField` registry). They used to disagree: a global
  `useViewVariants(contributions)` handed the popover every registered view-type,
  so a flat surface could not *create* a tree view but could *switch* one into a
  tree — and `buildInstanceFromRow` then dropped that row, silently emptying the
  switcher of a view whose config row was still on disk. `useViewVariants` is
  **deleted**, not merely bypassed, so no ungated map is left to hand the popover.
  `variantsFor` always lists the instance's OWN current type even when the
  whitelist excludes it (the whitelist gates addability, not authored rows), so
  the picker can render the value it is bound to.

## ⚠️ Invariant: never import data-view (no cycle)

`view-core` is a **child** of `data-view`, so `data-view → view-core` is the only
legal direction. `view-core` **MUST NEVER** import
`@plugins/primitives/plugins/data-view/{core,web,server}` — that would close a
parent↔child cycle. The boundary checker's catch-all `plugin.** -> plugin.**`
does **not** catch this specific cycle, so it is a **review-only invariant**.
Grep-check it:

```
rg "data-view/(core|web|server)" plugins/primitives/plugins/data-view/plugins/view-core
```

must return **nothing**. The engine must stay genuinely generic — parameterized
by the consumer's id list (`buildViewDescriptors(ids)`), the per-entry
contributions each surface passes in, and per-entry plugin id
(`buildViewConfigContributions(entries)` where each entry carries its own
`pluginId`), never reaching back into data-view.

## Barrel API

- `core`: `ViewTypeMeta`, `ViewInstance`, `ViewConfigRow`, `ViewSourceEntry`,
  `AddableViewType`, `AddableSource` (types).
- `shared`: `viewsDescriptor` (engine-private; reached cross-plugin via the
  `server` re-export or the `web` `buildViewDescriptors` helper, never directly).
- `server`: `viewsDescriptor`,
  `buildViewConfigRegistrations(entries: { id, pluginId }[])`.
- `web`: `buildInstanceFromRow`, `ResolvedViewInstance`, `useViewsConfig`,
  `ViewsConfigHandle`, `useViewModel`, `ViewModelCore`, `ViewActionsCore`,
  `ViewGetter` / `useViewGetter` / `AssertStableGetters` (the per-view getter
  whose result keeps its identity until THAT view's inputs change — minted
  only by `useViewGetter`; `actions.variantsFor` is one, and data-view's
  `ReadyViewModel` getters are too; test fakes brand theirs with
  `fakeViewGetter` from `web/testing`),
  `buildViewDescriptors`,
  `buildViewConfigContributions(entries: { id, descriptor, pluginId }[])`,
  `EditableViewSwitcher`, `CollapsedViewSwitcher` (the same inputs folded
  into one chip — active view icon + name + chevron — whose menu lists the other
  views, an "Add view" submenu and "View settings…", which opens
  `ViewSettingsPopover` anchored to the chip via `ControlPanelPopover`'s
  `anchor` arm; no drag reorder), `AddViewMenuItems` (the add-menu rows both
  switchers share: flat for one untitled source, one section per source
  otherwise), `ViewSettingsPopover` — the last drawn in the
  `control-panel` vocabulary (a sibling primitive; view-core still imports NO
  data-view), so the switcher opens it through `ControlPanelPopover`.
  (The device-local active-id hook
  `useActiveViewId` now lives in the `view-switcher` primitive — `useViewModel`
  imports it from there; it is no longer re-exported here.)

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Type-agnostic named-view-instance engine: instance model + resolver, config-descriptor machinery, debounced write-back, and the editable view-switcher chrome. Type-agnostic named-view-instance engine (server): the per-id `views` config descriptor + a generic registration helper. Consumers register their own ids under their own plugin.
- Web:
  - Contributes: `IdKinds.Kind` "view"
  - Uses: 37 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×13
    - `config_v2` ×3
    - `primitives/css/control-panel` ×2
    - `primitives/hover-reveal` ×2
    - `primitives/live-state` ×2
    - `primitives/sortable-list` ×2
    - `config_v2/fields.FieldRenderer`
    - `ids.IdKinds`
    - `primitives/css/fill.Fill`
    - `primitives/css/grow.growClass`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/row.Row`
    - `primitives/css/spacing.Stack`
    - `primitives/css/toggle-chip.ToggleChip`
    - `primitives/icon-button.IconButton`
    - `primitives/latest-ref.useLatestRef`
    - `primitives/overlay/popup-open.PopupOpenScope`
    - `primitives/view-switcher.useActiveViewId`
    - `ui/icons.Icon`
  - Exports (types):
    - `AssertStableGetters`
    - `ResolvedViewInstance`
    - `ViewActionsCore`
    - `ViewGetter`
    - `ViewModelCore`
    - `ViewsConfigHandle`
  - Exports (values):
    - `AddViewMenuItems`
    - `buildInstanceFromRow`
    - `buildViewConfigContributions`
    - `buildViewDescriptors`
    - `CollapsedViewSwitcher`
    - `EditableViewSwitcher`
    - `useViewGetter`
    - `useViewModel`
    - `useViewsConfig`
    - `ViewSettingsPopover`
- Server:
  - Contributes: `ids.kind` "view"
  - Uses:
    - `config_v2.ConfigV2`
    - `ids.IdKinds`
  - Exports (values):
    - `buildViewConfigRegistrations`
    - `viewsDescriptor`
- Core:
  - Uses:
    - `ids.defineIdKind`
    - `ids.IdOf`
  - Exports (types):
    - `AddableSource`
    - `AddableViewType`
    - `ViewConfigRow`
    - `ViewId`
    - `ViewInstance`
    - `ViewSourceEntry`
    - `ViewTypeMeta`
  - Exports (values): `viewIdKind`
- Cross-plugin:
  - Imported by:
    - `primitives/data-view`
    - `primitives/metrics`
- Shared:
  - Exports (values): `viewsDescriptor`
- Test helpers:
  - Web: `@plugins/primitives/plugins/data-view/plugins/view-core/web/testing`
    - `fakeViewGetter` — Brand a test fake's per-view getter as a `ViewGetter`.

<!-- AUTOGENERATED:END -->
