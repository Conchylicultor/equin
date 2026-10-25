# DataView default chrome redesign

## Context

Every app's lists (tasks, conversations, logs, exhibits, …) render through the
`DataView` primitive, and its defaults read as heavy and noisy: boxed pill
surfaces around the view tabs and tools, an always-visible add-view `+`,
UPPERCASE column headers with a sort arrow on every column, group headers with
a hairline and an always-on chevron, accent-filled active tabs, filled chips
for every enum value, ragged trailing values in list rows, blank gallery
covers, and tree indents whose guides don't line up with anything.

The target look was iterated in prototype `proto-1792901792-4r3ei4` (and seen
inside the agent manager in `proto-1792903772-p6ydaf`). This pass ships its
**chrome** as the new defaults — every surface improves with no consumer code.
Old looks stay reachable through theme tokens. A semantic field `role` model
(status → leading glyph, time → right edge, path → low priority) is an explicit
**follow-up** task, not part of this pass.

User decisions: group style `caption` default (`rule` / `pill` selectable);
tree disclosure default = gutter chevron column; common-value elision in
list/tree rows only, and only when no row of the view has that field empty.

## Approach — five parallel workstreams (Opus agents)

All knobs are **data-view tokens** (enumerated values read by container style
queries — the `viewChipLabel` / `sortIcon` precedent) or a view-type
`configSchema` field. No new top-level primitive, no back-compat shims.

**Shared-file protocol.** `plugins/ui/plugins/tokens/plugins/data-view/core/group.ts`
is owned by WS1, whose *first step* lands every token below for all streams
(and rewrites its "defaults are the old look" doc comment). `data-view/core/internal/types.ts`
and `data-view/CLAUDE.md`: Edit-only, own sections only, re-read before
editing. Only one agent runs `./equin build` at a time (it regenerates token
var files); others use `./equin check type-check` / `./equin test`.

### WS1 — Group headers (owns the token file)

- New token `groupHeaderStyle: caption | rule | pill` (default `caption`),
  plus `groupPillFill`, `groupPillPadX`, `groupLabelInk = muted`, count role `group`.
- `DataViewGroupHeader` (`data-view/web/internal/group-header.tsx`) becomes ONE
  rendering `[identity][label][count][rule][chevron]` with
  `SectionHeaderRow disclosure="trailing"`; the rule shows only under `rule`,
  the label wraps in a soft pill under `pill`.
- `SectionHeaderRow` (`css/plugins/row/web/internal/section-header-row.tsx`):
  trailing chevron is revealed on hover/focus **and while collapsed** (prop
  `revealWhileClosed` if other `trailing` users must not change); `ruleClassName`.
- Delete `DataViewGroupHeaders`, `DataViewProps.groupHeaders`, `headerStyle`
  and the `quiet` branches in `grouped-sections.tsx` / list / icons / table;
  every style uses today's quiet rail placement. Drop the prop at its two
  consumers (conversations sidebar data-view, `op-status-banner.tsx`) — their
  look is unchanged (caption ≈ quiet).
- Tests: rewrite `web/__tests__/grouped-sections.test.tsx`; group block of
  `table-options.test.tsx` (with WS3). Docs: the `groupHeaders` and "Grouped
  sections" sections of `data-view/CLAUDE.md`.

### WS2 — Toolbar + gallery cover

- `toolbarPillSurface: flat | float` (default `flat`): `ToolbarPill`
  (`web/components/toolbar/pills-toolbar.tsx`) zeroes fill/border/shadow/blur/
  padding under `flat` — **overlay pills ignore it** (floating toolbar keeps its glass).
- View chips (`view-core/web/components/editable-view-switcher.tsx`): icon +
  name always; soft neutral active fill
  (`viewChipActiveFill = color-mix(foreground 7%)`, ink foreground, radius ~7px).
- `viewAddReveal: always | hover` (default `hover`): `dv.view-add` at opacity 0
  until the strip is hovered / focus-within / focus-visible (stays tabbable).
- Search always visible as the filled well, with a trailing `/` key hint
  (`searchShortcutHint: show | hide`); bind `/` → `focusSearch` if not already.
- Gallery `coverOf` (`plugins/gallery/web/components/gallery-view.tsx`): no
  cover and no leading field → a monogram tile (reuse `primitives/avatar`,
  title-hue tint) instead of a blank frame; `coverMonogram: show | hide`.
- Prototypes app theme (`apps/prototypes/plugins/shell/web/internal/theme.ts`)
  pins `toolbarPillSurface: float` + its old chip fill.
- Tests: `toolbar-arrangement`, `hosted-toolbar`, `sections-toolbar`, new
  gallery monogram test. Docs: "The default: two pills" → flat strip, "Floating chrome".

### WS3 — Table headers + table column captions

- `data-table/web/internal/data-table.tsx`: drop the hard-coded
  `uppercase tracking-wider` header; every presentation reads the
  `columnHeader*` tokens (new defaults: caption role, case `none`, tracking 0,
  faint ink, sorted column foreground). `sortIcon` gains `hover` (default):
  arrow on the sorted column only, others revealed on header hover. Applies to
  data-table's non-data-view consumers too (old look = `columnHeaderCase: upper`,
  `sortIcon: always`); spot-check studio/facet/heap/boot-profile tables.
- `configSchema: { columnCaptions: boolField }` on the table view
  (`plugins/table/web/index.ts`, `map/web/index.ts` precedent):
  `showHeader = options.columnCaptions ?? options.header ?? presentation !== "outline"`.
- Outline (tree) body wrapped in WS4's `FieldPresentationProvider` → quiet
  enums + elision in trees too.
- Tests: `header-sort`, `table-options`, `soft-look`, new captions test.
  Docs: "Table view options".

### WS4 — List rows: aligned slots, quiet enums, elision, list captions

- New `data-view/web/internal/field-presentation.tsx`:
  `FieldPresentationProvider({ rows, fields, rowsComplete })` →
  `{ presentation: "quiet", elided }` (FieldExtentsContext pattern).
  `TableCellProps.presentation?: "chip" | "quiet"` passed by `FieldCell`.
- Elision: candidates = chip-presenting fields (cell-registry flag — never name
  `enum`); hide a value held by ≥ 60% of the view's rows, **only if no row has
  that field empty** and only once the rows are complete (`rowsComplete`, so a
  paged read doesn't flicker). Scalar → empty slot (keeps width); multi →
  value filtered out. The table never mounts the provider.
- Enum / tags cells with `quiet`: `● label` (tint, else variant ink, else faint), no Badge.
- `list-view.tsx`: trailing fields in fixed-width aligned slots (measured
  max-width per field → CSS vars on the list root, grow-only, reset on view /
  field change; VirtualRows rules out subgrid); time-typed fields last, faint.
- `configSchema.columnCaptions` on the list: a header row with each field
  label over its slot. Remove `quietGroup` / `headerStyle` (with WS1).
- Tests: `row-lines`, `chip-separator`, `field-cell-token`; new elision
  (threshold, blocked by an empty, table unaffected) and quiet-enum tests.
  Docs: "Single-line list rows", "An option carries its own presentation", new
  "Quiet rows and common-value elision" (mention the `role` follow-up).

### WS5 — Tree geometry + default disclosure

- Density tokens (`ui/plugins/tokens/plugins/density/core/group.ts`): new
  `treeChevronW = 1.25rem`; `treeIndent = chevron + row gap`;
  `treeGuideX = chevron / 2` → guides sit under the parent's chevron, a child's
  chevron under the parent's icon (merged/dimmed-leaf: guide lands on the
  merged icon centre). Every chevron box (column variant, icon-less rows in
  `primitives/tree/web/internal/tree-leading.tsx`) uses `w-tree-chevron`.
- `ui/tree-disclosure`: `defaultVariant` + origin config → `column`; chevron
  40% at rest, full on row hover, focus-visible ring only. Pages / file-explorer
  keep their pinned `merged` and own indent tokens.
- Tests: `nested-guides-selection`, tree primitive tests, new geometry test.
  Docs: data-view "Hierarchy", tree-disclosure CLAUDE.md, density token comments.
- Risk: unthemed trees indent ~16 → ~24px; screenshot sidebars.

## Must stay true

Fail loudly; collection-consumer separation (data-view decides chip vs quiet
from cell metadata; tree never imports tree-disclosure); boundary checks pass
(`./equin check boundary-rules`, `plugin-boundaries`); floating toolbar keeps
surfaces; table and GroupedSections share one header node.

## Verification

1. `./equin build` (once, after all streams), `./equin test` on each stream's paths, `./equin check`.
2. `screenshot.ts` on `/agents/tasks` (tree, list, gallery), `/agents/all-conversations`
   (+ the sidebar, must look unchanged), `/debug/logs`, `/debug/exhibits`, a
   map surface (floating toolbar), pages + file-explorer trees (unchanged) —
   default and the prototypes app theme.
3. `compare-diff.ts --name proto-1792901792-4r3ei4` against `/agents/tasks`.
4. Hover/keyboard checks: `+` reveals on strip hover and Tab focus; group
   chevron reveals on hover and stays while collapsed; captions toggle from
   view settings persists.

## Follow-up (separate task)

Field `role` model: `FieldDef.role` + `FieldPresentationSpec.role` (declared
once per entity field via `FieldPresentation.Register`), driving leading /
trailing / drop-order defaults; adopt on tasks, conversations, logs, exhibits.
