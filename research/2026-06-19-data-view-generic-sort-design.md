# Design: Generic multi-level sort for data-view (Notion-style)

Status: **Design / implementation plan.** Implementation is carried by the three
chained follow-up tasks (model → UI → reconcile). This doc is the contract those
tasks build against. Read `research/data-view-generic-sort-vision.md` first for
the high-level framing; this doc nails down the data model, comparator, UI
structure, controller, and table-view coherence.

## TL;DR of the decisions

1. **`SortState` (single `{fieldId,direction}`) is replaced by `SortRule[]`** kept
   inside the opaque `view` config blob. A `SortRule` is *structurally identical*
   to the old `SortState` (`{ fieldId, direction }`) — **no separate uid**, because
   `fieldId` is the natural unique key (a field is sortable at most once, Notion-
   style). This makes legacy migration a one-liner (`[legacyObject]`) and keeps the
   authored JSONC minimal and hand-writable.
2. **Migrate-on-read, never destructive.** `readSortRules(view)` coerces the
   persisted `view.sort` (legacy object | new array | absent) → `SortRule[]`. No
   config file is rewritten until the user actually edits sort.
3. **Multi-level stable comparator** extracted to a pure, unit-tested
   `internal/sort-rows.ts`, mirroring the filter's `evaluate-filter.ts` split.
   Compare by rule 1, tie-break down the list; reuse the existing field
   `value`-projection coercion; rely on `Array.sort` stability for the final
   source-order tie-break.
4. **`useSortController`** mirrors `useFilterController`; commits the whole rule
   array through the per-view config write-back (`updateView(id,{sort},{merge})`).
5. **Sort builder UI** is a new `web/components/sort/` folder mirroring
   `web/components/filter/` byte-for-byte, stripped of recursion / conjunction /
   operator / value. The shared `FieldSearchList` + `FieldPicker` are **extracted
   up** into `web/components/field/` so both builders consume one copy.
6. **Single source of truth for the table header.** The header click and the sort
   popover both edit the same `view.sort` rule list. The header is a shortcut that
   cycles the **primary** rule (rules[0]); the data-table primitive stays
   untouched (we map `rules[0]` → its single-column `SortState` indicator).

---

## Reference map (what we mirror, byte-for-byte where it overlaps)

| Filter (template) | Sort (new) | Notes |
|---|---|---|
| `internal/use-filter-controller.ts` | `internal/use-sort-controller.ts` | flat; no operator-set resolution |
| `internal/evaluate-filter.ts` (+`.test.ts`) | `internal/sort-rows.ts` (+`.test.ts`) | pure comparator |
| `components/filter/filter-builder-trigger.tsx` | `components/sort/sort-builder-trigger.tsx` | pill states identical |
| `components/filter/filter-builder-popover.tsx` | `components/sort/sort-builder-popover.tsx` | flat list, no recursion |
| `components/filter/filter-rule-row.tsx` | `components/sort/sort-rule-row.tsx` | `[drag][field][dir][✕]` |
| `components/filter/operator-picker.tsx` | `components/sort/direction-picker.tsx` | 2-item dropdown |
| `components/filter/field-search-list.tsx` | → moved to `components/field/field-search-list.tsx` | shared |
| `components/filter/field-picker.tsx` | → moved to `components/field/field-picker.tsx` | shared |
| `components/filter/editor-context.ts` | *(none)* | flat list threads the controller directly |
| host wiring in `data-view.tsx` (`useFilterController` + `<FilterBuilderTrigger>`) | `useSortController` + `<SortBuilderTrigger>` | rendered as a matched pair |

Stripped from the filter shape (named structural reason — sort has none of these):
recursion (`filter-group-editor`), conjunction (`conjunction-cell`), operator set /
`ValueInput` (`filter-value-input`, `chip-select-filter-input`), `wrapRuleInGroup`,
`addGroup`.

---

## (a) Data model + migration

### Types (`core/internal/types.ts`)

Replace `SortState` with `SortRule`; change `ViewState.sort` to an array.

```ts
/** One level of an ordered, multi-level sort. Priority = position in SortRule[].
 *  Keyed by `fieldId` (a field is sortable at most once), so no separate uid is
 *  needed — `fieldId` is the React key AND the sortable-list drag id. */
export interface SortRule {
  fieldId: string;
  direction: "asc" | "desc";
}

export interface ViewState {
  /** Ordered sort rules (priority = list order). `[]` = unsorted (source order). */
  sort: SortRule[];
  query: string;
  filter: FilterGroup | null;
  expanded?: Record<string, boolean>;
}
```

`DataViewRenderProps.setSort` keeps its signature `(fieldId: string) => void` (the
table header path — see (e)). Barrels: replace the `SortState` export with
`SortRule` in `core/index.ts` and `web/index.ts`. `SortState` has **no external
consumer** (verified: only `use-data-view-model.ts` + `table-view.tsx` reference it
within the repo), so this is a safe rename with a tiny blast radius.

### Persisted shape (inside the opaque `view` blob — view-core untouched)

```jsonc
// new shape
"view": { "type": "list", "sort": [
  { "fieldId": "updatedAt", "direction": "desc" },
  { "fieldId": "name", "direction": "asc" }
] }

// legacy shape (still on disk in committed configs — read, never rewritten)
"view": { "type": "list", "sort": { "fieldId": "updatedAt", "direction": "desc" } }
```

`view-core` already treats `view` as opaque and never names `sort` — unchanged.

### Migrate-on-read (`web/internal/use-data-view-model.ts`)

Replace `readSort` with a coercer that tolerates all three persisted forms:

```ts
function readSortRules(view: VariantValue | undefined): SortRule[] {
  const raw = view?.sort;
  if (Array.isArray(raw)) return raw as SortRule[];           // new shape
  if (raw && typeof raw === "object") return [raw as SortRule]; // legacy single → wrap
  return [];                                                   // null/absent
}
```

**Never destructive.** Reading a legacy config does not rewrite it. The file is
re-serialized to the array shape only when the user edits sort (the controller
calls `setSortRules`, which writes `{ sort: SortRule[] }`). Committed legacy
configs (`config/tasks/task-list/recent/tasks-recent.jsonc`,
`config/apps/sonata/library/sonata.library.jsonc`,
`config/apps/story/shell/story.gallery.jsonc`) keep working untouched. The
`// @hash` is the origin hash of `{ "views": [] }` — independent of the `sort`
shape — so **no `config-origins-in-sync` / `configs-authored` churn**. Do **not**
proactively rewrite those files (avoid pointless diff churn).

### Model write API (`use-data-view-model.ts`)

Add `setSortRules`; reimplement `setSort` (the header cycle) in terms of the rule
list so the table stays green the moment this lands (see (e)):

```ts
sortFor: (id) => readSortRules(core.viewFor(id)),            // SortRule[]

setSortRules: (id, rules: SortRule[]) =>
  core.updateView(id, { sort: rules } as VariantValue, { merge: true }),

// header shortcut: cycle the PRIMARY rule, preserving secondary rules.
setSort: (id, fieldId) => {
  const rules = readSortRules(core.viewFor(id));
  const primary = rules[0];
  let next: SortRule[];
  if (primary?.fieldId === fieldId) {
    next = primary.direction === "asc"
      ? [{ fieldId, direction: "desc" }, ...rules.slice(1)]   // asc → desc
      : rules.slice(1);                                       // desc → drop primary
  } else {
    next = [{ fieldId, direction: "asc" },                    // promote to primary
            ...rules.filter((r) => r.fieldId !== fieldId)];
  }
  core.updateView(id, { sort: next } as VariantValue, { merge: true });
},
```

`ViewModel` interface gains `setSortRules(id, rules)`; `setSort` signature
unchanged. `stateFor(id).sort` now returns `SortRule[]`.

---

## (b) Multi-level, type-aware comparator

### Pure module `web/internal/sort-rows.ts` (+ `sort-rows.test.ts`)

Mirror the `evaluate-filter.ts` split: the pipeline stays thin, the logic is pure
and unit-tested.

```ts
import type { FieldDef, FieldValue, SortRule } from "../../core";

/** Coerce a FieldValue to a comparable number|string (Date→ms, bool→0/1, …). */
export function comparable(value: FieldValue): number | string {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "number") return value;
  return String(value ?? "");
}

function compareScalar(a: number | string, b: number | string): number {
  return typeof a === "number" && typeof b === "number"
    ? a - b
    : String(a).localeCompare(String(b));
}

/**
 * Build a stable multi-level comparator from the rule list. Resolves each rule to
 * its field's `value` projection ONCE (outside the hot compare loop), dropping
 * rules whose field is missing or has no `value`. Returns `null` when no rule
 * resolves (caller skips sorting → preserves source order).
 */
export function makeSortComparator<TRow>(
  rules: SortRule[],
  fields: FieldDef<TRow>[],
): ((a: TRow, b: TRow) => number) | null {
  const resolved = rules
    .map((rule) => {
      const field = fields.find((f) => f.id === rule.fieldId);
      return field?.value ? { value: field.value, dir: rule.direction } : null;
    })
    .filter((r): r is { value: (row: TRow) => FieldValue; dir: "asc" | "desc" } => r !== null);
  if (resolved.length === 0) return null;
  return (a, b) => {
    for (const { value, dir } of resolved) {
      const cmp = compareScalar(comparable(value(a)), comparable(value(b)));
      if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
    }
    return 0; // full tie → Array.sort stability preserves source/rank order
  };
}
```

### Wire into the pipeline (`web/internal/use-flat-rows.ts`)

Replace the single-sort block with:

```ts
const comparator = makeSortComparator(state.sort, fields);
if (comparator) result.sort(comparator);
```

(`comparableSort` in `use-flat-rows.ts` is superseded by `comparable` in
`sort-rows.ts` — delete the local copy and import the shared one.)

**Type-awareness** stays via the field's `value` projection + `comparable`
coercion (text→locale, number→numeric, Date→chronological, bool→0/1) — adding a
new field type needs **zero** sort changes, exactly as for filter. Per-type
direction *labels* ("A→Z" / "Newest first") are an explicit non-goal (vision §
Non-goals); a later task can read them off the field identity.

**Stability:** Bun/V8 `Array.prototype.sort` is stable, so a full tie preserves
incoming order. For flat views that incoming order is the source `rows` order; for
the tree view, sort is **not** applied here at all (the tree orders by `rank`).

### Tests (`sort-rows.test.ts`, `bun:test`, co-located)

- single rule asc/desc (number, string, Date, bool);
- secondary tie-break (rule 1 ties → rule 2 decides);
- direction independent per rule (asc primary + desc secondary);
- dangling rule (unknown field / no `value`) is skipped; all-dangling → `null`;
- stability: equal rows keep source order.

---

## (c) Sort builder UI (`web/components/sort/`)

Each file mirrors its filter twin; the deltas are listed.

### `field/` extraction (shared) — **do this first in the UI task**

Move `components/filter/field-search-list.tsx` → `components/field/field-search-list.tsx`
and `components/filter/field-picker.tsx` → `components/field/field-picker.tsx`, and
re-point the filter folder's imports (`filter-builder-popover`, `filter-rule-row`,
`add-filter-affordance`). These are field-schema pickers, not filter-specific —
the named structural reason to extract rather than reach across into `../filter/`.
Generalize `FieldPicker`'s hard-coded `aria-label="Filter field"` into a prop
(`ariaLabel`, default keeps filter behavior) so sort can pass `"Sort field"`. Both
components already take a `fields` prop, so the *caller* decides the candidate set
(sort passes sortable-minus-used) — no internal change.

### `sort-builder-trigger.tsx` (← `filter-builder-trigger.tsx`)

Identical structure. Deltas:
- icon `MdSwapVert` (sort's funnel-equivalent) instead of `MdFilterList`;
- label `"Sort"` (ghost) / `` `${n} ${n===1?"sort":"sorts"}` `` (secondary) using
  `controller.ruleCount`;
- popover `contentClassName="w-[22rem] max-w-[90vw]"` (a touch narrower than
  filter's `w-[26rem]` — no value column).

### `sort-builder-popover.tsx` (← `filter-builder-popover.tsx`, flat)

```
empty (rules.length===0):  <FieldSearchList fields={addableFields} onPick={controller.addRule} />
                           // "Sort by…" placeholder (FieldSearchList placeholder is a prop — add one)
populated:                 <SortableList items={rules.map(r=>r.fieldId)} onMove=…>
                             {rules.map(rule => <SortRuleRow rule controller />)}
                           </SortableList>
                           <AddSortAffordance fields={addableFields} onPick={controller.addRule} />
                           <DropdownMenuSeparator />
                           <Button ghost sm onClick={() => { controller.clear(); onClose(); }}>
                             <MdDelete/> Delete sort
                           </Button>
```

- `addableFields = controller.sortableFields.filter(f => !rules.some(r => r.fieldId === f.id))`
  — the picker (empty state AND `Add sort`) excludes already-used fields, enforcing
  the one-rule-per-field invariant in the UI.
- No transient-root / `emptyGroup` dance (that existed only to host filter's nested
  tree before first commit). Adding a rule is a direct `controller.addRule(fieldId)`.
- `AddSortAffordance` ← a trimmed `add-filter-affordance.tsx`: just the
  field-typeahead "+ Add sort" popover button (no "Add group").

`FieldSearchList` needs a small additive prop: `placeholder?: string` (default
`"Filter by…"`), so sort shows `"Sort by…"`. Purely additive; filter unaffected.

### `sort-rule-row.tsx` (← `filter-rule-row.tsx`)

`<Frame gap="xs" align="center">` with:
- `leading`: drag handle (`MdDragIndicator` `IconButton`, wired to
  `SortableItem`'s `handleProps`) **+** `<FieldPicker fields={sortableFields}
  value={rule.fieldId} ariaLabel="Sort field" onChange={(fid)=>controller.setField(rule.fieldId, fid)} />`.
  The FieldPicker's candidate list excludes other rules' fields (so changing a
  field can't create a duplicate).
- `content`: `<DirectionPicker value={rule.direction}
  onChange={(d)=>controller.setDirection(rule.fieldId, d)} />`. (Wrapped in
  `<Clip axis="x">` like the filter value cell so trailing never jumps.)
- `trailing`: hover-revealed `<IconButton icon={MdClose} label="Remove sort"
  size="icon-sm" onClick={()=>controller.removeRule(rule.fieldId)} />` (single
  affordance — no "turn into group").

Use `useHoverReveal()` + `hoverRevealClass(revealed)` exactly as the filter row.
Each row is wrapped in `<SortableItem id={rule.fieldId} handle>{(state)=>…}</SortableItem>`;
the drag handle spreads `state.handleProps`.

### `direction-picker.tsx` (← `operator-picker.tsx`)

A 2-item `DropdownMenu` (mirrors `OperatorPicker` exactly — reads as a matched pair
with the filter operator dropdown): `Ascending` / `Descending`, `Button
variant="outline" size="sm"`, `MdExpandMore` affordance. Selection is a single
click, no debounce → "instant" toggle. (Alternative considered: a 2-segment
`SegmentedControl`. Rejected for v1 to keep visual parity with the filter
operator dropdown; revisit if a type-aware label task lands.)

### Host wiring (`components/data-view.tsx`)

Mirror the filter block exactly, beside it:

```ts
const setActiveSortRules = useCallback(
  (rules: SortRule[]) => viewModel.setSortRules(activeViewId, rules),
  [viewModel, activeViewId],
);
const sortController = useSortController(fields, activeState.sort, setActiveSortRules);
const hasSortable = sortController.sortableFields.length > 0;
…
{hasSortable ? <SortBuilderTrigger controller={sortController} /> : null}
{hasFilters ? <FilterBuilderTrigger controller={filterController} /> : null}
```

Order in the toolbar: **Sort pill then Filter pill** (Notion convention), both
before `actions` / `CreatorsControl` / the view switcher. Same `control-sm`
density / `gap-sm` spacing as today.

---

## (d) `useSortController` (`web/internal/use-sort-controller.ts`)

Mirror `useFilterController`'s shape (memoized facade), flat:

```ts
export interface SortController<TRow> {
  rules: SortRule[];
  setRules: (rules: SortRule[]) => void;
  /** Fields eligible to sort: have a `value` projection and `sortable !== false`. */
  sortableFields: FieldDef<TRow>[];
  /** Count of rules whose field still resolves (dangling rules excluded), for the pill. */
  ruleCount: number;
  addRule: (fieldId: string) => void;          // append asc; no-op if already present
  removeRule: (fieldId: string) => void;
  setDirection: (fieldId: string, direction: "asc" | "desc") => void;
  setField: (fieldId: string, nextFieldId: string) => void; // change a rule's field, keep direction & position; no-op if nextFieldId already present
  move: (fieldId: string, toIndex: number) => void;         // reorder priority
  clear: () => void;                                         // setRules([])
}

export function useSortController<TRow>(
  fields: FieldDef<TRow>[],
  rules: SortRule[],
  setRules: (rules: SortRule[]) => void,
): SortController<TRow> { … }
```

- `sortableFields = useMemo(() => fields.filter(f => f.value && f.sortable !== false), [fields])`.
- `ruleCount = useMemo(() => rules.filter(r => sortableFields.some(f => f.id === r.fieldId)).length, …)`
  — dangling rules (field removed from schema) are shown in the popover as
  "(unknown field)" but don't inflate the pill, mirroring filter's active-rule
  count.
- Every action computes the next array immutably and calls `setRules` (which the
  host binds to `setSortRules(activeViewId, …)` → `updateView({sort},{merge:true})`).
- `addRule` is a no-op when `fieldId` is already present (uniqueness invariant);
  the UI also excludes used fields, so this is belt-and-suspenders.
- `move(fieldId, toIndex)`: `arrayMove`-style reorder (the popover's `SortableList
  onMove` maps `(activeId, overId)` → `move(activeId, rules.findIndex(overId))`).

Exported from `web/index.ts`: `useSortController`, `type SortController`,
`type SortRule` (replacing `SortState`).

---

## (e) Table-view coherence — one source of truth

**Principle:** there is exactly one persisted sort state per view — `view.sort`
(`SortRule[]`). Both the popover and the column header edit *that*. The header is a
convenience shortcut over the **primary** rule.

### Reading (header indicator)

`table-view.tsx` maps the primary rule → data-table's single-column `SortState`:

```ts
function mapPrimary(rules: SortRule[]): TableSortState | null {
  const p = rules[0];
  return p ? { columnId: p.fieldId, direction: p.direction } : null;
}
…
sortState={mapPrimary(props.state.sort)}
onToggleSort={(columnId) => props.setSort(columnId)}  // unchanged signature
```

So the header arrow shows on whichever column is `rules[0]` with its direction;
secondary rules don't paint a header indicator (acceptable v1 — the popover shows
the full ordered list). The **data-table primitive is not modified** (it's a
load-bearing shared primitive; mapping to its existing single-sort prop keeps it
untouched).

### Writing (header click)

`props.setSort(columnId)` routes to the model's `setSort` (reimplemented in (a)):
cycle the primary rule asc → desc → drop, or promote a new column to primary
**while preserving secondary rules**. This is the agreed compose semantics: a
header click never silently wipes a multi-sort the user built in the popover; it
only re-points / cycles the top priority.

### Why this is coherent from task 2 onward

`ViewState.sort` flips to `SortRule[]` in task 2. If `setSort`/`mapSort` weren't
updated in the same task, the table would break (reading `.fieldId` off an array).
So task 2 **must** ship `setSort` as the primary-cycle + `table-view` reading
`rules[0]`. Task 4 then owns: final UX polish, optional header niceties (e.g. a
muted "2" badge for a secondary-sorted column — only if achievable without
modifying data-table), and the cross-view Playwright verification pass.

### Secondary-indicator follow-up (optional, not v1)

If we later want numbered badges on secondary-sorted columns, that requires an
additive multi-sort prop on the `data-table` primitive — file as its own task; do
**not** fold into this chain.

---

## Files touched (by task)

**Task 2 — model + migration + comparator (no UI):**
- `core/internal/types.ts` — `SortState`→`SortRule`; `ViewState.sort: SortRule[]`.
- `core/index.ts`, `web/index.ts` — swap the `SortState` export for `SortRule`;
  add `useSortController` + `SortController` exports (controller file itself lands
  here too — it's headless, no UI).
- `web/internal/sort-rows.ts` (+ `sort-rows.test.ts`) — pure comparator.
- `web/internal/use-flat-rows.ts` — use `makeSortComparator`; drop local `comparableSort`.
- `web/internal/use-data-view-model.ts` — `readSortRules` (migrate-on-read),
  `setSortRules`, `setSort` primary-cycle; `ViewModel` gains `setSortRules`.
- `web/internal/use-sort-controller.ts` — the controller.
- `plugins/table/web/components/table-view.tsx` — `mapPrimary(rules)` reads
  `rules[0]`; `setSort` signature unchanged. (Keep the table green.)
- `data-view/CLAUDE.md` + `plugins/table/CLAUDE.md` — doc the array shape /
  migrate-on-read / primary-rule mapping (the autogen blocks regenerate on build;
  hand-edit the prose lines that mention `SortState`).

**Task 3 — sort builder UI:**
- `web/components/field/{field-search-list,field-picker}.tsx` — extracted from
  `filter/`; `field-search-list` gains `placeholder?`; `field-picker` gains
  `ariaLabel?`. Re-point filter imports.
- `web/components/sort/{sort-builder-trigger,sort-builder-popover,sort-rule-row,direction-picker,add-sort-affordance}.tsx`.
- `web/components/data-view.tsx` — host wiring (sort pill beside filter pill).
- A jsdom test under `web/__tests__/` (optional, mirrors filter coverage if any):
  add/remove/reorder/clear round-trips through the controller.

**Task 4 — reconcile + polish + verify:**
- Final header-compose verification + indicator polish (no data-table changes).
- Playwright pass across table / list / gallery / tree: pill states, drag reorder
  smoothness, instant direction toggle, clear→ghost, per-view persistence
  round-trip, **legacy-`sort` migration** (load a view with a committed legacy
  single-sort config and confirm it reads as one rule and re-serializes to an
  array on first edit).
- `./equin build` + screenshots.

---

## Refinements to the chained tasks (scope adjustments)

The three implementation tasks are well-scoped as written. Two clarifications to
fold in:

1. **Task 2 owns "keep the table green," not just the headless model.** Because
   `ViewState.sort` becomes an array in task 2, `table-view.tsx`'s `mapSort` and the
   model's `setSort` (primary-cycle) **must** be updated in task 2 — otherwise the
   table breaks before task 4. Task 4's "reconcile header sort" is therefore *final
   polish + verification + optional secondary-indicator*, not the first time the
   header works against the rule list. (Adjust task 4's framing accordingly.)

2. **Task 3 includes the `field/` extraction.** Moving `FieldSearchList` +
   `FieldPicker` into a shared `components/field/` folder (and re-pointing filter
   imports) is part of task 3 — it's the clean alternative to duplicating them or
   reaching across into `../filter/`. Add the additive `placeholder?` /
   `ariaLabel?` props there.

No new tasks needed. Related-but-separate (do **not** fold in):
- `task-1781799715388-tzei06` (defaultSort/defaultFilter prop) — a code prop to
  *seed* a fresh instance. Orthogonal: a "default sort" today is just authoring
  `"sort": [...]` in the config JSONC, which this design already supports. That
  task can build the seeding-on-first-materialization prop on top.
- An optional `data-table` multi-sort badge prop (secondary-column indicators) —
  file separately if wanted; it's the only thing that would touch the load-bearing
  `data-table` primitive, which v1 deliberately avoids.

## Risks / caveats

- **Legacy migration is read-only.** A view that never gets its sort edited keeps
  the legacy object on disk forever — fine (migrate-on-read covers it), but means
  the repo will hold mixed shapes. That's intended; no churn-y mass rewrite.
- **`fieldId` as identity** forbids sorting by the same field twice — correct for
  sort, and the reason we can drop the uid. If a future requirement ever wants
  duplicate fields (it shouldn't for sort), this would need a uid like `FilterRule`.
- **Stability assumption.** We rely on `Array.prototype.sort` stability (guaranteed
  in modern V8/Bun) for the source-order final tie-break. Documented in
  `sort-rows.ts`.
- **Secondary header indicators** aren't shown in v1 (data-table single-sort
  indicator). The popover is the full multi-sort surface; the header reflects the
  primary only.
