# Page table: Notion-like in-place cell editing

## Context

Today a page `table` block (`plugins/page/plugins/table`) can only be edited by opening
its GFM source in a textarea (`web/components/table-block.tsx`). The user wants to edit
it like Notion: click a cell and type, Tab between cells, and add or remove rows and
columns from hover chrome. Agents keep reading and writing tables as GFM markdown
(`read_page`, `edit_page`, paste, copy).

The original design anticipated this step (`research/2026-09-29-page-table-block.md`:
"Notion-style cell editing … later; `data` shape stays, cells become editable fields").

Decisions (asked the user):

- **Cells stay in the table's `data`** (`{ align, header, rows }`, each cell a
  `RichText`). This is Notion's own model: cells are row properties, not blocks. Cells
  as child blocks with their own CRDT docs were rejected, because the editor renders a
  flat vertical row list and has no grid layout. Accepted cost: concurrent edits are
  last-writer-wins per table write, narrowed to one cell (see 3).
- **Prototype first.** The interaction design is settled in a prototype and reviewed
  before implementation.

## Phase 0 — prototype (review gate)

`./equin prototype new "Page table — in-place editing"`, designed from the blank
template (`prototypes/CLAUDE.md`). One prototype, a page column holding a paragraph, a
table, and a paragraph. It shows:

- At rest the table looks like today's (header row tinted, bordered cells).
- **Click a cell to edit it in place.** The caret goes where you click. The active cell
  gets a focus ring. Bold, italic and code shortcuts work.
- **Keys:**
  - Tab / Shift+Tab move to the next or previous cell. Tab on the last cell appends a
    row.
  - Enter moves to the cell below, and appends a row from the last row.
  - Shift+Enter is a soft break.
  - ↑/↓ on a cell's first or last line move to the cell above or below. Past the table
    they leave to the neighbouring block.
  - ←/→ at the edge of a cell's text move to the previous or next cell.
  - Escape leaves editing with the table selected.
- **Hover chrome:**
  - a thin "+" bar under the table (add row) and right of it (add column);
  - a row grip at the left of the hovered row and a column grip above the hovered
    column;
  - a grip opens a menu:
    - row: Insert above / Insert below / Duplicate / Delete;
    - column: Insert left / Insert right / Align left·center·right / Duplicate /
      Delete.
- An `option` pill for the open choices: Enter moves down vs Enter is a newline.

Implementation then matches the reviewed prototype pixel for pixel.

## Phase 1 — implementation

### 1. Editor: a reusable rich-text field over a `RichText` value (`page/editor/web`)

There is no in-place editor today for a `RichText` held in `data`. Every Lexical
instance in the editor is bound to a block's Y.Doc (`collab-text-plugin.tsx`, keyed by
block id). Add one primitive, exported from the editor's web barrel:
`RichTextField({ value, onCommit, onNavigate, caret, ariaLabel })`.

- It is a Lexical composer seeded from `runsToLexical` (`editor/core/runs-lexical.ts`)
  and read back with `serializeBlockRuns`. It uses the page's registry-bound nodes and
  tokens: `blockTextNodes()`, `blockTextTokenExtensions()` and `blockTextRunsOptions()`
  in `web/internal/block-text-extensions.ts`.
- It reuses the plugins that take no block context: `FormatToolbarPlugin`,
  `FormatShortcutsPlugin` and `TokenPastePlugin`. Plain-text paste of multi-line text
  becomes soft breaks.
- It has local history (Lexical `HistoryPlugin`) under `localUndoProps`. While a cell
  is open, ⌘Z undoes keystrokes. The page stack records the commit (same contract as
  today's source draft and `BlockTextArea`).
- `onNavigate(dir)` reports the edge moves (tab, shift-tab, enter, up/down at the
  first/last line, left/right at a text edge, escape) and `preventDefault`s them, so
  the void caret host leaves them alone (`void-caret.tsx`: ↑/↓/Escape are skipped when
  `defaultPrevented`).
- `caret: "start" | "end" | { x, y }` places the caret on mount. A click places it at
  the point; arrival from a neighbouring cell places it at the start or end.

Doc-bound plugins (`KeyboardPlugin`, `InlineMarkdownPlugin`, `BlockMenuPlugin`,
`MarkdownShortcutPlugin`) are not used in a cell: no block split, merge or slash menu.

### 2. Table core: pure grid operations (`table/core/table-ops.ts` + tests)

These functions take `TableData` and return `TableData`, and preserve the width
invariant `refine` checks:

- `setCell(d, r, c, runs)` (r = 0 is the header);
- `insertRow(d, at)`, `deleteRow`, `duplicateRow`;
- `insertColumn(d, at)`, `deleteColumn`, `duplicateColumn`, `setAlign(d, c, align)`.

Deleting the last column, or the header row, is not offered: a table has ≥ 1 column
and GFM requires a header.

**Storage is unchanged.** The `data` schema, `markdown.serialize`, the `lineRun` parse,
the read-only `TableView` and the server registration all stay as they are. So no
migration is needed, and the agent-facing GFM is byte-identical.

### 3. Table web: the editable grid replaces source mode

`table-block.tsx` is rewritten, and the source textarea, `tableSource`,
`parseTableSource` and the "Edit source" button are deleted. It becomes:

- `EditableTable`, sharing `TableView`'s cell styling. The shared `CELL` class and
  `alignStyle` are pulled into a small internal module both import.
  - The cells at rest render `RunsRenderer`.
  - Only the **active cell** mounts `RichTextField`, so at most one Lexical instance
    per table.
- Active-cell state `{ r, c, caret } | null`. `useBlockActivate` (Enter on the selected
  table) opens cell (0, 0).
- **Commit narrows the race to one cell.** On leaving a cell, the code re-reads the
  block's *current* `data` and writes
  `editor.update(setCell(current, r, c, runs))`. Nothing is written when the runs are
  unchanged. A concurrent agent edit to other cells survives.
  - Structural menu actions are one `editor.update` each, so each is one undo entry.
  - Check during implementation: the 500 ms `coalesceKey: blockId` window in the undo
    stack (`primitives/undo-redo/web/internal/stack.ts`) may merge two quick cell
    commits into one undo step. If that reads wrong, give the cell commit its own
    coalesce key.
- Hover chrome and grip menus are built from the existing primitives (`IconButton`,
  the menu primitive, `hoverRevealGroup`) as the prototype shows. The table stays a
  `WideBlock` inside `Scroll axis="x"`.

### 4. Docs

- `table/CLAUDE.md`: drop "in-place markdown source mode". Add "Editing in place" (the
  one-active-cell rule, commit-on-leave against the current data, key map).
- Update the `package.json` description.
- `editor/CLAUDE.md`: a short `RichTextField` section, covering when to use it (a
  `RichText` in `data`) versus the block's doc.

## Out of scope (follow-ups to file)

- Column widths, header-column toggle, and drag-reordering rows or columns. GFM cannot
  carry widths, so widths would need a tag spelling.
- Multi-cell selection and copy/paste of a cell range.
- Per-cell live collaboration (would need cells as CRDT-backed blocks).

## Critical files

- `plugins/page/plugins/table/web/components/table-block.tsx` (rewrite) and
  `table-view.tsx` (shared cell styling).
- `plugins/page/plugins/table/core/table-ops.ts` (new) and its test.
- `plugins/page/plugins/editor/web/components/rich-text-field.tsx` (new), exported from
  `editor/web/index.ts`.
- Reused:
  - `editor/web/internal/block-text-extensions.ts`;
  - `editor/core/runs-lexical.ts`;
  - `format-toolbar-plugin.tsx`, `format-shortcuts-plugin.tsx` and the token paste
    plugin;
  - `void-caret.tsx` / `useBlockActivate` / `useCaretEscape`.
- `plugins/page/plugins/table/e2e/table-verify.ts` (extend).

## Verification

- `./equin test plugins/page/plugins/table` covers the table-ops cases (width
  invariant, header protection) and the existing `gfm-table` round trip.
- `./equin check` covers boundaries, type-check and the markdown fuzz round trip.
- `./equin build`, then extend `table-verify.ts` against the build:
  - click a cell, type, and check the cell text;
  - Tab to the next cell; Tab on the last cell appends a row;
  - add a column from the "+" bar;
  - delete a row from its grip;
  - ⌘Z restores it;
  - Escape leaves with the table selected;
  - ↓ past the last row lands in the next block;
  - the table's markdown (read back via the page's serialize) equals the expected GFM.
- Screenshot the editable table and the hover chrome, and compare them with the
  prototype (`compare-diff.ts`).
