# DataView avatar field

Status: **plan, awaiting approval.** Prerequisite of the Home app gallery redesign
([`2026-09-16-global-home-app-gallery-redesign.md`](2026-09-16-global-home-app-gallery-redesign.md)).

## Context

A DataView field today can only hold a scalar. `FieldDef.value(row)` must return
`string | number | boolean | Date | null | undefined`, because it is the
*comparable* projection that sort, filter, search and group-by all read. An
avatar is structured (`AvatarSpec = { icon, color, svgNodes }`), so no DataView
can show one as a field. The `avatar` type exists in the fields registry
(`plugins/fields/plugins/avatar/`) but has no DataView cell.

The workaround is a per-view option, named differently in each view: list
`leading`, gallery `leading`, tree `leadingIcon`. A consumer wires each view
separately, and switching a surface to another view in config silently drops the
avatar because nobody passed that view's option.

Outcome: a consumer declares a row's avatar **once, as a field**. Every view that
has a leading slot (list, gallery, tree) shows it there; the table shows it as a
column. Sort, filter, search and group-by are untouched.

Proven on the one real surface that draws an avatar today — the **agents list**
(`plugins/conversations/plugins/agents/web/components/agents-list.tsx`), whose
tree renders each agent's avatar through `viewOptions.tree.leadingIcon`. It must
look identical after the change.

## Design

### 1. A display-only projection on fields — `FieldDef.data`

`plugins/primitives/plugins/data-view/core/internal/types.ts`:

```ts
interface FieldDef<TRow> {
  // …existing keys…
  /** Structured, display-only projection. Read ONLY by the field type's cell
   *  (`TableCellProps.data`). Never sorted, filtered, grouped or searched — pair
   *  it with `value` if the field must also be comparable. */
  data?: (row: TRow) => unknown;
  /** This field is the row's leading visual (its avatar): list, gallery and tree
   *  render its cell in the row's leading slot, ahead of any per-view
   *  `leading`/`leadingIcon` content, and leave it out of the body. At most one
   *  per schema. The table keeps it as an ordinary column. */
  leading?: boolean;
}

interface TableCellProps {
  // …existing keys…
  /** `field.data(raw)` — the structured display projection, `unknown` at this
   *  boundary exactly like `raw` / `FieldDef.config`. */
  data?: unknown;
}
```

- Mirrors the existing second projection, `values` (tags), which rides the same
  `FieldCell` → `resolveCell` → `TableCellProps` pipeline.
- **`useResolveCell` keeps its signature.** It already receives `field` and the
  row, so it computes `data: field.data?.(row)` itself when building
  `TableCellProps`. That also covers the tree's primary label, which calls
  `resolveCell` directly.
- **Inert by construction — verified in code, no changes needed:**
  sort drops a rule whose field has no `value` (`web/internal/sort-rows.ts`),
  group-by refuses it (`isGroupableField`: `if (!field.value) return false`),
  the filter picker only lists types with a registered operator set (avatar has
  none), default search only indexes `text`/`enum`/`tags`, custom columns only
  offer identities with `customColumn: true` (avatar has none), and server-query
  compiles from a server-side column map, never `FieldDef`. The field-extension
  fold spreads whole `FieldDef`s, so the new keys survive it.
- It **does** appear in the Properties control, and hiding it there hides the
  avatar. That's intended.

### 2. Loud failure when nothing can draw the data

`web/components/field-cell.tsx`: `FieldCell` falls back to `String(value ?? "")`.
For a field with `data` and no `value`, that is an empty string. That hides the
mistake (e.g. the avatar cell plugin is missing from a composition). When a field
declares `data`, has no `cell` override, and `resolveCell` returns `undefined`,
**throw** a named error naming the field id and type. The slot's error boundary
contains it to that cell.

### 3. The leading field — resolver + one shared slot renderer

In `plugins/primitives/plugins/data-view/web/internal/`, beside
`pick-primary-field.ts`, exported from the data-view web barrel:

- **`pickLeadingField(fields)`** → the field with `leading: true`, or `undefined`.
  **Throws** if more than one declares it (an authoring mistake, caught on first
  render). No type-based fallback: data-view must not name a field type.
- **`LeadingSlot`** → renders `<FieldCell>` for the leading field, **followed by**
  the view's own per-view leading node. It returns `undefined` when there is
  neither, so `Row.icon` / `RowChrome.icon` see "no icon" exactly as today.
  One component, so the three views can't drift in order or composition.

**The field composes with the per-view option; it doesn't replace it.** Most
`leading` users put a status glyph or chip there, not an identity. The agents
list needs both: avatar, then status dot.

**Each view** resolves the leading field from the same visible set it already
computes (`vis = resolveBodyFields(fields, state.visibleFields)`). It then removes
that field from its primary-label pick and its body, as gallery already does for
its cover field:

| View | File | Leading slot | Exclude from |
|---|---|---|---|
| list | `plugins/list/web/components/list-view.tsx` | `Row`'s `icon` (with `options.leading`) | title pick, subtitle, trailing |
| gallery | `plugins/gallery/web/components/gallery-view.tsx` | `DataCard`'s `leading` (with `options.leading`) | title pick, property rows. **Not** the cover — cover stays media. |
| tree | `plugins/tree/web/components/tree-view.tsx` | `RowChrome`'s `icon` (with `options.leadingIcon`) | primary pick, `secondaryFields` |
| table | — | none; stays an ordinary column | nothing |

**Size needs no work.** `data-view-body.tsx` renders every view inside one
`ControlSizeProvider size="xs"`, on purpose, so row decorations match across
views. An `Avatar` reads that (16px), which fits the tree's 20px icon box.

### 4. The avatar cell — `plugins/fields/plugins/avatar/plugins/table/`

A new collapsed sub-plugin mirroring `plugins/fields/plugins/image/plugins/table/`
(`package.json` with `"singularity": { "collapsed": true }`, `CLAUDE.md`,
`web/index.ts`, `web/components/avatar-cell.tsx`):

- **Contribution:** `DataViewSlots.Cell({ match: "avatar", component: AvatarCell, chip: true })`.
  `chip: true` makes the list subtitle separate it by spacing, not ` · `, if it
  ever lands there (a disc glued to a middot reads wrong).
- **Payload type** (exported): `AvatarFieldData = AvatarSpec & { fallbackKey?: string }`.
  `AvatarSpec` comes from `@plugins/fields/plugins/avatar/core`. `fallbackKey` is
  render-time only (it seeds `Avatar`'s derived colour, which the gallery
  redesign's per-app tints rely on) and never touches the persisted spec type.
- **`AvatarCell`** renders `<Avatar icon color svgNodes fallbackKey />` from
  `props.data`. It **asserts the shape** and throws a named error on anything else.
- **Typed authoring helper** (exported): `avatarFieldDef<TRow>({ id, label, avatar: (row) => AvatarFieldData, leading?, visible? }): FieldDef<TRow>`
  sets `type: "avatar"` and `data`. It's the one spelling docs point to, so a
  wrong payload is a type error at the declaration, not a runtime surprise. It is
  deliberately **not** named `avatarField`, which is the unrelated config_v2
  factory in `fields/avatar/plugins/config`.
- **Dependencies:** `primitives/data-view`, `primitives/avatar`,
  `fields/avatar` (root core). No cycle: `fields/avatar/plugins/config` already
  depends on `primitives/avatar`, and data-view never imports `fields/avatar`.
  `./equin check plugin-boundaries` confirms.

### 5. Migrate the agents list

`plugins/conversations/plugins/agents/web/components/agents-list.tsx`:

- Add `avatarFieldDef<Agent>({ id: "avatar", label: "Avatar", leading: true, avatar: (a) => ({ icon: a.icon ?? DEFAULT_AGENT_AVATAR.icon, color: a.iconColor ?? DEFAULT_AGENT_AVATAR.color, svgNodes: parseSvgNodes(a.iconSvgNodes) ?? DEFAULT_AGENT_AVATAR.svgNodes, fallbackKey: a.id }) })`
  to `fields`.
- `viewOptions.tree.leadingIcon` shrinks to `(a) => <AgentStatus agentId={a.id} />`.
  `LeadingSlot` renders avatar then status, the same order as today.
- Drop the now-unused `Avatar` import.

Visible to the user: nothing in the tree, plus an "Avatar" entry in the list's
Properties control. The config (`config/conversations/agents/agents-list.jsonc`)
is unchanged; no view is added.

### 6. Docs

- `plugins/primitives/plugins/data-view/CLAUDE.md` — a "Structured display data
  (`data`)" section beside `values`, and a "Leading field" paragraph next to the
  `primary` field paragraph (under Hierarchy), stating composition order and
  per-view exclusion.
- `plugins/list/CLAUDE.md`, `plugins/gallery/CLAUDE.md`,
  `plugins/tree/CLAUDE.md` — the `leading` / `leadingIcon` option bullets:
  "rendered after the schema's leading field, if any".
  `plugins/table/CLAUDE.md` — one line: the leading field is an ordinary column.
- `plugins/fields/plugins/avatar/CLAUDE.md` — mention the new sub-plugin; the
  sub-plugin's own CLAUDE.md describes the cell, payload, helper and assert.
- The data-view slot list in its CLAUDE.md gains `avatar` among the Cell types.
- Autogen blocks and `docs/plugins-*.md` regenerate on `./equin build`.

## Tests (`./equin test <path>`)

Mirror `plugins/primitives/plugins/data-view/plugins/table/web/__tests__/inline-edit.test.tsx`:
a local `LoadedPlugin` that registers a fixture Cell, `<PluginProvider>`, and a
`renderProps(fields, rows)` helper, mounting the real view.

- **data-view core** (`web/__tests__/field-data.test.tsx`): a fixture cell for a
  synthetic type reads `props.data`; `FieldCell` passes it through; a field with
  `data` whose type has no cell throws (error surfaced, not blank);
  `pickLeadingField` returns the flagged field and throws on two.
- **Each of list / gallery / tree** (`plugins/<view>/web/__tests__/leading-field.test.tsx`):
  the leading field's cell renders in the leading slot, **before** the per-view
  `leading`/`leadingIcon` node. It is absent from the body (subtitle / property
  rows / secondary chips) and never becomes the title. With no leading field, the
  output is unchanged. Hiding it via `state.visibleFields` removes it.
- **table**: the leading field renders as an ordinary column.
- **Inertness** (pure, beside `sort-rows.test.ts` / `use-data-view-sections.test.ts`):
  a `data`-only field is ignored by `makeSortComparator` and refused by
  `isGroupableField`.
- **Avatar cell** (`plugins/fields/plugins/avatar/plugins/table/web/__tests__/avatar-cell.test.tsx`):
  renders an `Avatar` from a spec (svg present, colour class applied, fallbackKey
  honoured when colour is null); malformed `data` throws.

## Execution

Sequential in this worktree, so builds and edits don't collide:

1. **Agent (opus)** — data-view core: §1–§3 and §6 (data-view docs), with their
   tests. Load-bearing primitive.
2. **Agent (sonnet)** — avatar cell sub-plugin: §4, its docs and tests, against
   the types landed in step 1.
3. **Me** — §5 migration, `./equin build` (background), verification,
   review of the whole diff.

## Verification

1. `./equin test plugins/primitives/plugins/data-view plugins/fields/plugins/avatar` — all green.
2. `./equin build` (background); deploy receipt `status: ok`; the build's
   checks pass (`type-check`, `plugin-boundaries`, `plugins-registry-in-sync`,
   `plugins-doc-in-sync`, `eslint`).
3. **Pixel check on the agents list.** Screenshot the agents tree on main
   (`screenshot.ts --url http://singularity.localhost:9000 --path /agents …`) and
   on this deploy (`screenshot.ts --path /agents …`), light and dark, and compare.
   Avatars, colours, status dots and spacing must match.
4. In the deployed app: open the agents list's Properties control, hide "Avatar"
   (avatars vanish, status dots stay), show it again. Sorting and filtering the
   list offer no "Avatar" option.
5. Browser log (`~/.singularity/worktrees/<wt>/logs/`) shows no cell errors.

## Out of scope (follow-ups, not built here)

- An avatar **editor** cell (`AvatarPicker` inline) — `CellEditorProps.onCommit`
  takes scalars only.
- Migrating other identity-like `leading` users (pages sidebar / backlinks page
  icons) and gallery `cover` producers.
- The conversation sidebar's avatars (behind `renderRow` + the `Item.Avatar`
  dispatch slot).
- Everything in the Home gallery redesign (icons view, tile presentation,
  squircle shape, theme, capsule toolbar).
