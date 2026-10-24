# Page table block (display-only GFM table)

## Context

Agents write GFM pipe tables into pages (`write_agent_note` / `edit_page`), e.g. the
comparison table in the "Chord song player" page. Chat renders them (remark-gfm in
`primitives/markdown`), but pages parse markdown into blocks through
`parseMarkdownToForest` (`plugins/page/plugins/editor/core/markdown.ts`), and no block
type claims `|` lines — each row lands as a text paragraph showing raw pipes (and `\~`,
the inline escape of `~`). `markdown.test.ts:~1229` even pins this: "Tables have no block
type yet."

Goal (option A): a `table` block that renders a real table, round-trips GFM markdown
losslessly for agents, becomes the target of pasted GFM tables, and is edited by
rewriting its markdown (agent edit, or an in-place source toggle). Cell-level
Notion-style editing is a later step that keeps the stored shape.

## Design

### 1. Editor core: a generic `markdown.lineRun` claim

GFM tables have no closing delimiter, so neither `parseLine` (one line) nor `fence`
(open…close) fits. Add a third, type-agnostic claim kind to `BlockMarkdown<T>`
(`editor/core/markdown.ts:~360`):

```ts
lineRun?: {
  /** Sample FIRST lines this claimer takes (fed to the escape check, like parseLine.claims). */
  claims: readonly string[];
  /** Does this line belong to a run? Line-local, probed one line at a time. */
  matches(line: string): boolean;
  /** Parse the LONGEST accepted prefix of the run; null ⇒ decline (lines fall to prose). */
  parse(lines: readonly string[], ctx: MdParseCtx): { data: T; consumed: number } | null;
};
```

- **Dispatch** (`claimersOf` / `claimOf`, MD:~1026-1090): runs are consulted after
  fences, before `parseLine` claimers; `claimOf` stays a single-line authority (first line
  `matches`), so `claimSafeLines` / `stealerOf` / `markdownLineClaim` keep working
  unchanged — a prose paragraph starting with `|` serializes as `\|…`, and the existing
  decode branch (MD:~1500) strips it.
- **Parse loop** (beside the fence branch, MD:~1459): collect lines `i..j` that are
  non-blank, at the SAME indent (explicit compare, so an indented child table is not
  swallowed) and `matches(dedent(line))`; call `parse`; push one token, advance by
  `consumed`, and loop on the remainder of the run. On `null`, emit the first line as
  prose (it then re-serializes escaped: lenient parse, canonical serialize).
- **Serialize**: relax the one-line assertion (MD:~1164) to exempt `fence` OR `lineRun`
  types, and additionally assert every emitted line `matches` (else lines 2..n would
  fan out into siblings).
- **Protected spans in ctx**: cell splitting must not split inside a protected span
  (`\(a|b\)` inline math, `[[page:…]]`). Expose `protectedSpans` on `MdParseCtx` and
  `MdSerializeCtx` (they already close over it in `parseCtxFor`).
- **One-line cells in every dialect**: add `ctx.mdLine(runs)` to `MdSerializeCtx` — the
  inline serializer forced to `softBreaks: "escaped"`, so a soft break inside a cell is
  `\n` even in the clipboard dialect instead of breaking the row.
- **Check** `page.editor:markdown-claims-are-escapable` (`editor/check/index.ts:544`):
  also sample `lineRun.claims` (claimed by the type; `\`+sample claimed by nobody).

### 2. New plugin `plugins/page/plugins/table/`

Template: `code-block` / `divider`.

- `core/table-block.ts` — `defineBlock({ type: "table", … })`:
  - schema (no `text` key ⇒ text-less, data-only; stored in `page_blocks.data`):
    `{ align: ("left"|"center"|"right"|null)[], header: RichText[], rows: RichText[][] }`
    with a refinement: every row and `align` have `header.length` cells (≥1 column).
    `RichText` / `RichTextSchema` from `editor/core/rich-text.ts`.
  - `label: "Table"`, `icon: symbol("table")`, aliases `["grid","gfm","columns"]`,
    `empty()` = 2 columns, 1 header + 2 empty body rows. No `typingPrefixes` (`| ` is
    quote's typing prefix; unchanged).
  - `markdown.lineRun`:
    - `matches`: `/^\|/`.
    - `parse`: line 0 = header, line 1 must be a delimiter row (`|:--|--:|:-:|`) else
      `null`; body rows continue until a line that is itself followed by a delimiter row
      (that line starts the next table — this is how two ADJACENT tables round-trip, since
      our dialect has no separator between blocks). Rows are padded / truncated to the
      header width (GFM semantics; canonical after one round).
    - `serialize`: `| h1 | h2 |` / delimiter from `align` (`---`, `:--`, `--:`, `:-:`) /
      body rows. Cell = `ctx.mdLine(runs)` then escape `|` → `\|` outside protected spans.
    - Cell parse = split on unescaped `|` outside protected spans (a `\\` pair is skipped
      as a unit), trim, unescape `\|` → `|`, then `ctx.runs(cell)`. The block-level `\|`
      and inline escapes stay disjoint layers.
  - Put split / escape helpers in `core/gfm-table.ts`, unit-tested
    (`core/gfm-table.test.ts`).
- `server/index.ts` — `Editor.BlockData(tableBlock)` (required by
  `block-data-registered`).
- `web/index.ts` — `Editor.Block({ id, match, block: tableBlock, component: TableBlock,
  caret: "editor" })`; `caret: "editor"` = void block (selection, arrows,
  Backspace-delete come from the editor host, like divider).
- `web/components/table-view.tsx` — pure `TableView({ data })`: `<table>` using the chat
  renderer's classes (`primitives/markdown/web/internal/base-components.tsx:112-125`:
  `border-collapse`, `border border-border`, `bg-muted` header, `px-sm py-xs`), column
  `textAlign` from `align`, cells via `RunsRenderer`
  (`page/read-only-view/web`, handles marks/links/inline chips). Wrapped in
  `Inset x={BLOCK_INSET}` + horizontal overflow scroll for wide tables. Set
  `gutterFirstLineCenter` to seat the rail on the header row.
- `web/components/table-block.tsx` — `TableView` + the source toggle (step 4).

### 3. Read-only view: a generic seam, not a hardcoded type

`read-only-view` (version history, public site) would show a placeholder card, and it
cannot import `table` (cycle: table imports `RunsRenderer` from it) — and its CLAUDE.md
forbids naming types. Add an optional `view?: ComponentType<{ data }>` to the text-less
`Editor.Block` registration (`editor/web/slots.ts`, `BlockRegistration`); `NodeView`
(`read-only-blocks.tsx`) renders it generically, above the `isTextLike && hasText` arm.
Table registers `view: TableView`. (Migrating the hardcoded `MEDIA_TYPES` divider /
code-block / image to this seam is a natural follow-up, out of scope.)

### 4. Edit as markdown source

A small "Edit source" affordance (hover icon button, and Enter on the selected block)
swaps `TableView` for a `BlockTextArea` holding the table's GFM (serialized with the
same `serialize`). Commit on blur / Esc / mod+Enter: parse with the table's own
`lineRun.parse`; valid ⇒ `editor.update(data)` (one undo entry); invalid ⇒ stay in
source mode with an inline error, nothing written. A local draft (not
`useBlockPlainText`'s per-keystroke write) because every intermediate keystroke is not a
valid table. Per the `no-unhistoried-block-field` lint, use `BlockTextArea` (or
`localUndoProps` if it stores nothing until commit — decide at implementation).

### 5. Tests to update / add (`editor/core/markdown.test.ts`)

- Rewrite the pinned "table body does not become quote blocks" test (~1229): the same
  paste now yields one `table` block (and still no quote).
- New `describe("line run")` mirroring `describe("code fence")` (528-605): parse,
  alignment, escaped pipes, protected-span pipes, `\n` in a cell, ragged rows padded,
  decline without delimiter row → prose, `\|` prose escape round trip, nested table at
  deeper indent is a child not a continuation, two adjacent tables, table inside a tag
  body.
- Add a `table` generator to the round-trip fuzz `gens` (~2157) — required by "the
  generator covers EVERY registered block type"; cells drawn from the existing run
  alphabet plus `|`.

## Out of scope / follow-ups

- Existing pages keep their raw-pipe paragraphs (they are text blocks). After deploy,
  the owning agent re-writes its note (e.g. the Chord page card) — no migration.
- Notion-style cell editing (click a cell, Tab between cells, add/remove rows/cols,
  per-cell collab): later; `data` shape stays, cells become editable fields.
- Moving divider / code-block / image read-only rendering onto the `view` seam.

## Critical files

- `plugins/page/plugins/editor/core/markdown.ts` — `BlockMarkdown`, `claimersOf`,
  `claimOf`, parse loop, `claimSafeLines`, ctx types.
- `plugins/page/plugins/editor/check/index.ts` — escape check samples.
- `plugins/page/plugins/editor/core/markdown.test.ts`.
- `plugins/page/plugins/editor/web/slots.ts` — `view` on text-less registrations.
- `plugins/page/plugins/read-only-view/web/components/read-only-blocks.tsx` — dispatch.
- New `plugins/page/plugins/table/{core,server,web}` + `CLAUDE.md` (note the line-run
  claim and the adjacent-table rule).
- `plugins/page/plugins/editor/CLAUDE.md` — document `lineRun` in the "Markdown is a
  LOSSLESS PROJECTION" section.

## Verification

1. `./equin test plugins/page/plugins/editor plugins/page/plugins/table
   plugins/page/plugins/markdown-apply` — fuzz round trip, new line-run suite, planner
   unchanged.
2. `./equin check` (escape check, block-data-registered, boundaries, docs).
3. `./equin build`, then on the worktree deploy: `write_agent_note` into a scratch
   page with the Chord comparison table (incl. `\~`, bold, a `|` in code) — screenshot
   via `e2e-harness/e2e/screenshot.ts --path <page>`; `read_page` returns the identical
   GFM; a second identical write is a no-op (planner converges).
4. Paste a GFM table from the clipboard → one table block; copy the block → GFM text.
5. Source toggle: edit a cell, commit, undo restores; invalid source shows the error
   and writes nothing.
6. Version-history preview of the page renders the table (read-only `view` seam).
7. Add a standalone `table/e2e/table-verify.ts` covering 3–5.
