# Multi-source DataView: one surface, N sources, one unified switcher

## Context

`<DataView>` is mono-source by construction: one `TRow`, one `fields` schema, one data
plumbing (in-memory `rows` XOR server `dataSource`), one `storageKey`/config file.
Surfaces that need two non-mergeable lists hack around it with a tab switcher **above**
two whole DataViews:

- **Conversations sidebar** (`conversations/conversations-view/data-view`): a
  `defineTabbedView` host over the Queue tab (in-memory `QueueRow` + `manualOrder` +
  `aggregate`) and the History tab (server-delegated `Conversation` + keyset
  `dataSource`). Two configs, two one-chip switchers, no unified "+ add view".
- **task-deps-tree** (`tasks/task-deps-tree`): a hand-rolled `ViewSwitcher` between the
  Dependencies tree (`DepsTreeView`, storageKey `task-deps-tree`) and the Created tree
  (`TasksSubtree` from task-list, storageKey `tasks-subtree`).

The goal: one DataView surface (one storageKey → one config file → **one**
`EditableViewSwitcher`) whose view-instances each bind to a **source**. The
sort/filter/search/properties chrome adapts automatically because it already derives
from the active instance's fields + per-instance state — the only missing dimension is
"which source does this instance render". Adding a view becomes a source-aware menu
(pick source, then view type).

Single-source consumers (~30 existing DataViews) must be **100% untouched** — no
behavior change, no config change (`source` absent = the sole implicit source).

Decided scope: ship the primitive + migrate **both** hack sites (conversations sidebar,
task-deps-tree). Debug → Slow-Events migration is a follow-up.

## Design summary

- Config row gains an optional `source` key:
  `{ "id": "queue", "name": "Queue", "source": "queue", "view": { "type": "list" } }`.
- Sources are contributed as **render-callback components** through a per-consumer slot
  factory `defineDataViewSources<THostProps>(id)` — mirroring
  `defineItemActions`/`defineFieldExtensions` (a `defineRenderSlot` callable registrar).
  The component owns its data hooks and calls `render(bundle)` where
  `bundle = Omit<DataViewProps, "storageKey"|"title"|"actions"|"defaultView"|"views">`.
- **Static vs bundle metadata (important deviation from the naive design):** the view
  model must resolve *every* config row (chips, add-menu gating, hierarchical gate)
  before any source component mounts — and only the ACTIVE source mounts. Therefore
  `views?: string[]` (type whitelist) and `hasHierarchy?: boolean` live as **static
  contribution metadata**, not in the bundle. Everything dynamic (rows, fields, rowKey,
  the actual `hierarchy` accessors, viewOptions, dataSource, itemActions, aggregate,
  manualOrder, creators, selection, …) stays in the bundle.
- New `<MergedDataView storageKey sources hostProps title? actions? defaultView?>` host,
  exported from the data-view web barrel (it reuses internals, so it must live in the
  data-view plugin). Only the active instance's source component mounts; switching
  sources remounts the body (subscriptions restart — fine, they're components).
- `view-core` stays type-agnostic: `source` is an opaque lookup key resolved through a
  caller-supplied `ViewSourceEntry[]` list. view-core **never** imports data-view
  (documented review-only invariant — grep must stay empty).

Two pre-existing bugs get fixed en route (both standalone, land in Task 1):

1. **Server-query cache collision**: `useServerDataSource`'s TanStack key is
   `["data-view-server", stableStringify({sort,filter,query})]`
   (`web/internal/use-server-data-source.ts:69-78`) — no surface identity, `staleTime:
   Infinity`. Two surfaces (or two sources) with structurally-equal state share pages
   fetched by a *different* `fetchPage`. Fix: `["data-view-server", storageKey,
   sourceScope, viewKey]`. Deliberately no `viewId` — instances of one surface share
   one `fetchPage`, so cross-instance sharing is correct today.
2. **View-state leakage across instances**: `renderIsolated` has no per-instance React
   key (`data-view.tsx:473-477`) — switching between two instances of the same view
   type keeps the view mounted (virtualizer measurement cache, inline editors, local
   tree expand leak). Fix: key the rendered view by `activeViewId`.

Two config-machinery facts that shape the plan (verified):

- The `views` listField item schema is `.passthrough()`
  (`fields/list/plugins/config/core/internal/list.ts:63`) and the server registry
  spreads `{...item}` deleting only `rank` — so a `source` key **survives the read
  path**. But `normalizeRows` (`view-core/web/internal/use-views-config.ts:70-79`)
  rebuilds each row as exactly `{ id, name, view }` and every write serializes the
  mirror wholesale — **the first UI edit would silently strip `source`**. The row model
  must carry it explicitly.
- Do **NOT** declare `source` in the descriptor's `itemFields`: `fieldSchemaWithDefault`
  heals missing sub-keys to their defaults, so a defaulted `textField` would materialize
  `source: ""` on every existing row of every surface (mass config diff, and `""` ≠
  absent). Rely on passthrough; document that the Settings-pane FieldRenderer won't
  show a `source` editor (it's stamped by `addView`, never hand-edited there).

---

## Task 1 — Shell/body split refactor (pure refactor + the two bug fixes)

**Goal**: split `data-view.tsx` so everything downstream of "which instance is active"
lives in a **body** component that Task 2 can mount per source. Every existing consumer
byte-identical (except the two flagged fixes).

### The seam

**Shell** (per-surface, source-independent):
- `DataViewSlots.View.useContributions()` + `useDataViewModel(...)` (config engine,
  instances, activeId, ephemeral localStorage state — `useViewEphemeral`'s read-once
  `useState` initializer must live here so it survives source switches).
- `useDataViewDevGuards(storageKey)` → `rootRef`; `useElementSize()` → `toolbarHeight`
  → `--dv-header-offset` on the root `<Stack gap="none">`; the `toolbarRef` passes
  DOWN to the body, which attaches it to the toolbar's `<Sticky>`.
- `useViewVariants(contributions)` + the `EditableViewSwitcher` element (verified: it
  needs only model inputs — `editable-view-switcher.tsx:34-46`). Shell builds the node,
  hands it to the body as an opaque `ReactNode`.
- Active-instance resolution + the **zero-instances placeholder branch** (shell
  early-returns before the body mounts; body hooks never run — legal, separate
  components). Placeholder keeps rendering `title`/`actions`/`CreatorsControl`.
- `title` / `actions` (surface chrome), threaded to the body for toolbar placement.

**Body** (per active instance; per source in Task 2), in hook order:
1. **`CollectFieldExtensions` fold — moved from above the model
   (`data-view.tsx:83-94`) to wrap the body.** This is the critical inversion: per-source
   fields depend on the active instance, which the model computes. Body =
   `DataViewBody` (renders the fold) → `DataViewBodyInner` (all hooks). One observable
   difference: with zero authored instances, field-extension contributors
   (custom-columns) no longer mount — invisible (nothing rendered them); note in commit.
2. `hasChildren` memo, `useServerDataSource`, `useFilterController`/`useSortController`,
   `useSortPresets`/`useFilterPresets`, supports* flags, `rowOrderEnabled`, effective
   rows/state/loading substitution, `CollectRowOrder`, `renderProps`, `settingsContext`
   (built by the body — it bundles per-source `fields` even though the gear sits in the
   toolbar), `DataViewToolbar`, keyed view render + `InfiniteScrollFooter`.

**Presets hooks live in the body** (their pill popovers are body chrome; they key off
`storageKey` only so per-surface semantics are preserved; config-backed mirror re-derives
on remount — nothing user-visible lost). Presets stay per-surface and **fail-soft**
against a foreign source's schema (dangling fieldIds already excluded by
`use-sort-controller.ts:44-48` / `use-filter-controller.ts:26-39` /
`use-group-by-controller.ts:33-37`) — deliberate, do not namespace per source.

**Toolbar composition**: `DataViewToolbar` (`components/toolbar/data-view-toolbar.tsx`)
stays as-is (dumb layout shell; compact logic self-contained). The **body renders it**,
receiving shell chrome:

```ts
// web/internal/body-types.ts (new, internal — not barrel-exported)
interface DataViewShellChrome {
  switcher: ReactNode; switcherCount: number;
  title?: ReactNode; actions?: ReactNode;
  stickyRef: Ref<HTMLElement>;
}
type DataViewSourceBundle<TRow> = Omit<
  DataViewProps<TRow>, "storageKey" | "title" | "actions" | "defaultView" | "views">;
interface DataViewBodyProps<TRow> extends DataViewSourceBundle<TRow> {
  storageKey: DataViewId;
  viewModel: ViewModel;
  activeInstance: ResolvedViewInstance<DataViewContribution>;
  chrome: DataViewShellChrome;
  sourceScope?: string; // server-cache scope per source; "" single-source
}
```

**Do NOT key `DataViewBody`** by instance id — toolbar/controllers must persist across
plain instance switches exactly as today (only the view render gets the
`key={activeViewId}`, fix 2). The body computes `activeState` itself from `viewModel`
(`stateFor` mints a fresh object per call — don't compute in the shell and pass down).

### Files

- Modify `plugins/primitives/plugins/data-view/web/components/data-view.tsx` — becomes
  `DataView` public wrapper + shell (extract a shared internal `DataViewShellFrame` so
  Task 2's `MergedDataView` reuses placeholder/measure/switcher logic without drift).
- Create `plugins/primitives/plugins/data-view/web/components/data-view-body.tsx` —
  `DataViewBody` + `DataViewBodyInner`. Internal.
- Create `plugins/primitives/plugins/data-view/web/internal/body-types.ts`.
- Modify `plugins/primitives/plugins/data-view/web/internal/use-server-data-source.ts`
  — cache-key fix (optional trailing `sourceScope` param, source-compatible).

### Invariants

- Every body hook unconditional inside `DataViewBodyInner`; the only gate is the
  shell's placeholder early-return (unmounts the whole body). Folds keep their
  recursive-component / hook-free-callback shapes (rules-of-hooks).
- The `FieldDef<unknown>` ↔ `FieldDef<TRow>` cast boundary moves with the fold into the
  body — keep the documented cast-site comment.
- Watch React Compiler re-analysis of the split components and the sticky toolbar
  measurement (`--dv-header-offset` ref now crosses shell→body).

### Verification

- `./equin build` (type-check, lint, checks — `data-views-in-sync` unchanged).
- `bun run test:dom plugins/primitives/plugins/data-view` + existing bun tests;
  add a unit test asserting the new query-key shape.
- Screenshot smoke (`bun e2e/screenshot.mjs`): tasks pane (tree+hierarchy),
  all-conversations (dataSource + infinite scroll + filter), sidebar queue (group-by +
  manual order + aggregate), debug reports (table), sonata library (gallery + field
  extensions). Verify compact toolbar in the narrow sidebar, settings gear
  (Properties/Group by), presets popovers, custom-columns Fields.

---

## Task 2 — Source axis: row model, per-source resolution, grouped add menu, `MergedDataView`, `defineDataViewSources`

### 2a. view-core row model (`source` write-back preservation)

- `view-core/core/internal/types.ts`: `ViewConfigRow` + `ViewInstance` gain
  `source?: string`.
- `view-core/web/internal/use-views-config.ts`:
  - `RawViewRow` gains `source?: string`.
  - `normalizeRows` carries it via **conditional spread**
    (`...(row.source !== undefined ? { source: row.source } : {})`) so the mirror's
    JSON stays byte-identical for source-less rows (the JSON-identity reconcile at
    :173-182 depends on it).
  - `addView(type, sourceId?)` stamps `source` on the seed row (seed title resolved
    from that source's contributions); `duplicateView` copies `source` explicitly.
  - `renameView`/`deleteView`/`reorderView`/`mergeView` use `{...r}` spreads —
    preserve `source` for free; lock with tests.
- Descriptor: **no `itemFields` change** (passthrough — see Design summary).

### 2b. view-core per-source resolution (stays type-agnostic)

Replace the flat `(contributions, hasHierarchy, viewOptions)` triple with an ordered
**source-entry list** (a list, not a resolver fn — the add menu must enumerate sources):

```ts
// view-core/core — `source` stays an opaque key; nothing names data-view
interface ViewSourceEntry<T extends ViewTypeMeta = ViewTypeMeta> {
  id?: string;              // matched against row.source; undefined = implicit sole source
  title?: string;           // add-menu group label; omitted for the implicit source
  icon?: ComponentType<{ className?: string }>;
  contributions: SealContributions<T>[];
  hasHierarchy: boolean;
  views?: string[];
  viewOptions?: Record<string, unknown>;
}
```

- `resolve-instances.ts` — `buildInstanceFromRow(row, entries)`: find
  `entries.find(e => e.id === row.source)` (both possibly `undefined`); **no entry →
  fail-soft `null`** (mirrors unknown `view.type` — row kept in config, skipped); then
  the existing type lookup within `entry.contributions ∩ entry.views`, hierarchical
  gate vs `entry.hasHierarchy`, options merge vs `entry.viewOptions`.
  `ResolvedViewInstance` carries `source` through.
- `useViewsConfig(storageKey, descriptorMap, entries)`;
  `useViewModel(storageKey, descriptorMap, entries, defaultView)`:
  `available` becomes grouped —

  ```ts
  interface AddableSource {
    sourceId?: string; title?: string; icon?: ComponentType<{className?: string}>;
    types: AddableViewType[]; // per entry: contributions ∩ views ∩ hierarchical gate
  }
  // ViewActionsCore: availableSources: AddableSource[]; addView(type, sourceId?)
  ```
- `editable-view-switcher.tsx` add menu: when
  `availableSources.length === 1 && !availableSources[0].title` → render today's flat
  `DropdownMenuItem` list **byte-identically**. Otherwise one `DropdownMenuSection` per
  source (satisfies the `no-groupless-dropdown-menu-label` lint rule); item click →
  `actions.addView(v.type, source.sourceId)`.
- `useViewVariants` **unchanged** — the `View` registry is global and identical for
  every source, so one variants map serves the settings popover (it only opens on the
  active chip). Note in CLAUDE.md so nobody "fixes" it later.
- Re-run the invariant grep:
  `rg "data-view/(core|web|server)" plugins/primitives/plugins/data-view/plugins/view-core`
  → must be empty.

### 2c. data-view: model wrapper, factory, `MergedDataView`

- `web/internal/use-data-view-model.ts`:
  `useDataViewModel(storageKey, entries: ViewSourceEntry<DataViewContribution>[], defaultView)`.
  Single-source shell builds its one implicit entry:
  `[{ contributions, hasHierarchy: !!props.hierarchy, views: props.views, viewOptions: props.viewOptions }]`.
- New `web/internal/define-data-view-sources.tsx` (mirrors `define-item-actions.tsx`):

  ```ts
  interface DataViewSourceProps<THostProps> {
    hostProps: THostProps;
    /** MUST always be called — pass { rows: [], loading: true, … } while loading;
     *  never early-return null (shell chrome would vanish). */
    render: <TRow>(bundle: DataViewSourceBundle<TRow>) => ReactNode;
  }
  interface DataViewSourceContribution<THostProps> {
    id: string;               // the config row's `source` key
    title: string; icon: ComponentType<{ className?: string }>; order?: number;
    views?: string[];         // STATIC type whitelist
    hasHierarchy?: boolean;   // STATIC hierarchy availability
    component: ComponentType<DataViewSourceProps<THostProps>>;
  }
  function defineDataViewSources<THostProps>(id: string): DataViewSources<THostProps>;
  ```

  Generic `render` gives contributors full `TRow` typing; the host consumes the bundle
  at `unknown` (documented cast boundary, same as field extensions).
- New `web/components/merged-data-view.tsx`:
  `MergedDataView<THostProps>({ storageKey, sources, hostProps, title?, actions?, defaultView? })`.
  Flow: `View.useContributions()` + `sources.useContributions()` → build
  `ViewSourceEntry[]` from static metadata (no `viewOptions`) → `useDataViewModel` →
  shared `DataViewShellFrame` → resolve
  `activeSource = contribs.find(c => c.id === activeInstance.source)` (always found —
  unknown-source rows already fail-softed) →
  `renderIsolated(sources.id, activeSource, { hostProps, render: (bundle) =>
  <DataViewBody key={activeSource.id} … sourceScope={activeSource.id} {...bundle} /> })`.
  Only ONE source mounts — plain `renderIsolated`, **no recursive fold**.
- Body options re-merge: `renderProps.options =
  { ...bundle.viewOptions?.[type], ...instance.options }` — idempotent on the
  single-source path (model already merged), supplies code-only options (`renderRow`,
  `renderCard`) on the merged path where the model couldn't see them. Dev-warn when
  `!!bundle.hierarchy !== !!contribution.hasHierarchy`.
- Barrel exports: `MergedDataView`, `defineDataViewSources`, `DataViewSources`,
  `DataViewSourceContribution`, `DataViewSourceProps`, `DataViewSourceBundle`.
- **Docs**: data-view `CLAUDE.md` multi-source section (one storageKey → one config →
  one switcher; `source` semantics; **instance ids must be unique across sources** —
  `normalizeRows`'s dedup suffix would silently rename and orphan `data_view_row_order`
  rows; presets per-surface + fail-soft by design; unknown-source fail-soft).
  view-core `CLAUDE.md`: row model, `ViewSourceEntry`, the passthrough decision.

### Files

- `view-core/core/internal/types.ts`, `view-core/core/index.ts`
- `view-core/web/internal/{use-views-config,resolve-instances,use-view-model}.ts`
- `view-core/web/components/editable-view-switcher.tsx`, `view-core/web/index.ts`
- `data-view/web/internal/use-data-view-model.ts`
- `data-view/web/components/data-view.tsx` (shell builds one implicit entry)
- Create `data-view/web/internal/define-data-view-sources.tsx`
- Create `data-view/web/components/merged-data-view.tsx`
- `data-view/web/index.ts`, both CLAUDE.md files

### Verification

- view-core bun tests: `normalizeRows` round-trip preserves `source`; every mutator
  preserves it; `addView(type, source)` stamps it; `buildInstanceFromRow` fail-softs
  unknown source before the type lookup.
- `./equin build`; screenshot-diff 2–3 single-source surfaces (tasks pane,
  all-conversations, a gallery) — zero drift; single-source add-menu markup unchanged.
- `MergedDataView` has no consumer yet — exercised in Task 3.

---

## Task 3 — Migrations

### 3a. Conversations sidebar

All under `plugins/conversations/plugins/conversations-view/plugins/data-view/`:

- `web/host.ts`: replace `defineTabbedView` with

  ```ts
  export const SidebarSources =
    defineDataViewSources<ConversationSidebarProps>("conversations-sidebar-sources");
  export const SIDEBAR_VIEW = defineDataView("conversations-sidebar"); // new surface id
  ```

  New umbrella component `web/components/conversations-sidebar-data-view.tsx`:
  `<Scroll axis="y" fill className="h-full"><MergedDataView storageKey={SIDEBAR_VIEW}
  sources={SidebarSources} hostProps={props} defaultView="queue" /></Scroll>` — **one**
  scroll ancestor (the old per-tab `<Scroll>` wrappers and the tabbed `Column` die; the
  dev-guard single-scroll check catches mistakes at runtime).
- Queue sub-plugin: `sidebar-queue.tsx` becomes `QueueSource` — keeps `useQueueRows()`,
  its `CloseConversationContext.Provider` (value from `hostProps.onCloseConversation`),
  and calls `render<QueueRow>({ rows, fields: queueFields, rowKey, loading: pending,
  selectedRowId: hostProps.activeId ?? undefined, onRowActivate, viewOptions: { list:
  { renderRow } }, itemActions: QueueItemActions, aggregate, manualOrder })`.
  Contribution: `SidebarSources({ id: "queue", title: "Queue", icon, order: 5,
  views: ["list"], component: QueueSource })`. Delete the
  `defineDataView("conversations-sidebar-queue")` marker. Item-action contributions
  unchanged.
- History sub-plugin: same shape — `HistorySource` keeps revision tick + `dataSource` +
  `conversationFieldDefs` + its own `CloseConversationContext`. Contribution
  `{ id: "history", title: "History", icon, order: 10, views: ["list"] }`. Delete the
  `defineDataView("conversations-sidebar-history")` marker.
- Mount: `conversations-view/web/components/conversation-list.tsx` renders the new
  umbrella component instead of `SidebarDataView.Host`.
- Config: author `config/conversations/conversations-view/data-view/conversations-sidebar.jsonc`:

  ```jsonc
  {
    "views": [
      { "id": "queue", "name": "Queue", "source": "queue",
        "view": { "type": "list", "groupBy": "section" } },
      { "id": "history", "name": "History", "source": "history",
        "view": { "type": "list", "sort": [{ "fieldId": "createdAt", "direction": "desc" }] } }
    ],
    "filterPresets": [ /* carry "Hide system" from the old history config */ ]
  }
  ```

  Delete the retired queue/history config files (+ `.origin` twins); verify
  `debug/config-orphans` shows none. Grep for and remove any
  `conversations-sidebar-dataview` slot reorder config.
- Accepted losses (document in commit): orphaned localStorage
  (`conversations-sidebar-dataview:active-view`,
  `conversations-sidebar-{queue,history}:{active-view,view-state}` — active tab/query
  reset once); switcher chips show the view-type icon rather than the old tab icons.

### 3b. task-deps-tree

**Import-direction resolution**: keep the existing `task-deps-tree → task-list` edge.
deps-tree defines the sources slot AND contributes **both** sources itself from its own
`web/index.ts` — nothing ever imports deps-tree for this. Compose the Created source
from task-list **building blocks** — requires additive exports from
`plugins/tasks/plugins/task-list/web/index.ts`: `taskFields`, `clusterTaskHierarchy`,
`buildTreeOptions` (currently internal in `web/internal/tasks-data-view.tsx`;
`Tasks.TaskActions` already exported). Do **NOT** reuse `<TasksSubtree>` as a source —
it owns its own `<DataView>` and a source's `render(bundle)` replaces the inner
DataView; nesting is structurally wrong.

- New `task-deps-tree/web/internal/deps-sources.tsx`:

  ```ts
  interface DepsHostProps {
    taskId: string; allTasks: readonly TaskListItem[];
    memberIds: ReadonlySet<string>; onNavigate: (id: string) => void;
  }
  export const DepsSources = defineDataViewSources<DepsHostProps>("task-deps-tree-sources");
  ```

  - `DepsSource` (current `DepsTreeView` body dissolves into it):
    `rows = useMemo(buildDepsTree(allTasks, memberIds))`, `fields: depsTreeFields`,
    `hierarchy: depsHierarchy` (moveTaskInDepsTree), `viewOptions: { tree:
    depsTreeOptions }` (incl. `AlsoAfterChips`), `itemActions: DepsActions`,
    `selectedRowId: taskId`. Contribution `{ id: "deps", title: "Dependencies",
    icon: MdAccountTree, order: 5, views: ["tree"], hasHierarchy: true }`.
  - `CreatedSource`: `rows = allTasks.filter(t => memberIds.has(t.id))`,
    `fields: taskFields`, `hierarchy: clusterTaskHierarchy`, `viewOptions: { tree:
    buildTreeOptions({ readOnly: true, defaultExpanded: true }) }`, `selection: {}`,
    `itemActions: Tasks.TaskActions`. Contribution `{ id: "created", title: "Created",
    icon: MdFolderOpen, order: 10, views: ["tree"], hasHierarchy: true }`.
- `components/deps-tree-section.tsx`: keep everything above the switcher (resource,
  container ids, memberIds, self-hide, Loading gate); replace
  `ViewSwitcher + useActiveViewId("task-deps-tree:view") + branch` with
  `<MergedDataView storageKey={DEPS_TREE_VIEW} sources={DepsSources}
  hostProps={{ taskId, allTasks, memberIds, onNavigate }} defaultView="deps" />`.
- Config: rewrite `config/tasks/task-deps-tree/task-deps-tree.jsonc` — two rows
  (`deps` keeps `visibleFields: ["title"]`; `created` carries the hide-completed filter
  + preset from `tasks-subtree.jsonc`).
- **tasks-subtree**: leave `TasksSubtree`, its marker, and its config untouched (public
  component, zero runtime consumers after this — deletion is a follow-up, not coupled).
- Accepted: `task-deps-tree:view` localStorage orphan; the section gains the full
  DataView toolbar (search/filter pills) in place of the bare `ViewSwitcher` — the
  intended UX unification.

### Files

- `conversations-view/plugins/data-view/web/host.ts` (+ new umbrella component,
  `web/index.ts`)
- `…/plugins/queue/web/components/sidebar-queue.tsx` (+ `web/index.ts`)
- `…/plugins/history/web/components/sidebar-history.tsx` (+ `web/index.ts`)
- `conversations-view/web/components/conversation-list.tsx`
- `task-deps-tree/web/components/deps-tree-section.tsx` (+ new
  `internal/deps-sources.tsx`; absorb `deps-tree-view.tsx`; `web/index.ts`)
- `task-list/web/index.ts` (additive exports only)
- Config: create `conversations-sidebar.jsonc`; delete 4 retired queue/history configs;
  rewrite `task-deps-tree.jsonc`.

### Verification

- `./equin build` — `data-views-in-sync` regenerates the manifest (old ids gone,
  new id added), `configs-authored` + `config-stable-list-ids` pass, boundary checks
  pass (no new cross-plugin edges).
- Screenshots (`bun e2e/screenshot.mjs`): sidebar Queue (sections, `×N` aggregate,
  drag), switch to History (server rows, infinite scroll, Hide-system preset), the `+`
  menu showing two labeled sections; task-detail deps section on a task with deps
  (Dependencies ↔ Created); compact toolbar in the narrow sidebar.
- Functional: queue neighbor-based drag reorder; close action on both sources; history
  search round-trips with the new cache key; deps drag splice/branch; created tree
  read-only; rename/reorder a merged view row → written `.jsonc` still carries
  `source`; stale localStorage active-view ids fall back to `defaultView`.
- Watch: single-scroll structure in the sidebar (dev-guard console.error = failure);
  `Shell.Sidebar` `reorderFill` interaction with the new root; no spurious refetch on
  source switch (`changeTick` ref init).

---

## Follow-ups (out of scope — file as tasks)

- Migrate Debug → Slow-Events (`debug.slow-events` tabbed-view over Events / Aggregates
  / Cluster DataViews) onto a merged surface.
- ~~Delete `TasksSubtree` + the `tasks-subtree` surface/config if it stays consumer-less.~~
  **Done** — it stayed consumer-less; see
  [`research/2026-07-24-tasks-retire-tasks-subtree.md`](2026-07-24-tasks-retire-tasks-subtree.md).
- Consider deleting `defineTabbedView` once debug migrates (its last consumer).

## Execution notes

- Three sequential tasks, each independently pushable; Task 1 must land (and be
  smoke-verified) before Task 2 starts.
- **Use Fable subagents for all implementation work** (user directive — this is
  load-bearing infrastructure); Sonnet only for lookup/verification chores.
- Key invariants to re-check at every step: rules-of-hooks in the folds, view-core
  never imports data-view (grep), config write-back never drops `source`,
  single-source consumers byte-identical.
