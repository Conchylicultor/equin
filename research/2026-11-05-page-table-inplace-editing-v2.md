# Page table: Notion-like in-place cell editing (v2)

Supersedes [`2026-11-05-page-table-inplace-editing.md`](2026-11-05-page-table-inplace-editing.md)
after the prototype review (`proto-1793899037-y3apby`, v7 = the reviewed design + "Fit
to content").

## Context

A page `table` block (`plugins/page/plugins/table`) is only editable by opening its GFM
source. The user wants Notion-like editing in place. Agents keep reading and writing
GFM (`read_page`, `edit_page`, paste, copy as markdown).

## Decisions

- **Cells stay in the table's `data`** (`{ align, header, rows }`, each cell a
  `RichText`), as Notion does. Concurrent edits are last-writer-wins, narrowed to one
  cell by committing against the current data.
- **Column widths are DISPLAY-ONLY data**: `data.widths?: number[]` (px). They are kept
  by in-app copy/paste and duplicate (both carry raw `data` — `BLOCKS_MIME`,
  `serializeForest`), never written to markdown, and carried across an agent's
  rewrite. Lost only on a markdown round trip outside the app.
- The reviewed prototype is the spec, pixel for pixel, with neutral highlight
  colours mapped to theme tokens.

## 1. Editor core: display-only data fields (`page/editor/core`)

`code-block` already keeps `view` in `data` as "display state only — not part of
the markdown fence", with nothing enforcing it: an agent's `edit_page` resets it, and
the round-trip fuzz simply never generates it. This needs a name.

- `defineBlock({ displayOnly: ["widths"] })` → `BlockHandle.displayOnly: readonly
  string[]`. These are data keys that markdown does not carry.
- **Markdown serialize** strips them before the type's serializer or tag attributes
  see the data (`core/markdown.ts`'s walk).
- **markdown-apply** has two changes:
  - `identityKeyOf` strips them, so a resized table still aligns by content;
  - `survivorData` carries the stored row's display-only values onto the parsed
    data when the parse lacks them.
  - Effect: an agent editing a cell keeps the widths, and an unrelated edit to the
    page writes nothing to the table.
- `code-block` declares `displayOnly: ["view"]`.
- Tests: `markdown.test.ts` (stripped on serialize), `markdown-apply` plan tests
  (carried on a survivor, identity unaffected).

## 2. Editor web: `RichTextField` (exported)

This is a Lexical editor over a `RichText` held in `data` (no Y.Doc). It is seeded with
`runsToLexical` and read with `serializeBlockRuns`. It uses the page's nodes, theme
and marks:

- `LinkNode` + `blockTextNodes()`;
- `LinkPlugin`, `ClickableLinkPlugin`, `DecoratorNavPlugin`;
- `FormatShortcutsPlugin`, `FormatToolbarPlugin`, `TokenPastePlugin`;
- `HistoryPlugin` under `localUndoProps`.

API: `{ value, onCommit(runs), onKeyDown(e, caret) , caret: "start" | "end" | {x, edge} |
{ point }, className, ariaLabel }`. The caret is read via `readCaretContext`
(atStart / atEnd / onTopLine / onBottomLine / caretX), and placed with
`placeCaretAtBoundary` / `placeCaretAtColumn`. Shift+Enter is a soft break. A
multi-line paste lands as soft breaks.

## 3. Table core

- Schema: `widths: z.array(z.number().int().positive()).optional()`, `displayOnly`.
  `refine` does not check widths length. The renderer applies widths only while
  `widths.length === header.length`, so a rewrite that changed the column count
  falls back to auto widths until the next resize.
- `core/table-ops.ts` (pure, tested):
  - cells: `setCell` (r = 0 is the header);
  - rows: `insertRow`, `duplicateRow`, `clearRow`, `deleteRow`, `moveRow`;
  - columns: `insertColumn`, `duplicateColumn`, `clearColumn`, `deleteColumn`,
    `moveColumn`;
  - widths and alignment: `setAlign`, `setWidths`, `resizeColumn`.
  - Every operation keeps `align` and `widths` in step with the columns.
  - The header row cannot be deleted or moved, and the last column cannot be
    deleted.

## 4. Table web: the editable grid

`table-block.tsx` is rewritten, and the source mode is deleted. `TableView` stays the
read-only renderer, sharing cell styling and widths.

- **Editing:**
  - Only one cell is active at a time, and only it mounts a `RichTextField`.
  - Leaving a cell commits `editor.update(setCell(latest, r, c, runs))` against the
    latest data, read through a latest ref.
  - Enter on the selected table opens cell (0, 0).
- **Keys:**
  - Tab / Shift+Tab move to the next or previous cell, and Tab on the last cell
    appends a row.
  - Enter moves down, and appends a row from the last row. Shift+Enter is a soft
    break.
  - ↑/↓ cross rows from a cell's first or last line. At the table's edge the key is
    left to the caret host, which navigates to the neighbouring block.
  - ←/→ at a cell's text edge move to the previous or next cell.
  - Escape is left to the host, which selects the block.
- **Chrome** (measured from the DOM after each render, never from React state):
  - Slim grips on the left border of the hovered row and the top border of the
    hovered column.
    - A click opens a ControlPanelPopover:
      - row: Duplicate / Clear contents / Delete row;
      - column: Align segment / Fit to content / Duplicate / Clear contents /
        Delete column.
    - A drag reorders, with the source band tinted and a drop line.
  - An insert "+" appears near a border meeting the top or left edge, centred on
    the intersection. Hovering it previews the insertion line.
  - Add-row and add-column bars appear only beside the last row or last column.
  - Column resize from a column's right border (full height); double-click fits the
    column.
  - Neutral highlight colours (border / muted-foreground tokens), no accent.

## 5. Docs

- `table/CLAUDE.md`: replace the source-mode text with the editing model.
- `editor/CLAUDE.md`: add a "Display-only data" section and `RichTextField`.
- Update the `package.json` descriptions.

## Verification

- `./equin test` on table, editor core markdown and markdown-apply.
- `./equin check`.
- `./equin build`, then extend `table/e2e/table-verify.ts`:
  - type in a cell, Tab, append a row, use the insert "+";
  - row and column menus, drag reorder, resize, fit;
  - undo;
  - the markdown read back.
- Screenshot against the prototype.
