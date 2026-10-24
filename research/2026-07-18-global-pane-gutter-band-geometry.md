# Pane-gutter band geometry: one horizontal rail for DataView-in-pane

## Context

A DataView rendered in a pane currently stacks four different left rails: the pane
header (`Bar tier="pane"`, `px-chrome` = 12px), the DataView toolbar (`pl-sm` = 8px,
**no right padding at all** — trailing controls touch the pane edge), and each view
child's own body inset (gallery `p-xl` 24px, list/tree `p-sm`/`px-sm` 8px, table
0px). Vertically the toolbar is 0-top/8-bottom, and the toolbar→body gap flips
24 ↔ 8 ↔ 0 depending on the active view. The structural cause: the pane's band
geometry has no owner — every band inside the pane invents its own inset from the
generic spacing ramp.

Fix: a **pane-gutter contract**. One CSS variable (`--pane-gutter`) whose *default*
is the pane header's own inset token (`--chrome-pad-x`), read through named utility
classes by every band the DataView primitive owns. The pane header and the DataView
toolbar stay two separate bands — this is geometry only. The fix is generic: **zero
changes to app-level DataView consumers** (sonata/story/settings/… inherit it).

## Design

### The contract

- **Readers** use a new `px-pane-gutter` utility → `padding-inline:
  var(--pane-gutter, var(--chrome-pad-x))`. With that fallback, nothing needs to
  publish the var: the default rail auto-aligns with the pane header (12px
  comfortable, density-scaled 12/10/8), `css-vars-supplied` is satisfied, and
  **`PaneChrome` stays untouched**. The var is purely an override point.
- **Zero-setters** (hosts that already provide their own inset) use a
  `pane-gutter-flush` utility → `--pane-gutter: 0px`. No imports, no magic strings.
- **Custom-value setters** (none today) use the exported constant
  `PANE_GUTTER_VAR = "--pane-gutter"`, documented next to
  `DATA_VIEW_HEADER_OFFSET_VAR` (same host-publishes/consumers-read convention as
  `--chrome-mask` / `--dv-header-offset`).
- Utilities are **horizontal-only**; vertical rhythm uses the existing named ramp.

### Vertical rhythm (comfortable-density px)

- Toolbar: `py-sm` symmetric (8/8; was 0/8). The `pt` sits inside the
  `<Sticky mask>` element box, so the pinned state masks correctly.
- View bodies (list, gallery): `py-sm` top/bottom → uniform **16px** toolbar→body
  gap (was 16 vs 32). Gallery keeps `gap="lg"` internal card rhythm.
- Tree: horizontal-only change (`px-sm` → `px-pane-gutter`); no vertical additions
  (it dominates sidebars, which shouldn't loosen).

### Table (the hard part)

The table's rows are uniform-padded `col-span-full grid grid-cols-subgrid` rows
carrying `p-control` (= `--pad-control-y` / `--pad-control-x`). Since
`padControlX` **==** `chromePadX` (0.75rem) at every default, swapping horizontal
padding to the gutter is value-preserving. Mechanism: a new **opt-in
`gutter?: boolean` prop on `DataTable`** (default `false` — the ~8 non-data-view
consumers are byte-identical). When set:

- column-header row and each data row: `p-control` → `py-control px-pane-gutter`
  (new `py-control` utility, same `--pad-control-y`);
- group-header `StickyStackItem` (`col-span-full`): + `px-pane-gutter`.

Column alignment is preserved (identical padding on every subgrid row — the same
property that makes `p-control` work today), and masks/borders stay full-bleed
(padding insets the content box; the row div still spans the pane width).
`data-view/plugins/table` passes `gutter: true` in its `shared` object.
data-view/table must NOT import data-table's gutter value via data-view (illegal
back-edge) — the utility-class split is what makes this legal with zero imports.

*Documented fallback (not expected):* if the Sonata table screenshot shows column
misalignment, revert rows to `py-control` and instead pad the first/last cell of
every row (`pl-pane-gutter` / `pr-pane-gutter`, two extra utilities).

### GroupedSections simplification

With one shared gutter, the per-view `headerClassName` axis (`px-sm` / `px-xl`) is
meaningless: **delete it** and let `GroupedSections` own `px-pane-gutter` on its
`SectionHeaderRow`. Only list + gallery pass it today.

### detail-sections resolves double-padding generically

`defineDetailSections` content containers already provide their own inset
(`px-lg pb-lg` / `p-xl`); adding `pane-gutter-flush` there declares "the gutter is
already spent" for ANY DataView dropped into a detail section (Studio release
history, task-deps-tree, future ones) with zero per-consumer code. Inert for
non-DataView sections.

## Implementation steps

### 1. Utilities — `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css`

Model on `px-chrome` (line ~240):

```css
@utility px-pane-gutter { padding-left: var(--pane-gutter, var(--chrome-pad-x)); padding-right: var(--pane-gutter, var(--chrome-pad-x)); } /* twmerge: extend px */
@utility pane-gutter-flush { --pane-gutter: 0px; } /* twmerge: standalone -- pane-gutter override to 0 for a host that already supplies its own inset */
@utility py-control { padding-top: var(--pad-control-y); padding-bottom: var(--pad-control-y); } /* twmerge: extend py */
```

`./equin build` regenerates `custom-utilities.generated.ts`
(`app-css-utilities-in-sync`). Named-suffix utilities auto-pass `no-adhoc-spacing`;
no lint changes anywhere.

### 2. Constant — `plugins/primitives/plugins/data-view/core/internal/header-offset.ts`

`export const PANE_GUTTER_VAR = "--pane-gutter";` next to
`DATA_VIEW_HEADER_OFFSET_VAR`; re-export from `data-view/core/index.ts` +
`web/index.ts`. Contract documentation only.

### 3. Toolbar — both branches

- `data-view/web/components/toolbar/data-view-toolbar.tsx:107`:
  `"flex items-center gap-sm pb-sm pl-sm"` → `"flex items-center gap-sm py-sm px-pane-gutter"`.
- `data-view/web/components/data-view.tsx` no-instance placeholder: line ~268
  `px-sm pb-sm` → `py-sm px-pane-gutter`; line ~280 `<div className="p-md">` →
  `<div className="px-pane-gutter py-md">`.

### 4. View children

- **list** `plugins/list/web/components/list-view.tsx`: line ~267
  `className="p-sm"` → `"px-pane-gutter py-sm"`; line ~259 windowed
  `itemClassName="px-sm"` → `"px-pane-gutter"`; line ~285 drop
  `headerClassName="px-sm"`. Empty state untouched.
- **gallery** `plugins/gallery/web/components/gallery-view.tsx`: line ~277
  `<Grid gap="lg" className="p-xl">` → `className="px-pane-gutter py-sm"` (keep
  `gap="lg"`); line ~288 windowed wrapper `p-xl` → `"px-pane-gutter py-sm"` (inner
  Grid `pb-lg` at ~303 stays); line ~340 drop `headerClassName="px-xl"`; fix the
  comment at ~334. Empty state untouched.
- **tree** `plugins/tree/web/components/tree-view.tsx:402`: `px-sm` →
  `px-pane-gutter`.

### 5. GroupedSections — `data-view/web/internal/grouped-sections.tsx`

Delete `headerClassName` from `GroupedSectionsProps` + param; set
`<SectionHeaderRow className="px-pane-gutter">`; update JSDoc (~26-29).

### 6. Table

- `plugins/primitives/plugins/data-table/web/internal/data-table.tsx`: add
  `gutter = false` prop; header row (~166) and data row (~256): `p-control` →
  conditional `gutter ? "py-control px-pane-gutter" : "p-control"`; thread into
  `renderGroupedBody`; `StickyStackItem` (~438) `"col-span-full"` →
  `cn("col-span-full", gutter && "px-pane-gutter")`. Add `gutter` to
  `DataTableProps` in `./types`.
- `plugins/primitives/plugins/data-view/plugins/table/web/components/table-view.tsx`:
  add `gutter: true` to the `shared` object (~191).

### 7. Loading skeletons — `plugins/primitives/plugins/loading/web/internal/loading.tsx`

`rows` (~66) `p-sm` → `px-pane-gutter py-sm`; `cards` (~80) `p-xl` →
`px-pane-gutter py-sm`. Global (~100 consumers) but benign: outside a DataView the
gutter falls back to 12px; skeleton↔content alignment now holds by construction.

### 8. Host cleanups (the 3 double-padding sites)

1. `plugins/tasks/plugins/task-detail/web/panes.tsx:40`:
   `<Inset pad="lg">` → `<Inset pad="lg" className="pane-gutter-flush">` (Inset
   composes className — verified).
2. `plugins/primitives/plugins/detail-sections/web/internal/define-detail-sections.tsx`:
   `CollapsibleContent className="px-lg pb-lg"` (~63) → + `pane-gutter-flush`;
   non-collapsible `<Stack className="p-xl">` (~75) → + `pane-gutter-flush`.
3. `plugins/apps/plugins/workflows/plugins/definitions/web/components/definition-detail.tsx:90`:
   `<Surface level="raised" className="p-lg">` → + `pane-gutter-flush`.

### 9. Docs/comments

- `data-view/CLAUDE.md`: fix the GroupedSections code sample + "only per-view axis
  is headerClassName" prose; add a short **Pane gutter** note near Placement
  (contract, default, `px-pane-gutter`, `pane-gutter-flush`, `PANE_GUTTER_VAR`).
- `grouped-sections.tsx` JSDoc; `gallery-view.tsx:334` comment;
  `gallery/CLAUDE.md` + `list/CLAUDE.md` (headerClassName mentions).
- `data-table/CLAUDE.md`: document `gutter` (opt-in, default off = byte-identical);
  `data-view/plugins/table/CLAUDE.md`: note the opt-in.
- (`plugins-doc-in-sync` regenerates autogen blocks on build.)

## Verification

1. `./equin build` then `./equin check` (app-css-utilities-in-sync,
   type-check, plugin-boundaries, plugins-doc-in-sync).
2. Screenshots (`bun e2e/screenshot.mjs` / playwright) at
   `http://<worktree>.localhost:9000`:
   - `/sonata` gallery **and table** views: table columns still aligned (the #1
     confirm — fallback trigger); first column on the 12px rail == pane title;
     toolbar trailing controls 12px off the right edge; scroll → sticky
     column-header/group-header masks reach both pane edges.
   - `/story`: "Stories" title, "Gallery" chip, first card share one left edge;
     toolbar symmetric 8/8 vertical.
   - `/settings` config tree: 8→12px horizontal, no vertical loosening.
   - `/tasks`: tree no longer double-padded (host cleanup #1); list↔gallery
     toolbar→first-row gap both 16px.
   - Studio composition release history + Workflows definition detail: DataView
     aligns to the section/card inset, not 12px deeper.

## Known deltas / risks

- Sidebar hosts (pages sidebar, conversations queue/history, workflows sidebar,
  code-explorer tree) widen 8→12px horizontal — acceptable, tunable later via
  `PANE_GUTTER_VAR`/flush in one place if desired.
- Gallery edge inset tightens 24→12px (that is the point: rail alignment; internal
  card gaps stay `lg`).
- Loading rows/cards padding changes globally (falls back to 12px outside panes).
- Windowed list (>100 rows) toolbar→first-row gap is 8px (no vertical wrapper on
  the windowed path) — pre-existing divergence, not addressed here.
- Table/tree keep their own structural top offsets (sticky header `py-control`,
  tree row rhythm); only the list/gallery 16-vs-32 divergence is what's unified.
