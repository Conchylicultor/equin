// @plan
# Per-view "Properties" (visible fields + order) for DataView

## Context

Each DataView view today hardcodes its own body display policy over the **shared**
`FieldDef[]` schema:

- **table** renders every field as a column;
- **gallery** renders primary + cover + every other field as muted card rows;
- **list** renders primary as the label, every other non-`align:"end"` field as a
  muted dot-joined subtitle, and `align:"end"` fields as trailing;
- **tree** renders **only** the primary field (`pickPrimaryField`) — every
  non-primary field is filter-only and never appears in the body.

There is **no per-view-instance control** over *which* of the schema's fields a view
shows in its body and in *what order* — unlike Notion, where every view independently
picks its visible properties and their ordering. The per-view config row already
carries `sort` / `filter` / options; **visible-fields + order is the missing
dimension on the same row**.

The direct user-visible consequence: user-added **custom columns** (and any
non-primary field) are invisible in the **tree** body (and buried/uncontrollable in
the list subtitle), even though the column exists, is editable in the table, and is
filterable. The downstream task *"Custom DataView columns aren't shown in tree and
list view bodies"* is **resolved as a consequence of this unification** — not patched
with a stopgap per-field flag.

**Decisions locked with the user:**

- **Show-all by default.** When a view has no explicit visible-fields configured
  (the `null` default), the body shows **all** schema fields — so custom columns
  appear in tree/list immediately, with zero user action. (A small audit of existing
  tree surfaces that intentionally hid non-primary fields authors a narrow default in
  their config — see Migration.)
- **Title fully hideable.** The primary/title field is just another entry in the
  visible-fields list: it can be hidden and reordered like any field, in every view.
  When hidden in gallery/list/tree, the title slot falls back to the next visible
  text field (or the row id), via `pickPrimaryField` run over the *visible* subset.

## Design

`visibleFields` is a per-view-instance ordered list of field ids — stored in the
**`view` blob** of the config row, exactly like `sort` and `filter` (read via
`viewFor(id)?.visibleFields`, written via `updateView(id, { visibleFields }, { merge: true })`).
This needs **zero new config infrastructure**: no `extraFields`, no codegen, no
origin-hash change, no check impact (the `view` blob is an opaque `VariantValue`;
`data-view:configs-authored` and `config-origins-in-sync` are both unaffected —
confirmed).

```ts
// ordered list of VISIBLE field ids, in body order. Absent id = hidden.
// null / undefined = unconfigured → show ALL fields in schema order.
visibleFields?: string[] | null;
```

Semantics, mirroring Notion:
- **null (uncustomized)** → all fields shown, schema order. New fields added later
  (incl. a freshly added custom column) auto-appear.
- **explicit array** → exactly those fields, in that order; everything else hidden.
  (Standard Notion behavior — once a view is customized, later-added fields are
  hidden until toggled on.)
- **Order is meaningful (reordering, like Notion).** The array order *is* the body
  order in every view: column order in **table**, property-row order in
  **gallery**/**list**, secondary-chip order in **tree**. The Properties control
  reorders via drag (`controller.move`). One nuance: in gallery/list/tree the
  primary is always pulled to the **title** slot regardless of its position, and the
  *remaining* fields render in `visibleFields` order — so reordering the title
  relative to others only changes layout in the **table** view (where it is a real
  column). This matches Notion: the card title is the heading; property order
  controls the property rows.

### The one shared seam: `resolveBodyFields`

Filtering/sort/search continue to operate on the **full** `fields` array (unchanged
at the host level and inside each view's `useFlatRows(props.rows, props.fields, …)`).
`visibleFields` governs **body rendering only**, via one shared helper exported from
the data-view web barrel:

```ts
// web/internal/resolve-body-fields.ts
export function resolveBodyFields<TRow>(
  fields: FieldDef<TRow>[],
  visible: string[] | null | undefined,
): FieldDef<TRow>[] {
  if (visible == null) return fields;                 // show-all default
  const byId = new Map(fields.map((f) => [f.id, f]));
  return visible.map((id) => byId.get(id)).filter(Boolean) as FieldDef<TRow>[];
}
```

Each view computes its body field list from `resolveBodyFields(props.fields,
props.state.visibleFields)`, then applies its existing structural extraction over
that subset:

| View | Body field list → structural roles |
|---|---|
| **table** | columns = `vis` (1:1), in order |
| **gallery** | title = `pickPrimaryField(vis)`, cover = `pickCoverField(vis, options.coverField)`, body rows = the rest of `vis` |
| **list** | title = `pickPrimaryField(vis)`, trailing = `vis.filter(align==="end")`, subtitle = the rest |
| **tree** | title = `pickPrimaryField(vis)`, **secondary = the rest of `vis` → NEW trailing chips** |

Because `pickPrimaryField`/`pickCoverField` now run over the **visible** subset, a
hidden title falls back naturally, and with the `null` default `vis === fields` so
**gallery/list/table render byte-for-byte as today**. Only **tree** gains new body
output (the secondary region), which is the whole point of the fix.

### Tree gains a secondary-field region

`tree/web/components/tree-view.tsx` `DefaultRow` currently renders `{label}{options.trailing}`
inside `RowChrome`. Add a read-only secondary-field cluster between the label and the
existing `options.trailing`, each field rendered through the same `useResolveCell`
the table/tree label already use (so a field-type's cell/badge renders identically):

```tsx
{secondaryFields.length > 0 ? (
  <Inline gap="xs" className="shrink-0">
    {secondaryFields.map((f) => (
      <span key={f.id}>{resolveCell(f, f.value?.(row) ?? null, row) ?? String(f.value?.(row) ?? "")}</span>
    ))}
  </Inline>
) : null}
{options.trailing != null ? <Center as="span" axis="both">{trailing}</Center> : null}
```

- `secondaryFields = resolveBodyFields(fields, state.visibleFields).filter(f => f.id !== primaryField?.id)`,
  where `primaryField = pickPrimaryField(vis)`.
- **Read-only in v1** (display only). Inline editing of a custom-column value in a
  dense tree row is a follow-up — users edit those values in the table/list. Note it.

### Per-view-instance controller + toolbar control

Mirror `useSortController` exactly. New `web/internal/use-visible-fields-controller.ts`:

```ts
export interface VisibleFieldsController<TRow> {
  items: { field: FieldDef<TRow>; visible: boolean }[]; // ordered: visible first (in order), hidden appended
  visibleFields: string[] | null;
  toggle: (id: string) => void;     // materializes the array on first edit
  move: (id: string, toIndex: number) => void;
  showAll: () => void;              // → setVisibleFields(null)
  isCustomized: boolean;            // visibleFields != null
}
export function useVisibleFieldsController<TRow>(
  fields: FieldDef<TRow>[],
  visibleFields: string[] | null,
  setVisibleFields: (ids: string[] | null) => void,
): VisibleFieldsController<TRow>;
```

- When `visibleFields == null`, `items` = all fields checked, schema order.
- First `toggle`/`move` materializes the explicit array; writing always recomputes
  `visibleFields = items.filter(v).map(id)` in list order.
- `showAll()` resets to `null` (show-all, incl. future fields).

New toolbar control `web/components/properties-trigger.tsx` — a per-view-instance
pill, **slotted between the Sort pill and `{actions}`** in the `<Sticky>` toolbar,
matching the sort/filter pill pattern (per-view-instance, frequently changed;
discoverable on its own rather than buried in the view-settings popover). It is an
`IconButton` (e.g. `MdViewColumn`, tooltip "Properties") inside `InlinePopover`; body
is a `SectionLabel` "Properties" + a `SortableList` (the sortable-list primitive) of
rows — each row = drag handle + checkbox (visible) + field label — plus a
"Show all fields" reset footer. Gated by `fields.length > 1` (single-field trees like
pages/agents have nothing to configure).

### Host wiring (`data-view/web/internal/use-data-view-model.ts` + `components/data-view.tsx`)

Mirror the sort/filter wiring precisely:

1. `readVisibleFields(view: VariantValue | undefined): string[] | null` — returns
   `Array.isArray(view?.visibleFields) ? view.visibleFields : null`.
2. `setVisibleFields(id, ids|null) => core.updateView(id, { visibleFields: ids } as VariantValue, { merge: true })`.
3. `stateFor(id)` includes `visibleFields: readVisibleFields(core.viewFor(id))`.
4. In `data-view.tsx`, build `visibleFieldsController = useVisibleFieldsController(fields, activeState.visibleFields, (ids) => viewModel.setVisibleFields(activeViewId, ids))`
   and render `<PropertiesTrigger controller={visibleFieldsController} />` in the toolbar.
5. **Server-delegated path:** `visibleFields` is a display-only concern (it never
   touches the SQL) — when the host neutralizes `effectiveState` for the
   `dataSource` path, it must **preserve** `visibleFields` from `activeState`
   (unlike sort/filter/query, which the server owns).

## Migration — author a narrow default where show-all regresses

With show-all default, **tree** consumers that intentionally hid non-primary fields
must author `visibleFields` in their committed config `.jsonc` (hand-edit the `view`
blob — these files are already overrides):

- **REQUIRED** `config/config_v2/settings/config_v2.settings.nav.jsonc` — its
  `modified`/`conflict`/`source` fields are deliberate filter-only dimensions
  (documented in data-view CLAUDE.md). Author the tree view:
  `{ "name": "Tree", "view": { "type": "tree", "visibleFields": ["label"] } }`.
- **REQUIRED** `config/apps/studio/explorer/studio.explorer.tree.jsonc` — its tree
  already shows badges (child-count/collapsed/load-bearing) via `options.trailing`
  sub-plugins; the `path`/`description`/`loadBearing`/… FieldDefs would duplicate
  them. Author the **tree** row → `"visibleFields": ["name"]` (leave the Table /
  Load-bearing rows untouched — table show-all is correct).
- **RECOMMENDED** `config/code-explorer/code-explorer.file-tree.jsonc` — `kind`
  (Folder/File enum) is redundant with the row icon. Author `"visibleFields": ["name"]`.
- **VERIFY** `config/tasks/task-list/tasks-list.jsonc` — the tree would newly show
  `status` + `updatedAt` as trailing chips (both `align:"end"`). This is likely a
  desirable Notion-style enhancement; **verify visually** and only author
  `"visibleFields": ["title"]` if it reads as clutter.
- Audit the remaining single-field trees (`agents`, `pages`) — no change (one field).

These are plain `.jsonc` edits (keep the `// @hash` line; the `view` blob is opaque
to the origin hash, so no rehash). No `data-view:configs-authored` impact.

## Docs

Update prose that the change invalidates:
- `plugins/primitives/plugins/data-view/CLAUDE.md` — the "Filtering" section's
  "In the **tree** view only the `primary` field renders, so non-primary fields are
  filter-only" claim, and the config-nav worked example, now describe the
  show-all-by-default + per-view Properties model and the `visibleFields` config key.
  Add a short "Per-view visible fields (Properties)" section next to sort/filter.
- `plugins/primitives/plugins/data-view/plugins/tree/CLAUDE.md` and `list/CLAUDE.md`
  — note the secondary-field region and that body fields follow `visibleFields`.

## Critical files

**New (data-view/web):**
- `internal/resolve-body-fields.ts` — `resolveBodyFields` (exported from `web/index.ts`).
- `internal/use-visible-fields-controller.ts` — the controller facade.
- `components/properties-trigger.tsx` — the toolbar pill.

**Modified:**
- `data-view/core/internal/types.ts` — add `visibleFields?: string[] | null` to `ViewState`.
- `data-view/web/internal/use-data-view-model.ts` — `readVisibleFields`,
  `setVisibleFields`, `stateFor`, preserve in server `effectiveState`.
- `data-view/web/components/data-view.tsx` — controller + `<PropertiesTrigger>` in toolbar.
- `data-view/web/index.ts` — export `resolveBodyFields` (and the controller type if needed by tests).
- `plugins/table/web/components/table-view.tsx` — columns from `resolveBodyFields`.
- `plugins/gallery/web/components/gallery-view.tsx` — pick primary/cover/body over `vis`.
- `plugins/list/web/components/list-view.tsx` — title/trailing/subtitle over `vis`.
- `plugins/tree/web/components/tree-view.tsx` — `DefaultRow` secondary-field cluster.
- Config `.jsonc` files listed under Migration.
- The three CLAUDE.md docs.

**Templates to clone:**
- `data-view/web/internal/use-sort-controller.ts` (controller shape).
- `data-view/web/internal/use-data-view-model.ts` `setSortRules`/`sortFor` (read/write seam).
- `data-view/web/components/data-view.tsx` `FilterBuilderTrigger`/`SortBuilderTrigger`
  (pill placement) and `custom-columns/web/components/data-view-settings-button.tsx`
  (IconButton + InlinePopover body).
- `pickPrimaryField` (`web/internal/pick-primary-field.ts`) and `pickCoverField`
  (in gallery-view) — now called over the visible subset.

## Verification

1. `./equin build` (regenerates nothing new — no schema/codegen change; runs
   checks: typecheck/lint, `data-view:configs-authored` unaffected,
   `config-origins-in-sync` unaffected). Then `bun install`-backed tests if added.
2. Add a `resolve-body-fields.test.ts` (bun:test) covering: null → identity;
   explicit order/subset; unknown id dropped.
3. End-to-end on the **tasks** DataView (`http://<worktree>.localhost:9000/agents`):
   - Tree view now shows `status`/`updatedAt` trailing chips (or, post-migration,
     only the title if authored).
   - Open **Properties** pill → toggle a field off → it disappears from the body;
     reorder → body order changes; "Show all fields" → back to show-all. Reload →
     persists (written to `config/tasks/task-list/tasks-list.jsonc` view blob).
   - Add a **custom column** (gear → Fields → "Notes") → it appears in the tree body
     (show-all default) and in the table; sort/filter on it still work.
4. Confirm **config-nav** tree (Settings app) shows only the config name (authored
   `visibleFields: ["label"]`), and **studio explorer** tree shows only `name` (no
   duplicated badges).
5. Confirm a **table** surface (debug/reports) renders unchanged with `null`, and
   toggling a column off via Properties hides it while it stays filterable/sortable.
6. Confirm a server-delegated surface (**all-conversations**) honors Properties
   (display) while server sort/filter/pagination still drive the rows.
