# ST4 — Named-instance resolver + switcher actions + state split

> Sub-task **ST4** of [`2026-06-15-global-unified-view-switcher.md`](./2026-06-15-global-unified-view-switcher.md).
> ST1 (chrome), ST2 (view-type registry), ST3 (config-driven instance storage) have landed.

## Context

After ST3, `data-view` has the *storage* for Notion-style named view-instances — a per-`storageKey`
`viewsDescriptor` (`listField` of `{ id, rank, name, view:{ type, ...options } }`, `scope:"app"`,
`promotableToGit`), registered today only by `sonata:library` with a committed
`config/apps/sonata/library/views.jsonc`. But nothing **reads** that config: `useResolvedInstances`
still synthesizes one default instance per registered view-type (`id === type`), and there is no way
to add / rename / duplicate / delete / reorder instances, nor to edit a view's options. Meanwhile
durable per-view sort/filter + active-id live in a *separate* global `viewStateDescriptor`
(`view-state` config) — a parallel durable system that overlaps the instance model.

**ST4 closes the loop:** turn config → ordered instances → active instance → seeded sort/filter →
rendered view → debounced config write-back; add the in-switcher instance actions; and collapse the
state model so the instance's config row is the single home for its durable state, with active-id /
query / expand demoted to device-local. The user-confirmed UX: pristine drag-reorderable chips, a
trailing `+` to add, and **click-the-active-chip** to open its settings menu (rename / duplicate /
delete + the type-dispatched options sub-form).

## State model (the split)

| State | Lives in | Notes |
|---|---|---|
| Instance def `{id,rank,name,view:{type,sort?,filter?,...opts}}` | **`viewsDescriptor` config row** (app-scoped) | The instance. Nameable, reorderable, git-promotable, agent-editable. |
| Active instance id | **localStorage** `${storageKey}:active-view` | Per-device selection. |
| Search query, tree expand map | **localStorage** `${storageKey}:view-state` | Already device-local. |
| sort/filter for a **default** (unregistered/empty-config) instance | **localStorage** `${storageKey}:view-state` | Fallback only — no config row exists to write to. |

**Consequence:** the global `viewStateDescriptor` (`view-state` config) is **removed**. Its job splits
into the per-instance config row (durable, config-mode) and localStorage (ephemeral). This eliminates
the parallel durable system the roadmap flagged. ST3 only just landed in this worktree, so no real
user state needs migrating back; the slim hook simply reads the localStorage blob directly.

## Architecture

Two modes, chosen once per mount by whether the consumer registered `viewsDescriptor(storageKey)`:

- **Default mode** (6 of 7 consumers — no registration): today's behavior. Synthesized default
  instances, ephemeral state, **no** instance actions. The pure read-only `ViewSwitcher` chrome.
- **Config mode** (registered — `sonata:library` today): config-authored instances, sort/filter
  write-back to the instance row, full instance actions, the editable switcher.

Registration is detected at runtime via `useConfigRegistrations()` matching the **reference-stable**
`viewsDescriptor(storageKey)` singleton (cached by key in `shared/views-config.ts`) — `reg.descriptor === descriptor`.
The branch is stable across the mount, so `DataView` selects a wrapper component (config vs default)
that each compute a unified `ViewModel`; only the config wrapper calls `useConfig(viewsDescriptor…)`,
keeping the conditional `useConfig` call legal.

```
DataView(props)
  isRegistered = useConfigRegistrations().some(r => r.descriptor === viewsDescriptor(storageKey))
  └─ isRegistered ? <ConfigDataView/> : <DefaultDataView/>
        each builds a ViewModel, then renders <DataViewInner viewModel=… {...props}/>
```

```ts
// web/internal/use-view-model.ts (new)
interface ViewModel {
  instances: ResolvedViewInstance[];
  activeId: string;
  setActiveView(id: string): void;
  stateFor(id: string): ViewState;             // sort/filter from config (config-mode) or localStorage (default)
  setSort(id: string, fieldId: string): void;
  setFilter(id: string, filter: FilterGroup | null): void;
  setQuery(id: string, q: string): void;        // always localStorage
  setExpanded(id: string, k: string, v: boolean): void; // always localStorage
  actions: ViewActions | null;                  // null in default mode
}
interface ViewActions {
  available: { type: string; title: string; icon }[];  // capability-gated add menu
  addView(type: string): void;
  renameView(id: string, name: string): void;
  duplicateView(id: string): void;
  deleteView(id: string): void;
  reorderView(id: string, toIndex: number): void;       // recomputes `rank` via Rank.between
  updateView(id: string, view: VariantValue): void;      // options sub-form onChange (preserves sort/filter)
}
```

### Hooks / files

- **`web/internal/use-view-state.ts`** → slim to **localStorage-only** `useEphemeralViewState(storageKey)`:
  active-id + per-instance `{ query, expanded, sort, filter }`. Drop all `useConfig`/`useSetConfig`/
  `viewStateDescriptor` usage and the config↔localStorage migration. Both modes use it for
  active-id/query/expand; default mode also uses its sort/filter.
- **`web/internal/use-views-config.ts`** (new) — config-mode engine:
  - read `useConfig(viewsDescriptor(storageKey), { scopeId })`; `views = cfg.views ?? []`.
  - **optimistic mirror + debounced (400ms) `setConfig("views", next)`**, mirroring the proven
    pendingRef/timerRef/flush/scheduleWrite/flush-on-unmount pattern already in `use-view-state.ts`.
  - **materialize-on-first-edit**: when the config list is empty, *display* synthesized defaults; the
    first mutating action seeds the list with those defaults, then applies the mutation (mirrors
    reorder's "unlisted live contributions append, materialize on first edit").
  - mutation helpers (add/rename/duplicate/delete/reorder/updateView/setSort/setFilter); ordering via
    `Rank.between` from `@plugins/primitives/plugins/rank/*` (the same util the list-field renderer uses).
  - `setSort`/`setFilter` write `view.sort` / `view.filter` on the active instance's row (merge,
    preserving the options sub-form keys).
- **`web/internal/resolve-instances.ts`** — keep `useResolvedInstances` (default synthesis), and add a
  pure `buildInstanceFromRow(row, contributions, viewOptions)` reused by config mode. Config mode maps
  rows → `ResolvedViewInstance[]` (look up contribution by `view.type`, sort by `rank`, **fail-soft
  skip** rows whose type isn't registered or whose hierarchical type lacks a hierarchy — document the
  orphan hazard, same as reorder type ids).
- **`web/internal/use-view-variants.ts`** (new) — the **view-type → variant registry** bridge:
  `useViewVariants(): Map<string, VariantEntry>` from `DataViewSlots.View.useContributions()`
  (`[type, { label: title, fields: configSchema ?? {} }]`). Generic — iterates contributions, never
  names a view child (collection-consumer separation).

### Switcher actions UI (config mode)

- **`web/components/editable-view-switcher.tsx`** (new) — replaces the pure chrome when `actions != null`:
  - drag-reorderable chips (`SortableList`/`SortableItem` + `ToggleChip`, matching the
    `SegmentedControl` ghost look so chrome stays identical) → `reorderView`.
  - click an inactive chip → `setActiveView`; click the **active** chip → open its settings popover.
  - trailing `[ + ]` `IconButton` → menu of `actions.available` types → `addView`.
  - Default mode keeps the existing pure `ViewSwitcher` chrome (read-only).
- **`web/components/view-settings-popover.tsx`** (new) — opened from the active chip. Renders:
  - **Name** — text field (`FieldRenderer` over a `textField`, or `RenameInput`) → `renameView`.
  - **Options sub-form** — `<FieldRenderer field={viewField} value={instance.view} onChange={v => updateView(id, v)}/>`
    where `viewField = variantField({ useVariants: () => viewVariants })` built **web-side at render**
    (the stored descriptor stays server-safe). `VariantRenderer` already gives the type selector +
    type-dispatched `configSchema` sub-fields — this is the "include options sub-form now" piece, for
    free from the config field-render pipeline. sort/filter are **not** in `configSchema` (managed by
    the toolbar); `updateView`'s `{...view, [k]:v}` merge preserves them.
  - **Duplicate** / **Delete** buttons → `duplicateView` / `deleteView`.
- **Demonstrator `configSchema`**: add a minimal real `configSchema` to one view-type (gallery —
  e.g. a `coverField` enum over the source's media/text fields) and have the gallery read
  `options.coverField`, so the sub-form renders a real control end-to-end. Without this, every current
  view-type's sub-form is empty and untestable.

### Per-app scope

`DataView` reads `useCurrentAppId()` (`@plugins/apps/web`); `scopeId = appId ? appScopeId(appId) : undefined`
(`appScopeId` from `@plugins/config_v2/core`) passed to `useConfig`/`useSetConfig`. `viewsDescriptor`
is already `scope:"app"`.

### Origin / `@hash` safety

Actions are enabled **only** in config mode (registered) — and a registered `ConfigV2.Register`
already makes `./equin build` emit the origin (that's how `sonata/library/views.jsonc` got its
`@hash`). So `setConfig` always has an origin to base on; **never** `setConfig` in default mode. No new
build manifest is needed — ST3's manual per-consumer `ConfigV2.WebRegister`/`Register` + existing
origin codegen suffice. When a view-type's `configSchema` changes the origin hash under a committed
instance set, `config-origins-in-sync` fails by design — re-run build and re-stamp the `@hash`.

## Files

**Change**
- `plugins/primitives/plugins/data-view/web/internal/use-view-state.ts` — slim to localStorage-only.
- `plugins/primitives/plugins/data-view/web/internal/resolve-instances.ts` — add `buildInstanceFromRow`.
- `plugins/primitives/plugins/data-view/web/components/data-view.tsx` — split into `DataView`
  (mode branch) + `DataViewInner(viewModel)`.
- `plugins/primitives/plugins/data-view/web/index.ts` + `server/index.ts` — drop the
  `viewStateDescriptor` `ConfigV2.WebRegister`/`Register`.
- `plugins/primitives/plugins/data-view/CLAUDE.md` — document the state split, modes, and orphan hazard.
- A gallery view-type child — add `configSchema` + consume `options.coverField`.

**New**
- `web/internal/use-views-config.ts`, `web/internal/use-view-model.ts`, `web/internal/use-view-variants.ts`
- `web/components/editable-view-switcher.tsx`, `web/components/view-settings-popover.tsx`

**Remove**
- `plugins/primitives/plugins/data-view/shared/view-state-config.ts`
- any committed `config/**/view-state.jsonc` origin (`rg --files -g 'view-state.jsonc' config/`).

**Reused (do not reinvent)**
- Debounced optimistic write-back pattern — `use-view-state.ts` (current).
- `useConfig`/`useSetConfig`/`useConfigRegistrations`/`appScopeId` — `@plugins/config_v2/{web,core}`.
- `FieldRenderer`/`FieldHeader`/`VariantRenderer` type-dispatch — `@plugins/config_v2/plugins/fields/web`
  + `@plugins/fields/plugins/variant/plugins/config/{core,web}` (`variantField`, `VariantEntry`).
- `SortableList`/`SortableItem`, `ToggleChip`/`SegmentedControl`, `Popover`, `IconButton`,
  `DropdownMenu`, `RenameInput`, `Rank.between`.

## Verification

1. `./equin build` (regen origins + autogen doc block; `config-origins-in-sync`,
   `plugins-doc-in-sync`, `type-check` green) → `./equin check`.
2. Playwright on `http://<worktree>.localhost:9000` at a `sonata:library` DataView:
   - chips render `Cards` / `All` borderless ghost; **add** a view via `+` (pick a type) → new chip;
     verify `config/apps/sonata/library/views.jsonc` gains a row (and `@hash` re-stamped) on disk.
   - **drag** to reorder → new order persists across reload (rank rewritten in the file).
   - click the **active** chip → settings popover: **rename**, **duplicate**, **delete**, and the
     **options sub-form** (gallery `coverField`) — each round-trips to the config file and survives reload.
   - change **sort** (table column) / **filter** on a named instance → writes `view.sort`/`view.filter`
     in that row; reload persists.
   - **active-id is per-device**: a second browser profile shows the same instances but its own active chip.
3. Default-mode regression: the 6 single-view consumers (deploy/home/story/agents/tasks/pages) load
   unchanged — no switcher actions, sort still works via localStorage; no `setConfig` is issued.

## Risks / decisions

- **Removing `viewStateDescriptor`** is the boldest change (collapses the parallel durable system).
  Reversible; chosen per the roadmap's "demote to ephemeral-only / active-id browser-local" and to
  avoid two overlapping durable stores. Default-instance sort/filter reverts to localStorage (its
  pre-ST3 home) — acceptable for single-view consumers.
- **Conditional `useConfig`** is made legal by the stable mode-branch component split, not a runtime
  toggle.
- **Orphan instances** (config row referencing a renamed/removed view-type) fail-soft skip — same
  documented hazard as reorder node-type ids.
</content>
</invoke>
