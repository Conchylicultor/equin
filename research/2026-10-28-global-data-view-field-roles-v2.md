# DataView field placement v2 — typed fields, recipes, slots

Supersedes `2026-10-26-global-data-view-field-roles.md` (v1, a single `role`
enum per field). Visual spec: prototype `proto-1792901792-4r3ei4`,
**Layout → audit**. It renders 75 real DataViews (their real fields, sample
rows), with a **Recipe** picker (suggested / record / log / timeline / inbox /
ledger, plus `v1` for comparison).

## Context

Every DataView field declares a type and a few placement flags (`primary`,
`leading`, `indicator`, `align`, `dropOrder`). It never says what it MEANS for
the row. The default list / table / gallery / tree treat every field alike, so
surfaces hand-wire their placement (`leadingIcon`, custom `renderRow`,
`align: "end"`, hand-stacked title cells) or live with the noise. This is the
follow-up of `2026-10-25-global-data-view-default-chrome-redesign.md`.

v1 gave each field one `role` (title, status, time, path…), and each role a
fixed place in each view. We audited every DataView in the app (88 files,
75 surfaces, 232 flagged field assignments). The panel showed v1 fails in six ways:

1. **Roles meant to be singular collide.** About 20 surfaces carry two or three
   instants (created / updated / ended). Statuses compete: state + extraction
   + status on event sources, lane vs verdict on the launch list. Avatar and
   status dot both want the leading slot on the agents roster.
2. **Placement depends on the surface kind, not on the field.**
   - Logs and feeds lead with the time (log reader, queue events,
     timelines). Events put the date beside the title.
   - Version history and notifications put the time on line 2.
   - Mail's title is the sender, with subject + snippet on line 2.
   - Deploy's "last run" status trails.
3. **Common meanings have no role.** Code identifiers (~12 surfaces), durations vs
   instants, people, money, ordinals, value-vs-cap meters, severity, whole-row tone
   (unread / disabled / done), selection controls in the lead.
4. **Fields are mistyped.** A size stored as `"84.2 MB"` text, a date as an
   ISO string, durations as bare ints, `"3/5"` as text. Placement, sort, filter
   operators and grouping are all wrong as a result.
5. **Importance is per surface.** Cost is the point of the cost table, the
   error the point of the dead-jobs view. A path is the title of config
   orphans. The runtime profile has 8 numeric columns no default can rank.
6. **Much of what rows draw is not a field.** Schedule lines, derived
   sentences and problem badges built inside `renderRow` cannot be placed
   until they are fields.

## Mental model

Three questions, each answered in its own layer:

```
  field type (+ facts)  ──►  recipe rules  ──►  placement  ──►  each view draws its slots
  "what it is"               "where kinds go"   field → slot + priority
                                    ▲                 ▲
                         surface overrides     user's view config
```

| Layer | Who writes it | Says |
|---|---|---|
| **Type** | the field declaration | what the value is (`duration`, `identifier`, an enum whose options declare a `variant`…) |
| **Recipe** | the surface, one word | where each kind goes on this kind of surface |
| **Surface overrides** | the surface, sparse | `place` / `emphasis` by field id |
| **View config** | the user, per view | moves a field to another slot (extends Properties) |

A field's placement is the most specific layer that sets it, in this order:
type default, then recipe rule, then surface override, then view config.
Each layer only says what it changes. A surface that says nothing gets the
`record` recipe over well-typed fields. That is the good default.

### Kind — what a field is (derived, never authored)

A closed list in `fields/core`. Every field type declares its kind on its
identity (`FieldIdentity.kind`), inherited through `extends` like
`directionLabels`. So a field's kind comes from its type alone.

| Kind | Types |
|---|---|
| `label` | `text` (short string), `enum` whose options declare no `variant`, `tags` |
| `prose` | `multiline-text` |
| `state` | an enum whose options declare a `variant` — `BadgeVariant` (success / warning / destructive / info / muted) already is the tone vocabulary, so no new `tone` (decided from the options, not the type) |
| `instant` | `date` |
| `duration` | `duration` (new) |
| `quantity` | `number`, `int`, `float`, `byte-size` (new), `money` (new) |
| `ordinal` | `ordinal` (new) |
| `identifier` | `uuid`, `identifier` (new) |
| `person` | `person` (new) |
| `path` | `directory-path`, `url` |
| `visual` | `avatar`, `icon`, `image` |
| `flag` | `bool` |

- `primary: true` stays as the **identity** fact: this field names the row.
  It is the one placement-relevant fact a field declares, and `primary` keeps
  its name (no churn).
- `visible: false` stays as the "filter / sort / group only" default.

### Slots — what each view offers

Shared ids, so one placement works in every view. Each slot has a capacity:
`lead`, `title` and `edge` hold one field; the others hold any number.

| Slot | List / tree row | Table | Gallery card | Tile |
|---|---|---|---|---|
| `lead` | glyph / avatar / leading time | first column | cover badge | face |
| `title` | label | title column | title | label |
| `afterTitle` | marks after the label | inline in title cell | after title | corner |
| `line2` | second line | stacked under title | subtitle | — |
| `trail` | aligned trailing slots | columns | ≤3 tokens | — |
| `edge` | far right, faint | last column | footer right | — |
| `rowTone` | dims / bolds the whole row (today's `rowTone` prop) | same | same | same |
| `hidden` | filter / sort / group only | same | same | same |

The **slot picks the form** a cell draws. A state draws as a glyph in `lead`,
as dot + label in `trail`, and as glyph + label in a table column. Cells get
`form: "glyph" | "inline" | "full"`, which generalises today's `cell` / `token`
pair.

### Recipe — where kinds go (one word per surface)

An ordered list of `[match, slot]` rules, as data. `match` is a kind or
`identity`. The placement engine walks the rules in order and places each
unplaced matching field (in declaration order) into the slot if it has
room. Everything follows from that one loop:

- **Collisions fall through.** A second instant finds `edge` full, so it takes
  its next rule (`trail`, or `hidden` in `ledger`).
- **Priority = placement order.** What gives way when narrow is the reverse
  order. There is no per-field importance enum.
- **Title promotion.** With no identity field, the first `prose` / `label` /
  `identifier` is promoted, and the panel says so.

Starter recipes (the panel's `suggested` mapping assigns them to the audited
surfaces: 53 record, 10 ledger, 5 log, 5 timeline, 2 inbox):

| Recipe | Gist | Audit surfaces |
|---|---|---|
| `record` (default) | identity → title, state → lead, instant → edge, prose / identifier → line2, rest → trail | tasks, servers, sources, settings lists |
| `log` | instant → lead (mono, faint), identity → title (wraps), state → afterTitle, no line2 | log reader, queue events, slow-op timelines, release logs |
| `timeline` | state → lead, instant + person + prose → line2 | version history, notifications, recent runs |
| `inbox` | person → title, the identity drops to line2, a row-tone flag → rowTone | mail threads / search |
| `ledger` | state → lead, instant → edge, extra instants hidden | runs, deploy / release history, queue jobs |

Recipes start as a **closed list in `data-view/core`**: plain data, per the
closed-list rule. A registry comes only when an app needs one of its own.

### Surface overrides (sparse, in code)

```tsx
<DataView recipe="record"
  place={{ updatedAt: "edge", createdAt: "hidden" }}   // conversations: which instant is the row's
  emphasis={["costUsd"]}                               // never give way
/>
```

`emphasis` moves fields to the front of the priority order. The panel shows
where it is needed: the runtime profile drops 5 of 8 equal measures, and only
the surface knows which matter. A `DataViewSwitcher` source may carry its own
`recipe` / `place`.

### View config (the user's layer)

The `properties` entries (`PropertyEntry`) gain `slot?`. View settings → Properties
draws one band per slot, and dragging a field between bands moves it there
("put Model on line 2"). It is saved where `properties` is saved today. A field
the entry does not set falls back to the layers below.

## What the audit panel showed about v2

- **The fall-through fixes most collisions.** Under v1 the panel flagged "N times" on
  ~20 surfaces. Under v2 the second instant simply lands in `trail` or
  `hidden`, and the card names it: "Created: edge taken → trail".
- **Recipes fix the surface-shaped cases v1 could not express.** Time leads in
  the log reader; mail renders sender / subject · snippet with unread rows bold;
  version history puts the time on line 2.
- **Still open, honestly:**
  - Many equal measures need `emphasis` (runtime profile, slow ops).
  - Two boolean states (places want / been) need one enum whose options declare variants instead.
  - Rows whose content is not a field (background activity, source-run
    sentences) still need computed fields.
  - Interactive leads (selection checkboxes, primary toggles) are view
    features: when one is present, a recipe's `lead` rules yield to the next rule.

## Implementation phases

### Phase 1 — Typed fields (ships alone, no layout change)

Value on its own: sort, filter operators and grouping become correct.

- New field types, each `extends` an existing one, inheriting its sort,
  filter operators, grouping and codecs, and adding its cell + filter input:

  | Type | Extends | Cell | Filter input |
  |---|---|---|---|
  | `duration` (ms) | `number` | `1m 04s` | accepts `30s`, `5m` |
  | `byte-size` | `number` | `84.2 MB` | accepts `1 GB` |
  | `money{currency}` | `float` | `$42.17` | — |
  | `identifier` | `text` | mono, copy on click, middle truncation | — |
  | `person` | `text` | avatar + name | — |
  | `ordinal` | `int` | `#3` | — |

  Each type is a plugin under `plugins/fields/plugins/<type>/`, following
  `int` / `uuid`, with `config`, `table`, `filter` and `data-view-codec` children
  as its base type has them. `bytes` is taken (binary data); hence `byte-size`.
- **No new `tone`.** `FieldOptionMeta.variant` (`BadgeVariant`) already says
  success / warning / destructive / info / muted, so it is the state vocabulary.
- **Storage.** `duration`, `byte-size` and `money` store as `double precision`;
  `ordinal` as `integer`; `identifier` / `person` as text. Storage resolution is
  exact-token, so each type declares its own builder. Some existing duration
  and size columns are int4 and widen at build (this also fixes
  `backup_runs.archiveSizeBytes`, which overflows above 2.1 GB).
- **Units.** `duration` is always milliseconds (Sonata's seconds are converted
  at its server binding). `byte-size` formats in SI base 1000, like Finder.
- Fix the mistyped sites. Re-verify each audit item at its file:line before
  changing it. Known ones:
  - dependencies `size` / `kind`
  - cost `lastActivity`
  - deploy-history `duration`
  - queue `attempts`
  - slow-op `load` / `pg` (store the two numbers)
  - `durationMs` / `waitMs` / `waited` / `worked` → `duration`
  - sha / run id / fingerprint / job id → `identifier`
  - `composer` / `author` → `person`
- Tests: each type's codec / filter / sort, in the existing per-type test
  layout.

### Phase 2 — Placement engine

**Model**

- `FieldIdentity.kind` on every field type (inherited via `extends`).
- `FieldKind` and `Slot` closed lists, and `RECIPES` data, in
  `data-view/core`.
- `resolvePlacement(fields, identities, { recipe, place, emphasis, properties,
  lead taken? })` → `{ field, slot, priority, form }[]` in
  `data-view/web/internal/placement.ts`. It is unit-tested against the
  prototype's `place()`: collisions, promotion, emphasis, user slot,
  hidden.

**Views read placement only**

- list (`list-view.tsx`): `lead` / `title` / `afterTitle` / `line2` /
  `trail` / `edge`; `rowTone` applied as today.
- tree (`nested-table-view.tsx`): the list's slots plus hierarchy.
- table (`table-view.tsx`): column order = slot order; `line2` stacks under
  the title; `afterTitle` inline; priority → data-table `dropOrder`.
- gallery (`gallery-view.tsx`, `card-fields.ts`): cover badge = `lead`,
  tokens = first 3 of `trail`, footer = `edge`.

**Delete**

- `leading`, `indicator`, `dropOrder`, `align: "end"`-as-trailing
  (`align` stays text alignment), `pickLeadingField`, `partitionCardFields`.
- The list's `includes("date")` type-naming (`list-view.tsx:421`).
- `FieldPresentationSpec.indicator`.

`primary` / `visible` / `header` / `width` stay.

**Codemod**

- `leading: true` → `place: { x: "lead" }` at the surface (or the type is
  already `visual`).
- `indicator: true` → `afterTitle`.
- Fields that relied on `align: "end"` to trail get `place` where the recipe
  disagrees.

### Phase 3 — Adopt on surfaces

1. Reference surfaces, deleting their hand-wiring:
   - **Tasks** (record): status options get `variant`s; drop the
     `leadingIcon` / `align` overrides.
   - **Conversations** (record): `place={{ updatedAt: "edge" }}`,
     `worktreePath` → `path` type.
   - **Logs catalog / reader** (record / log).
   - **Exhibits** (record): split the hand-stacked id into an
     `identifier` field.
2. Then the audit list by recipe. The `suggested` map in the prototype is the
   starting assignment. Every surface whose `renderRow` / `leadingIcon`
   becomes redundant drops it.
3. Remaining `renderRow` sites (mail rows, background activity, launch
   list…) are follow-up tasks, one each. They need their non-field content
   turned into computed fields first.

### Phase 4 — The user's slot editor

- `PropertyEntry.slot?` in `data-view/core` types; read and write paths beside
  `properties`.
- View settings → Properties: one band per slot, drag between bands, with
  "Reset to recipe".

## Must stay true

- **Collection-consumer.** Data-view names no field type: kinds come from
  identities, and states from option variants.
- **A field declares facts only.** No placement on `FieldDef` or
  `FieldPresentationSpec` beyond `primary` / `visible`.
- **Fail loudly.** A `place` naming an unknown field or a slot the view lacks
  throws at mount. An unknown recipe is a type error.
- **The user's explicit `properties` order still wins** within a slot.
- Boundary checks pass: `data-view/core` → `fields/core` is core → core.

## Verification

1. `./equin test` on `plugins/fields`, `plugins/primitives/plugins/data-view`
   and each adopted surface's plugin. The placement resolver tests mirror the
   prototype's cases.
2. `./equin check` (tsc catches every removed flag), then `./equin build`.
3. `screenshot.ts` on these routes, in list / table / tree / gallery, at 1280 and ~700px:
   - `/agents/tasks`
   - `/agents/all-conversations`
   - `/debug/logs`
   - `/debug/exhibits`
   - one `log` and one `ledger` surface (queue history, runs)
4. Compare against the audit panel under the same recipe.
5. Phase 1 alone: sorting dependencies by size and filtering runs by
   `duration > 30s` behave numerically.
