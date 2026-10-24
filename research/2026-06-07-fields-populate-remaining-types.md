# Populate the remaining `fields/` types and their table/filter capabilities

## Context

Task 3 of the unified `fields/` primitive chain (see
`research/2026-06-06-global-unified-fields-primitive.md`). Tasks 1–2 landed:
`fields/core` (token + `FieldIdentity` with `extends`/`coerce` + `resolveTypeChain`),
the `fields.identity` registry slot, the two new data-view capability slots
(`data-view.cell`, `data-view.filter`) with `extends`-chain resolution, and one
type migrated end-to-end (`number` + `int` + `enum`-config) to validate the contracts.

This task fills out the **rest of the type × capability matrix** — the net-new
**table/filter capabilities**, the **data-view-only types** (date, image), and the
**type identities/derivations**. **Config-render relocation for existing config_v2
types is explicitly out of scope** (later migration batches 5–7); we create no
`plugins/config` sub-plugins here. **Avatar is excluded** (per task scope — its home
is config-render, deferred). The contracts are frozen; this is mechanical replication
of the validated `number`/`int`/`enum` template.

Why it matters: a field schema with type-driven cell/filter behavior is the building
block agents use to compose data surfaces (the "Notion-like WeChat" vision). Sonata's
song library (`song-library.tsx`) **already declares** `text`, `int`, and `date`
columns — so this work lights up real filter controls on a live consumer with zero
consumer changes.

## What exists (the template to mirror byte-for-byte)

- `plugins/fields/plugins/number/` — base: `core/` (identity), `web/` (registers
  `Fields.Identity`), `plugins/table` (`DataViewSlots.Cell({ match:"number", component })`),
  `plugins/filter` (`DataViewSlots.Filter({ match, Control, predicate, isActive })`).
- `plugins/fields/plugins/int/` — derived, identity-only, `extends: numberFieldType`.
- `plugins/fields/plugins/enum/` — identity + `plugins/config` (config-render).

Key API facts (verified):
- `DataViewSlots` from `@plugins/primitives/plugins/data-view/web`: `.Cell({ match, component })`
  (component = `(p: TableCellProps) => ReactNode`), `.Filter({ match, Control, predicate, isActive })`.
- `TableCellProps = { value: FieldValue; field: FieldDef<unknown>; raw?: unknown }`.
  `FieldValue = string | number | boolean | Date | null | undefined`.
- `FilterControlProps = { value: unknown; onChange: (v: unknown) => void; field: FieldDef<unknown> }`.
- `FilterContribution.predicate(filterValue, fieldValue) => boolean`, `isActive(filterValue) => boolean`.
- The **FilterBar renders Controls live** (`web/components/filter-bar.tsx`) and predicates are
  applied in `use-data-view-rows.ts` — so Controls must be real/functional, not stubs.
- Derivation: a type registers its `FieldIdentity` with `extends`; cell/filter dispatch
  walks `resolveTypeChain` (`fields/core`) so derived types inherit with no cell/filter contribution.
- Each leaf is a workspace package: `package.json` (`@singularity/plugin-fields-<type>[-<cap>]`,
  `private`, `singularity.collapsed: true`) + `CLAUDE.md` (**prose only** — the build codegen
  inserts the `## Plugin reference` autogen block; do not hand-write it).
- Identities are read by string-literal slot id (`fields.identity`); cells/filters import
  primitives + the data-view barrel only. DAG preserved (primitives never import `fields`).

## Types & capabilities to build

| Type             | Identity | Table cell | Filter | `extends`  | Notes                              |
|------------------|----------|------------|--------|------------|------------------------------------|
| `text`           | new      | TextCell   | Text   | —          | generic base                       |
| `multiline-text` | new      | — (inherit)| —      | `text`     | identity-only derivation           |
| `float`          | new      | — (inherit)| —      | `number`   | identity-only derivation           |
| `bool`           | new      | BoolCell   | Bool   | —          |                                    |
| `enum`           | exists   | EnumCell   | Enum   | —          | filter value = `string[]`          |
| `date`           | new      | DateCell   | Date   | —          | data-view-only (no config)         |
| `color`          | new      | ColorCell  | —      | —          | sparse: no filter                  |
| `image`          | new      | ImageCell  | —      | —          | data-view-only media; no filter    |

`number`/`int` already done. **Not in scope:** avatar, secret, list, object, and all
`plugins/config` relocations.

### Identities (`core/internal/<type>.ts` + `core/index.ts` + `web/index.ts`)

Mirror `number/core/internal/number.ts`. Icons from `react-icons/md`:

- `text` — `defineFieldType<string>("text")`, label "Text", icon `MdTextFields`,
  `coerce: (v) => (typeof v === "string" ? v : String(v ?? ""))`.
- `multiline-text` — `defineFieldType<string>("multiline-text")`, label "Long text",
  icon `MdNotes`, `extends: textFieldType` (import from `@plugins/fields/plugins/text/core`),
  same `coerce`.
- `float` — `defineFieldType<number>("float")`, label "Float", icon `MdNumbers`,
  `extends: numberFieldType` (import from `@plugins/fields/plugins/number/core`),
  `coerce: (v) => Number(v)`.
- `bool` — `defineFieldType<boolean>("bool")`, label "Boolean", icon `MdToggleOn`,
  `coerce: (v) => (v ? 1 : 0)`.
- `date` — `defineFieldType<Date>("date")`, label "Date", icon `MdCalendarToday`,
  `coerce: (v) => (v instanceof Date ? v.getTime() : v == null ? null : new Date(v as string).getTime())`.
- `color` — `defineFieldType<string>("color")`, label "Color", icon `MdColorLens`,
  `coerce: (v) => String(v ?? "")`.
- `image` — `defineFieldType<string>("image")`, label "Image", icon `MdImage`,
  `coerce: (v) => String(v ?? "")`.

`web/index.ts` for each: `contributions: [Fields.Identity({ identity })]` (mirror
`number/web/index.ts`). The id strings match config_v2's existing tokens
(`text`/`multiline-text`/`bool`/`enum`/`color`) so future config relocation dispatches cleanly.

### Table cells (`plugins/table/web/components/<type>-cell.tsx` + `web/index.ts`)

Each `web/index.ts`: `DataViewSlots.Cell({ match: "<type>", component: <Cell> })`.
Components receive `TableCellProps` and render read-only:

- **TextCell** — `<span className="truncate">{String(value ?? "")}</span>`.
- **BoolCell** — checkmark/cross icon by truthiness: `value ? <MdCheck/> : <MdRemove className="text-muted-foreground"/>`.
- **EnumCell** — chip via `Badge` (`@plugins/primitives/plugins/badge/web`); map the raw
  value to its label through `props.field.options` (`{ value, label }[]`), fall back to the raw string.
- **DateCell** — `formatRelativeTime(value as Date)` from
  `@plugins/primitives/plugins/relative-time/web` when `value instanceof Date`, else `String(value ?? "")`.
- **ColorCell** — read-only swatch:
  `<div className="size-4 rounded border border-border" style={{ background: String(value ?? "") }} />`.
- **ImageCell** — thumbnail: `value` non-empty → `<img src={String(value)} className="size-8 rounded object-cover" alt="" />`, else nothing.

### Filters (`plugins/filter/web/{components/<type>-filter.tsx, internal/<type>-filter-logic.ts}` + `web/index.ts`)

Mirror `number/plugins/filter`. `web/index.ts`:
`DataViewSlots.Filter({ match, Control, predicate, isActive })`. Each logic file exports a
typed value interface + pure `isActive`/`predicate`. Controls are functional (FilterBar renders them):

- **text** (`TextFilterValue { contains?: string }`) — Control: single text `<input>` (mirror
  NumberFilter input styling). `isActive`: `contains` trimmed non-empty.
  `predicate`: `String(fieldValue ?? "").toLowerCase().includes(contains.toLowerCase())`.
- **bool** (`BoolFilterValue { want?: boolean }`) — Control: `SegmentedControl`
  (`@plugins/primitives/plugins/toggle-chip/web`) with Any/Yes/No
  (`undefined`/`true`/`false`). `isActive`: `want !== undefined`.
  `predicate`: `Boolean(fieldValue) === want`.
- **enum** (`EnumFilterValue { selected?: string[] }`) — Control: toggle chips from
  `props.field.options` (`ToggleChip`/`FilterChip`); clicking adds/removes from `selected`.
  `isActive`: `selected?.length > 0`. `predicate`: `selected.includes(String(fieldValue ?? ""))`.
- **date** (`DateFilterValue { from?: string; to?: string }`, ISO `yyyy-mm-dd`) — Control:
  two `<input type="date">`. `isActive`: `from` or `to` set. `predicate`: coerce `fieldValue`
  to ms (`Date`/string), keep when within `[from, to]` (inclusive; `to` end-of-day).

## Files to create

```
plugins/fields/plugins/
  text/                       core/{index.ts,internal/text.ts}  web/index.ts  package.json  CLAUDE.md
    plugins/table/            web/{index.ts,components/text-cell.tsx}  package.json  CLAUDE.md
    plugins/filter/           web/{index.ts,components/text-filter.tsx,internal/text-filter-logic.ts}  package.json  CLAUDE.md
  multiline-text/             core/{index.ts,internal/multiline-text.ts}  web/index.ts  package.json  CLAUDE.md
  float/                      core/{index.ts,internal/float.ts}  web/index.ts  package.json  CLAUDE.md
  bool/                       core/…  web/index.ts  package.json  CLAUDE.md
    plugins/table/            …BoolCell…
    plugins/filter/           …bool logic + control…
  date/                       core/…  web/index.ts  package.json  CLAUDE.md
    plugins/table/            …DateCell…
    plugins/filter/           …date logic + control…
  color/                      core/…  web/index.ts  package.json  CLAUDE.md
    plugins/table/            …ColorCell…
  image/                      core/…  web/index.ts  package.json  CLAUDE.md
    plugins/table/            …ImageCell…
  enum/plugins/table/         web/{index.ts,components/enum-cell.tsx}  package.json  CLAUDE.md   (NEW under existing enum)
  enum/plugins/filter/        web/{index.ts,components/enum-filter.tsx,internal/enum-filter-logic.ts}  package.json  CLAUDE.md
```

No edits to existing files are required — plugin discovery is filesystem-driven
(`web.generated.ts` is regenerated by `./equin build`). The enum `CLAUDE.md` note
that "table/filter deferred to task 3" becomes stale prose; update it to point at the new
sub-plugins (optional, prose-only).

## Verification

1. `./equin build` — regenerates the plugin registry + docs; must succeed.
2. `./equin check` — must pass (plugin-boundaries, eslint, plugins-doc-in-sync,
   migrations-in-sync). Confirms contributions are discovered, barrels are pure, DAG holds,
   and the autogen `CLAUDE.md`/`plugins-*.md` blocks regenerated cleanly.
3. **Live consumer (text/int/date)** — open `http://att-1780823434-jjga.localhost:9000`
   → Sonata → Library → **Table** view. The filter bar now shows: text filters for
   **Title**/**Composer**, a number range for **Length** (int→number via `extends`), and a
   date range for **Added**. Typing/selecting narrows rows live and persists per view
   (Playwright via `e2e/screenshot.mjs`, before/after on a filter input).
4. **Derivation spot-check** — confirm no `int`/`float`/`multiline-text` table/filter
   contribution exists, yet `Length` (int) resolves the number cell+filter. `grep` the
   `data-view.cell`/`data-view.filter` contributions to confirm only base types register.
5. bool/enum/color/image — covered by build + check (typecheck + contribution discovery);
   no live consumer this batch (per scope decision).

## Risks / notes

- **Controls are live** — FilterBar renders them, so they must be functional (not the
  "carried, not rendered" stub the original number comment described). Confirmed against
  current `filter-bar.tsx`.
- **enum cell/filter read `field.options`**, not a registry — `FieldDef.options` already
  carries `{ value, label }[]`. No new coupling.
- **`coerce` drives sort** in `use-data-view-rows.ts`; bool→0/1 and date→ms keep sort sane.
- **Keep barrels pure** (no `const`/logic) and **CLAUDE.md prose-only** — both are
  push-check failures otherwise.
- **New workspace packages** need linking; `./equin build` handles install. If a fresh
  package isn't picked up, run `bun install` at repo root, then rebuild.
```
