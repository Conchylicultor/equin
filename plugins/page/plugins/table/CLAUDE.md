# table

A GFM pipe table as a page block, edited in place like Notion's. Its payload is
data only — no `text` key, so no content doc: `{ align, header, rows, widths? }`,
every cell a `RichText`, every row and `align` exactly `header.length` wide (≥ 1
column), held by the handle's `refine` rather than a zod refinement (which would
take the schema's `.shape` away). Design:
[`research/2026-11-05-page-table-inplace-editing-v2.md`](../../../../research/2026-11-05-page-table-inplace-editing-v2.md).

## Column widths are display-only

`widths` (px per column) exists once a column was resized; absent, the table
sizes its columns to their content and fills the column. It is declared
`displayOnly` (see the editor's CLAUDE.md, *Display-only data*): never in the
markdown, carried across an agent's rewrite, kept by in-app copy / duplicate.
So it is NOT held to the header's width — a rewrite that changed the column
count keeps a stale list — and `columnWidths(data)` is the one read: the widths
while they match the columns, else `null` (content-sized). `resizeColumn`
replaces a stale list with the drawn widths.

## Editing in place (`web/components/table-block.tsx`)

- **One active cell**, the only one mounting an editor (`RichTextField`); the
  rest are painted by `RunsRenderer`, exactly as `TableView` paints them
  (`table-cells.tsx` holds the shared look).
- **A cell is written when it is LEFT** — another cell, a structural action, the
  caret leaving the block — as one `editor.update` (one undo entry; ⌘Z inside an
  open cell undoes keystrokes). `write(change)` folds the pending draft in and
  computes against the block's CURRENT data, never a snapshot: a cell write
  replaces that cell only, so a concurrent edit to another cell survives.
- **Keys** (`onKey`, given where the field's caret stands): Tab / Shift+Tab walk
  the cells (Tab on the last appends a row); Enter moves down (appending from
  the last row); ↑/↓ cross rows from a first/last line; ←/→ cross cells at a
  text edge; Escape writes the cell and selects the table (selection mode, as
  Escape does in a text block). Not taken: Shift+Enter (the field's soft
  break), ↑/↓ past the table (the caret host's — the next block). Enter on the
  selected table opens its first cell.
- **Clicking in does not change the table's look**: an open cell holds the
  caret (`useInnerCaret`), so the editor's block-level caret cue (the tint)
  steps aside — only the cell's own ring shows. The tint is back when the
  table itself holds the caret (arrowed onto from the block above).
- **Row 0 is the header** on every grid axis (`web/internal/table-ops.ts`, pure
  and tested): it is never deleted, duplicated, moved, or moved above.

## Chrome (`web/components/table-chrome.tsx`)

Placed from the table's geometry, measured from the DOM after every render
(`web/internal/table-geometry.ts`) — never from state, so a just-inserted
column has no chrome until it is drawn.

- Slim grips ON the left border of the hovered row / top border of the hovered
  column: click → its menu (row: Duplicate / Clear contents / Delete; column:
  Align / Fit to content / Duplicate / Clear contents / Delete), drag → move it.
- Insert points: a "+" centred where a column border meets the top edge (a row
  border the left edge), shown as the pointer comes NEAR (`insertPointNear`);
  hovering it draws the insertion line.
- Add bars beside the last row / last column, only while it is hovered.
- A resize handle on every column's right border; a drag previews locally and
  writes ONCE on release; double-click (or the menu) fits the column to its
  content.
- Highlights are neutral (muted foreground), never the accent.

## Markdown: the one `lineRun` declarer

A table has no closing line, so it is neither a `parseLine` (one line) nor a
`fence` (open…close): it declares `markdown.lineRun`, the editor's third claim
kind (see the editor's CLAUDE.md, *Markdown is a LOSSLESS PROJECTION*). Every
line that opens with `|` belongs to a run; `parse` takes a header, a delimiter
row exactly as wide, then body rows, and reports how many lines that was. No
delimiter row ⇒ it declines, and the first line is prose.

**Adjacent tables.** Our dialect puts nothing between two sibling blocks, so two
tables in a row are one unbroken run of `|` lines. The rule that splits them:
**a line followed by a delimiter row as wide as itself starts a new table.**
Body rows run until that, or the end of the run. Ragged rows are padded or
truncated to the header's width, as GFM reads them — canonical after one round.

## Two escape layers, kept disjoint

`core/gfm-table.ts` owns the table layer; the inline layer
(`ctx.mdLine` / `ctx.runs`) owns everything else, and neither knows the other's
spellings.

- A literal `|` in a cell is `\|`. A cell that would read as a delimiter cell
  (`---`, `:-:`) is written `\---` — otherwise a body row made of them is a
  delimiter row, and the row above it becomes the header of a new table.
- Every scan (split, escape, unescape) walks the same units left to right: a
  PROTECTED SPAN matched at the scan position (`\(a|b\)`, `[[page:…]]` —
  verbatim, never split), a BACKSLASH PAIR `\X` as one unit (so `\\|` is a
  literal backslash then a separator), or one character. Spans are matched
  anchored, never by a global search over the row, which could match a span
  across a cell boundary.
- Cells are written through `ctx.mdLine`, so a soft break is `\n` in every
  dialect — a real newline would end the row, clipboard included.
- A cell's edge whitespace is not kept (GFM trims cells).

The block-level `\|` that escapes a PARAGRAPH opening with a pipe is the
editor's line-claim escape, not this file's.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Table block type: a GFM pipe table edited in place like Notion's — click a cell and type, Tab between cells, grips to move / duplicate / delete rows and columns, insert points, add bars and column resizing (widths are display-only data, never in the markdown). Table block type: registers its `data` schema (column alignment, header cells, body rows) at the server write boundary.
- Web:
  - Contributes: `Editor.Block` "table" → `TableBlock`
  - Uses: 27 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `page/editor` ×11
    - `primitives/css/coords` ×4
    - `primitives/css/control-panel` ×2
    - `primitives/latest-ref` ×2
    - `page/read-only-view.RunsRenderer`
    - `primitives/css/center.Center`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/spacing.Inset`
    - `primitives/css/text.textVariantClass`
    - `primitives/css/toggle-chip.SegmentedControl`
    - `primitives/css/ui-kit.cn`
    - `ui/icons.Icon`
- Server:
  - Contributes: `page.block-data` "table"
  - Uses: `page/editor.Editor`
- Core:
  - Uses:
    - `page/editor.defineBlock`
    - `page/editor.MdParseCtx`
    - `page/editor.RichText`
    - `page/editor.RichTextSchema`
    - `primitives/css/text.typeVar`
    - `ui/icons.symbol`
  - Exports (types):
    - `TableAlign`
    - `TableData`
  - Exports (values):
    - `columnWidths`
    - `tableBlock`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --background`
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/shadow --shadow-xs`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-weight-medium`

<!-- AUTOGENERATED:END -->
