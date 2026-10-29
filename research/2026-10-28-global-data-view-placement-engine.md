# DataView placement engine — kinds, slots, recipes (phases 2–4)

Implements phases 2–4 of `2026-10-28-global-data-view-field-roles-v2.md`
(phase 1, the typed fields, is on main). Visual spec: prototype
`proto-1792901792-4r3ei4`, **Layout → audit** (`place()` and `RECIPES` in its
`index.html` are the reference algorithm).

## Context

The default list / table / tree / gallery still place every field the same
way. Surfaces wire placement by hand:

- per-field flags: `leading` (3 sites), `indicator` (2), `dropOrder` (3),
  and `align: "end"` used to mean "trailing" in the list (~98 hits in 44
  files);
- view options: `leadingIcon` (6 sites) and `renderRow` (~25 sites);
- hand-stacked title cells (logs catalog, exhibits…).

The list also names the `date` type to find the time
(`list-view.tsx:421`). The audit showed that placement depends on the
surface kind, that one-per-row slots collide, and that what gives way when
the view is narrow differs per surface.

**Outcome.** A field's kind comes from its type. The surface says one word
(its recipe), plus sparse overrides. One resolver decides each field's slot,
priority and form, and every view draws slots only. The old flags are
deleted. The user can move a field between slots in View settings →
Properties.

**Decisions (from the user)**

- **Narrow tables.** Every `trail` / `edge` column gives way in reverse
  priority: `trail` first, `edge` last. `lead` and `title` never drop, so
  sideways scroll is no longer the default.
- **Scope.** Every audited surface, including turning `renderRow` content
  into computed fields, fanned out to agents.
- **Row tone.** The `rowTone` prop stays. The `rowTone` slot is left out of
  the engine for now. Mail's "strong" unread rows use the prop, which gains
  `"strong"`.

## Amendments during implementation (2026-10-28)

These came from a review with the user, who asked for the cleanest option. They
override the Design section below where the two differ.

- **Each view declares its slots.** A view passes a `ViewSlots` table
  (capacity, form, the kinds a slot takes) to `usePlacement`, and publishes the
  same table on `DataViewContribution.slots`. There is no global
  `SLOT_CAPACITY` and no "form comes from the slot" rule.
  - A slot the view leaves out is not drawn: a rule or pin into it falls
    through, and does not throw.
  - The gallery caps `trail` at 3. The icon tile's lead takes only `visual`.
  - The interactive-lead `leadTaken` flag is gone: such a view declares no
    `lead`.
- **Priority comes from the slot's rank**, then drawing order, with
  `emphasis` first (`SLOT_RANK`: title > lead > edge > afterTitle > line2 >
  trail). It no longer depends on the order of the recipe rules.
- **No trail → line2 overflow in the list.** Placement stays a pure function
  of data. That can be a follow-up.
- **Forms keep `FieldCell`'s existing names** (`cell` / `token`), plus a new
  `glyph`. The plan's `inline` / `full` rename was not done.
- **The table stacks afterTitle and line2** in the title cell only when the
  placement gives it any. The `titleCell` option is deleted.
- **A list draws two lines** when `line2` holds a field; `lines` pins it either
  way.
- **A list does not drop trailing slots by width yet.** It truncates as
  before. Width dropping (`alignedFit`) is a follow-up.

## Design

### Where things live (closed lists in core, the resolver private)

| What | Where | Why there |
|---|---|---|
| `FieldKind` union + `FIELD_KINDS` | `plugins/fields/core` | `FieldIdentity` (fields/core) must name it; `data-view/core → fields/core` is legal, not the reverse |
| `FieldIdentity.kind?: FieldKind` | `fields/core/internal/types.ts:41`, beside `directionLabels` | inherited via `extends` |
| `Slot`, `SLOT_CAPACITY`, `Recipe` id union, `RECIPES` | `data-view/core/internal/placement.ts` (new) | plain data; an unknown recipe is a tsc error |
| `PlacementSpec` (`recipe` / `place` / `emphasis`) | `data-view/core` types, on `DataViewBaseProps` and on `DataViewSwitcher` sources | |
| `resolvePlacement()` (pure) | `data-view/web/internal/placement.ts` + `.test.ts` | only data-view runs it |
| `usePlacement(fields, properties, spec, view)` | `data-view/web/internal/use-placement.ts` | resolves kinds with `useFieldIdentities()` + `resolveTypeChain`, following the `use-direction-labels.ts` template |

**Kinds** (each declared once on its type's identity, inherited downward):

| Kind | Types |
|---|---|
| `label` | `text`, `enum`, `tags` |
| `prose` | `multiline-text` |
| `instant` | `date` |
| `duration` | `duration` |
| `quantity` | `number` (and so `int`, `float`, `byte-size`, `money`) |
| `ordinal` | `ordinal` |
| `identifier` | `uuid`, `identifier` |
| `person` | `person` |
| `path` | `directory-path`, `url` |
| `visual` | `avatar`, `icon`, `image`, `media` |
| `flag` | `bool` |

Two exceptions to "kind comes from the type":

- **`state` is decided from the options.** A field whose kind is `label`
  becomes `state` when any of its `FieldOption`s declares a `variant` or a
  `tint`. This is the one data-view-side rule, and it names no type.
- **Identity is a fact, not a kind.** It is `primary: true`, matched by the
  recipe rule `"identity"`.

A type with no `kind` anywhere on its chain resolves to `label`. A
`fields:kind-declared` check requires every root identity (no `extends`) to
declare one, so a new type cannot silently fall into `label`.

### `resolvePlacement` — the prototype's `place()`, plus the layers it lacked

Input:

- `fields`, each with its resolved kind;
- `identity` (the `primary` field);
- `recipe`, `place`, `emphasis`;
- `properties` (`PropertyEntry[]`, which gains `slot`);
- `view` capabilities, e.g. `leadTaken` when selection or a drag handle
  owns the lead.

Output: `PlacedField[] = { field, slot, priority, form }`, plus `notes`
(collision and promotion messages, for a dev-only debug readout).

1. Hidden first: `visible: false`, or a `hidden` properties entry →
   `hidden`.
2. Pinned next, from the most specific layer down: `properties[].slot`
   (the user's), then `place[id]` (the surface's). A pinned field takes its
   slot even when the slot is at capacity 1. Pinned fields claim the slot
   before any recipe field.
3. Recipe walk, as in the prototype:
   - The loop is rule-major, then field-major in declaration order.
   - A field takes the first matching rule whose slot has room.
   - Capacity: `lead` / `title` / `edge` = 1, the other slots unbounded.
   - `leadTaken` makes every `lead` rule skip.
   - A field no rule places goes to `trail`.
4. Title promotion: with no `title`, the first `prose` / `label` /
   `identifier` already in `line2` or `trail` moves to `title`. This
   replaces `pickPrimaryField`'s "first text field" fallback.
5. Priority is placement order. `emphasis` ids then move to the front, and
   the user's `properties` order sorts the fields within each slot.
6. Form comes from the slot: `lead` → `glyph`, `title` / `line2` / `trail`
   / `afterTitle` → `inline`, a table column → `full`.

**Fail loudly.** These throw at mount:

- `place` or `emphasis` naming an unknown field id;
- a slot the current view does not draw (e.g. `line2` in icons);
- two pins on one capacity-1 slot.

**Recipes.** `record`, `log`, `timeline`, `inbox` and `ledger` are copied
verbatim from the prototype's `RECIPES`, with the `tone` rules dropped.
`record` is the default. Their resolver tests are the prototype's cases:
collision fall-through, inbox person-over-identity, promotion, emphasis,
user slot, hidden, and lead yielding.

### Forms: generalise `cell` / `token`

- `FieldCell`'s `context: "cell" | "token"` becomes
  `form: "glyph" | "inline" | "full"`.
- `FieldDef.cell(value, row, form)` and the `data-view.cell` slot receive
  the form. `token` folds into `inline`: `field.token ?? field.cell` keeps
  its precedence for `inline`.
- `glyph` for a `state` draws the option's `icon` tinted by its `variant`,
  else a dot in its `tint` or `variant`. A kind with no glyph renderer
  falls back to `inline`.
- This is the single place the "state as a glyph in the lead" look is
  drawn. It replaces every `leadingIcon: <StatusIcon>`.

**Alignment.** `align` becomes text alignment only. Its default derives
from the kind: `quantity` / `duration` / `ordinal` / `instant` → `end`.
Every `align: "end"` that only restates that is deleted.

### Views read placement only

All of them call `usePlacement` from the body, and the resulting
`PlacedField[]` replaces `resolveBodyFields` + `resolveListLeading` +
`partitionCardFields` + `pickLeadingField`.

- **List** (`plugins/list/web/components/list-view.tsx`).
  - `lead` → `leadingSlot`; the cover thumbnail only when `lead` is empty.
  - `title` + `afterTitle` on line 1; `line2` as the `" · "` subtitle run.
  - `trail` → `TrailingSlots` (`use-slot-widths.ts` kept), with `edge` last
    in the faint time ink.
  - Drop by width uses the data-table's `alignedFit`
    (`data-table/core/internal/aligned-fit.ts`), fed `dropOrder` from the
    priority.
  - The `includes("date")` and `align === "end"` partitions are deleted.
- **Tree** (`plugins/table/web/components/nested-table-view.tsx` and the
  list's tree chrome).
  - `lead` → `TreeHead icon`; `title` → the label column.
  - `afterTitle` and `line2` are drawn inline after the label, faint,
    since tree rows stay one line.
  - `trail` / `edge` are the aligned columns, with drop order taken from
    priority.
- **Table** (`plugins/table/web/components/table-view.tsx`).
  - Columns in slot order: `lead`, `title` (with `afterTitle` inline and
    `line2` stacked under it, through `title-cell.tsx`), `trail`, `edge`.
  - `dropOrder` is computed from priority for every `trail` / `edge` column
    (the user's decision). `titleCell: "stacked"` becomes the
    always-on behaviour.
- **Gallery** (`gallery-view.tsx`, `card-meta.tsx`).
  - The cover badge is `lead` (a `visual` lead is the cover fallback).
  - Title + `afterTitle` on line 1, `line2` as the subtitle, the first 3
    `trail` as tokens, `edge` at the footer right.
- **Icons** (`icons-view.tsx`).
  - The face is `lead`, the label is `title`; other slots are not drawn
    (declared, so `place` into them throws).
- **Interactive leads.** A view whose selection checkbox or primary toggle
  owns the lead passes `leadTaken`. `lead` rules then yield to the next
  rule.

### Delete

These go, and tsc finds every user:

- `FieldDef.leading`, `indicator` and `dropOrder`;
- `FieldPresentationSpec.indicator` (network/live), and the matching keys
  in the `FieldOverride` Pick and in `derived-fields.tsx:143`;
- `pick-leading-field.ts` and `card-fields.ts`;
- `resolveListLeading` and the list's time partition;
- `ListViewOptions.leading`, `TableViewOptions.leadingIcon` and
  `titleCell`.

`ListViewOptions.renderRow` goes last, once the adoption below has emptied
it (see Phase 3c).

`primary`, `visible`, `header`, `width`, `align` (text alignment only),
`cover` and `rowTone` stay.

## Phase 3 — Adoption (every audited surface)

The resolver and the views land first (Phase 2). The repo stays green
because each removed flag's call sites move in the same commit. Then the
surfaces fan out to Sonnet agents in this worktree, working on disjoint file
sets, with one brief per group.

**3a — Reference surfaces (done by me, they set the pattern).**

- **Tasks** (`task-list/web/internal/tasks-data-view.tsx`).
  - `TASK_STATUS_OPTIONS` (`tasks-core/core/internal/schema.ts:53`) gains
    `variant` + `icon`, moved from `STATUS_META`
    (`task-status/web/components/task-status.tsx:32`). `STATUS_META` then
    reads them, which ends the "keep in sync" coupling.
  - Delete `leadingIcon`, the two `align: "end"` and the `StatusBadge`
    cell override. Status now leads as a glyph and the time sits at the
    edge.
- **Conversations** (`all-conversations/web/panes.tsx` + `presentation.tsx`).
  - `recipe` record, `place={{ updatedAt: "edge" }}`.
  - `worktreePath` → `path` type. Status options declare variants, and the
    optimistic `StatusCell` stays the `full` / `inline` cell.
  - The History / Queue sidebars' `renderRow` (`sidebar-conversation-item.tsx`)
    moves to fields plus recipe where the row is fields.
- **Logs.**
  - The catalog (`debug/plugins/logs/web/components/logs-catalog.tsx`)
    becomes `record`. The stacked id / description cell splits into an
    `identifier` title plus a `prose` description in `line2`, and the
    "never written" badge becomes a `state` field.
  - The reader (`log-reader.tsx`) becomes `log`.
- **Exhibits** (`plugin-meta/plugins/exhibits/web/components/exhibits-list.tsx`).
  - The stacked title splits into `label` (title), `id` (`identifier`,
    `line2`) and the badges (`state` / `flag`, `afterTitle`).
  - `runtime` options gain variants.

**3b — Recipe surfaces (the prototype's `SUGGESTED` map, 22 surfaces), one
agent per group:**

- **log:** debug logs lines, queue events, slow-ops cluster timeline,
  slow-op samples, release run logs.
- **timeline:** version history, notifications, prototype versions,
  background recent runs, automations history.
- **ledger:**
  - runs, backup runs, deploy history, event source runs;
  - studio release history, queue history / dead / jobs, claude-cli calls,
    op-status queue.
- **inbox:** mail threads, mail search (with `rowTone` `"strong"` for
  unread).

**3c — The remaining record surfaces and every `renderRow` site.**

Agents split these by umbrella: debug/*, apps/*, conversations + tasks, and
infra + auth + shell + misc. Each one:

- drops `align: "end"` that restates a kind default, and adds `place` where
  the recipe disagrees with the old hand-wiring;
- uses `emphasis` where the prototype panel flagged equal measures
  (runtime profile, slow ops);
- turns `renderRow` content into fields: computed fields via
  `derived-fields` for schedule lines, sentences and problem badges, a
  `person` for senders, two booleans merged into one variant enum (places
  want / been), then deletes the `renderRow`.

A `renderRow` that cannot become fields (a true custom layout, e.g. the
prototype canvas) stays, with a one-line reason. `ListViewOptions.renderRow`
is removed only if no such site remains.

Agent briefs carry: the resolver API, the reference diffs from 3a, the
surface list with files, the rule "no new flags, kinds come from types",
and `./equin check type-check` + `./equin test <plugin>` before reporting.
Each agent returns the before/after per surface and anything it could not
convert.

## Phase 4 — The user's slot editor

- `PropertyEntry` (`data-view/core/internal/types.ts:828`) gains
  `slot?: Slot`. `readProperties` / `setProperties`
  (`use-data-view-model.ts:181,387`) carry it unchanged, and no migration
  is needed (it is absent on old rows).
- `usePropertiesController` (`web/internal/use-properties-controller.ts`):
  - items carry their resolved `slot` (from `usePlacement`);
  - new `moveToSlot(id, slot, index)` writes the whole list with the
    entry's `slot`;
  - new `resetSlots()` strips every `slot` ("Reset to recipe").
- `PropertiesControl` (`web/components/settings/properties-control.tsx`):
  - one band per slot the current view draws, in slot order, with `Hidden`
    last;
  - each band is a `SortableList`, and dragging between bands goes through
    `moveToSlot`;
  - the eye toggle still hides or shows;
  - `FieldSections` (section bands) stays as the grouping inside a slot
    band when a schema has sections.
- A capacity-1 band that receives a second field moves the old occupant
  back to its recipe slot, by dropping its `slot`.

## Verification

1. `./equin test` on:
   - `plugins/fields`;
   - `plugins/primitives/plugins/data-view` (the new `placement.test.ts`
     mirrors the prototype's cases; the properties controller gains
     `moveToSlot` / `resetSlots` tests; the list / table / gallery jsdom
     tests are updated for slots);
   - every adopted surface's plugin.
2. `./equin check` (tsc catches every removed flag; also the new
   `fields:kind-declared` check), then `./equin build`.
3. Screenshots with `screenshot.ts`, in list / table / tree / gallery at
   1280 and 700 px:
   - `/agents/tasks`, `/agents/all-conversations`, `/debug/logs`,
     `/debug/exhibits`;
   - one each of log / ledger / timeline / inbox (queue events, runs,
     version history, mail).
   - Compare them with the audit panel under the same recipe.
4. Narrow table: at 700 px a runs table drops `trail` before `edge` and
   never drops the title.
5. Slot editor, on my build: move Model to `line2` on conversations, reload
   (it persists), then Reset to recipe.
