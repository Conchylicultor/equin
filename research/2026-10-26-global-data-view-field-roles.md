# DataView field roles — one declared meaning drives every view's placement

## Context

A DataView field declares a type and a handful of unrelated layout flags
(`primary`, `leading`, `indicator`, `align`, `dropOrder`, `visible`), but not
what it MEANS for the row. So the default views treat every field alike:

- **Status** renders as a text/chip column. The tasks tree hand-wires its glyph
  (`leadingIcon` in `tasks/task-list/web/internal/tasks-data-view.tsx:114`), so
  status shows twice. Conversations draw the glyph by hand inside a custom
  `StatusCell`.
- **Timestamps** reach the list's right edge only if a surface remembers
  `align: "end"` (tasks does, conversations doesn't). The tree never moves them.
- **Paths** take as much room as the title (conversation `worktreePath`).
- **Second lines** are stacked by hand inside the title cell (logs catalog id +
  description, exhibits label + id).
- The list names the `date` type directly (`list-view.tsx:421`,
  `resolveTypeChain(...).includes("date")`), which leaks the collection.

This is the follow-up the default chrome redesign left open
(`research/2026-10-25-global-data-view-default-chrome-redesign.md`). The target
look is prototype `proto-1792901792-4r3ei4`, whose fields already declare
`role` + `prio` and whose views derive their layout from them.

User decisions:

1. **`role` replaces the old placement flags.** `primary`, `leading`,
   `indicator`, list-trailing-by-`align:"end"` and `dropOrder` are deleted, so
   there is one spelling. `align` goes back to meaning text alignment only.
2. **`role` is declared with the field** in `fields/core`'s `FieldMeta`, where
   `primary` lives today. It flows through `LiveField` to every list of that
   entity, exposure or arm. In-memory schemas and per-list `overrides` use
   `FieldDef.role`. `FieldPresentationSpec` gets no `role`, so each field is
   declared in one place.

## The model

### Vocabulary

A closed list, kept as plain data in `fields/core`
(`core/internal/field-role.ts`, exported from the barrel).

| Role | Meaning | List / tree row | Table | Gallery card | Type default for |
|---|---|---|---|---|---|
| `title` | the row's name (was `primary`) | label | first column after status | title | — |
| `description` | prose about the row | subtitle run (2nd line, or inline when `lines: 1`) | folded under the title when `titleCell: "stacked"`, else a column | subtitle line | `text`, `multiline-text` |
| `visual` | the row's avatar (was `leading`) | leading slot | ordinary column | leading slot | — |
| `status` | the row's state | leading glyph, or after the title when a `visual` holds the slot | first column (glyph + label) | glyph on the title line | — |
| `mark` | row-state mark (was `indicator`) | after the title | column | after the title | — |
| `property` | a dimension (enum, tag, bool…) | aligned trailing slot | column | token | everything else |
| `measure` | a quantity | aligned trailing slot, end-aligned, tabular | end-aligned column | token | `number` (so `int`, `float`) |
| `path` | a location string | trailing slot, start-truncated (last segment, full path as `title`) | column, start-truncated | token | `directory-path` |
| `time` | the row's instant | last trailing slot, faint (`listTimeInk`) | end-aligned column, last | footer meta | `date` |

`FieldImportance = "essential" | "high" | "normal" | "low"` decides what gives way
when a view runs out of room. Its default comes from the role:

- `title` and `status` → `essential` (never dropped)
- `time` → `high`
- `path` → `low`
- every other role → `normal`

Importance is a separate axis from `visible: false`, which is unchanged and still
means "not in the default body set".

### Where each field gets its role

`role` and `importance` are declared in these places:

- `FieldMeta.role` / `FieldMeta.importance` (`fields/core/internal/types.ts`) —
  `enumTextField({ label: "Status", options, role: "status" })`. `pick-meta.ts`
  carries both, and `FieldMeta.primary` is deleted.
- `FieldIdentity.role` — the TYPE's default, inherited along the `extends` chain
  like `directionLabels`. `date`, `number`, `directory-path`, `text` and
  `multiline-text` declare one. Data-view reads it through `useFieldIdentities`
  and names no type. This deletes the list's `includes("date")`.
- `LiveField.role` / `.importance` replace `LiveField.primary`
  (`network/live/core/internal/live-fields.ts:42,411`, `row-kind.ts`,
  `live-columns.ts`). `derivedField` (`data-view/web/internal/derived-fields.tsx:226`)
  copies them onto the derived `FieldDef`.
- `FieldDef.role` / `FieldDef.importance` (`data-view/core/internal/types.ts`)
  replace `primary` / `leading` / `indicator` / `dropOrder` for in-memory
  schemas, and are what `overrides` set per list.

The precedence is explicit field (or override) → type identity → `property`. It
is resolved in one place.

### One resolver, one partition

- `resolveFieldRoles(fields, identities)` in `data-view/web/internal/field-roles.ts`
  returns each field's role and importance.
  - It asserts at most one `title`, one `visual` and one `status`, and throws
    naming the fields. That is the `pickLeadingField` precedent.
  - With no `title`, the first `description` field is promoted, else `fields[0]`.
    This keeps today's `pickPrimaryField` fallback.
- `partitionRowFields(bodyFields, roles)` replaces `partitionCardFields`
  (`card-fields.ts`), `pickPrimaryField`, `pickLeadingField` and the list's
  `terms` memo (`list-view.tsx:409-440`). It returns
  `{ visual, status, title, marks, description[], trailing[] }`.
  - `trailing` is in zone order: property, then measure, then path, then time.
  - Within a zone, body order is kept.
  - Every view reads this one partition.
- **The default body order is role order.** `resolveBodyFields` with
  unconfigured `properties` stable-sorts the schema by role zone. So the table's
  default columns and the Properties list read status, title, properties,
  measures, paths, time. An explicit `properties` array still wins.

### Status glyph

A `status` field in a glyph position (the leading slot, or a card's title line)
draws the first of these that exists:

1. its `token` renderer — a surface's own glyph (conversations' `ConvStatusDot`)
2. the value's `FieldOption.icon`, tinted by `.tint` — the same identity a group
   header already draws
3. a dot in `.tint`

The table cell stays the field's cell, which with WS4's quiet presentation is
dot + label. Status-ness is not tied to a field type, so no per-surface
`leadingIcon` is needed.

### Importance in each view

- **Table** (`table-view.tsx:237`, `nested-table-view.tsx:408`): maps importance
  to the data-table column's numeric `dropOrder`: low 1, normal 2, high 3,
  essential never drops. Data-table's own API is unchanged; its
  non-data-view consumers keep `dropOrder`.
- **List**: trailing slots give way low → normal → high when the row is narrower
  than title minimum + slots. This reuses data-table's `alignedFit`
  (`data-table/core/internal/aligned-fit.ts`) over the measured slot widths from
  `use-slot-widths.ts`.
- **Gallery**: tokens are ordered by importance, and `low` fields are left off
  the card (still reachable via Properties).

## Workstreams

Phase 1 runs alone. Then phases 2 and 3 run in parallel. Phase 4 runs last.

**1. Model.**

- `FieldRole` / `FieldImportance` + `FieldMeta` + `FieldIdentity.role` in
  `fields/core`.
- Type defaults on the five identities.
- `LiveField` passthrough.
- `FieldDef` props swapped.
- `resolveFieldRoles` + `partitionRowFields` + the role-ordered
  `resolveBodyFields`, with unit tests (precedence, type chain, duplicate
  throws, title promotion, zone order).

**2. Views.**

- List (`plugins/list/web/components/list-view.tsx`): partition-driven slots,
  status glyph in `leading-slot.tsx`, start-truncated path slot, importance
  fit, `isTime` → `role === "time"`.
- Tree (`plugins/table/.../nested-table-view.tsx`): status glyph in the
  `TreeHead` leading slot, columns in role order, importance drop.
- Table: importance → `dropOrder`, stacked title takes `description`.
- Gallery: `partitionRowFields`, status on the title line, importance order.
- Rewrite these tests: `leading-field`, `nested-leading-field`, `row-lines`,
  `subtitle-extraction`, `card-fields`, `quiet-rows`.
- New tests: `status-glyph`, `role-placement`, `importance-fit`.

**3. Codemod** (one `./equin run` script under `data-view/scripts/`, deleted
after the run):

- `primary: true` → `role: "title"` (~106 files, both `FieldDef` literals and
  field-factory options).
- `leading: true` → `role: "visual"` (17).
- `indicator: true` → `role: "mark"` (4, incl. `FieldPresentationSpec.indicator`
  → the declaration or a list override).
- `dropOrder` → `importance` (file-tree, prototypes gallery).
- **`align: "end"` audit (54 files).** The script lists every text-typed field
  that relied on `align: "end"` to trail. Those now default to `description` and
  would move to the subtitle, so each gets `role: "property"` (or `"time"` /
  `"status"`) explicitly. A number or date with `align: "end"` needs nothing.

**4. Reference surfaces.**

- **Tasks.**
  - `taskRows.status` gets `role: "status"` (`tasks-core/core/resources.ts:79`).
  - `TASK_STATUS_OPTIONS` get `icon` + `tint` from `task-status`'s metadata.
  - Delete the `status` / `updatedAt` overrides (`tasks-data-view.tsx:68-73`)
    and `leadingIcon` in `buildTreeOptions`.
- **Conversations.**
  - Entity `status` gets `role: "status"`
    (`tasks-core/core/internal/fields.ts`).
  - `worktreePath` gets `role: "path"`.
  - `presentation.tsx` gains `status.token: <ConvStatusDot/>`; the `StatusCell`
    stays the table cell.
  - The sidebar's custom `renderRow` is out of scope.
- **Logs catalog** (`logs-catalog.tsx`):
  - Split the hand-stacked `id` cell into `id` (title) + `description`
    (description).
  - `size` → measure and `lastWrite` → time come by default, so drop the
    `align: "end"`.
- **Log reader** (`log-reader.tsx`): `t` is time by default, so it moves to the
  row's right edge in the list.
- **Exhibits** (`exhibits-list.tsx`):
  - Split label/id stacking into `label` (title) + `id` (description).
  - `widths` and `geometry` get `importance: "low"`.

**Docs**:

- `data-view/CLAUDE.md`: a new "Field roles" section. "Single-line list rows",
  "Hierarchy" and "Quiet rows" follow it.
- `fields/CLAUDE.md`: role and the type default.
- `network/live/CLAUDE.md` "Fields": role travels with the field.

## Must stay true

- Data-view names no field type; type defaults come from identities
  (collection-consumer).
- One declaration per field: no role on `FieldPresentationSpec`.
- Duplicate `title` / `visual` / `status` fail loudly at mount.
- An explicit `properties` order still wins over role order.
- Boundary checks pass (data-view core → fields/core is core → core).

## Verification

1. `./equin test plugins/fields plugins/network/plugins/live plugins/primitives/plugins/data-view`
   + the four surfaces' plugins.
2. `./equin check`: tsc catches every leftover `primary` / `leading` /
   `indicator` / `dropOrder`.
3. `./equin build` (backgrounded).
4. `screenshot.ts` on these routes, in every view each enables (list, table,
   tree, gallery), at 1280 and ~700px wide to see importance drops:
   `/agents/tasks`, `/agents/all-conversations`, `/debug/logs` (catalog +
   reader), `/debug/exhibits`.
   - Expect the status glyph leading (once), time on the right edge, the path
     truncated and dropped first, the description on the 2nd line.
5. `compare-diff.ts --name proto-1792901792-4r3ei4` against `/agents/tasks`.
6. Spot-check surfaces touched by the `align: "end"` audit and by the
   enum-to-trailing default shift (enums leave the subtitle run): Sonata
   library, places, mail threads, Studio tables, file-explorer tree.
