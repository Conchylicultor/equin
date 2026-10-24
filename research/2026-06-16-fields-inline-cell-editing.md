# Pluggable inline cell editing for `data-view` (extensible property types)

## Context

The task: *"Inline database column property types are a fixed built-in set, not extensible.
Inline database cell editors are a private co-located switch over six built-in types
(text/number/enum/date/bool/tags)… It should instead reuse the field primitives from the
data view (eventually create a new per-field sub-plugin `fields/plugins/{field-name}/plugins/inline`)."*

**Verified ground truth (the premise is partly outdated):** there is **no** private six-type
cell-editor switch anywhere in the codebase. The "inline database" is the **`data-view`**
primitive (`plugins/primitives/plugins/data-view/`) — a Notion-like multi-view surface that
**already** has fully pluggable, per-field-type **cell rendering** (`data-view.cell` slot) and
**filtering** (`data-view.filter` slot), each contributed by `fields/plugins/<name>/plugins/{table,filter}`
sub-plugins and resolved through the `extends`-chain (`resolveTypeChain` from `@plugins/fields/core`).

What is **genuinely missing** is pluggable inline cell **editing**. `data-view` renders read-only
cells; no per-type inline editor capability exists. This plan delivers exactly that, structurally
identical to the existing `data-view.cell` capability, so any plugin can contribute an editable
property type with zero `data-view` changes — fulfilling the task's real intent
("reuse the field primitives", "new `fields/plugins/<name>/plugins/inline` sub-plugin").

Outcome: `data-view` gains an **opt-in** editable-cell capability that is a **zero behavior
change** for all 60 existing read-only consumers; editing activates only when a field provides a
write-back callback. New field types contribute editors the same way they contribute cells/filters.

## Design (one tier above `data-view.cell`, mirrored byte-for-byte)

1. **New slot `data-view.cell-editor`** (owned by `data-view/web`), resolved by a new
   `useResolveCellEditor()` that walks the same `extends` chain as `useResolveCell()`.
2. **`CellEditorProps`** contract `{ value, field, raw?, onCommit(next), onCancel() }` —
   mirror of `TableCellProps` plus a commit/cancel channel.
3. **`FieldDef.onEdit?(row, next)`** — per-field opt-in write-back. Present ⇒ the table cell is
   editable; absent ⇒ read-only (the default for every existing consumer). Persistence is
   **consumer-owned**; `data-view` stays presentational (no `optimistic-mutation` coupling).
4. **Per-field `fields/plugins/<name>/plugins/inline`** sub-plugins for **text, number, bool,
   enum, date** (the exact peer of the existing `plugins/{table,filter,config}` trio). `int`,
   `float`, `multiline-text` inherit via the `extends` chain — no new sub-plugins. **tags is a
   follow-up** (multi-value `values` projection).
5. **Table view** wires editing through a new `EditableCell` wrapper (click-to-edit, Enter/blur
   commit, Esc cancel, `stopPropagation` so cell edit never triggers row activation). Other views
   (gallery/list/tree) are follow-ups.

## Files

### data-view (capability owner)
- **NEW** `plugins/primitives/plugins/data-view/web/cell-editor-slot.ts` — copy of `web/cell-slot.ts`;
  `defineDispatchSlot<CellEditorProps>("data-view.cell-editor", {...})` + `useResolveCellEditor()`
  (5-arg renderer: `field, value, raw, onCommit, onCancel`). Reuses `useFieldIdentities()` +
  `resolveTypeChain` (no `fields/web` import edge).
- **EDIT** `core/internal/types.ts` — add `CellEditorProps` (next to `TableCellProps`) and
  `FieldDef.onEdit?`.
- **EDIT** `web/slots.ts` — register `CellEditor` in `DataViewSlots`.
- **EDIT** `web/index.ts` — `export { useResolveCellEditor }`; add `CellEditorProps` to the type
  re-export block (and ensure `core/index.ts` re-exports it like `TableCellProps`).
- **EDIT** `plugins/table/web/components/table-view.tsx` — call `useResolveCellEditor()` (hooks-
  unconditional, beside `useResolveCell`); route a field with `onEdit` through a new
  **`web/components/editable-cell.tsx`** (`EditableCell`) holding only `editing` boolean state;
  graceful fallback to read mode when no editor is contributed for the type chain.

### fields (each `inline` sub-plugin = package.json + CLAUDE.md + web/index.ts + web/components/*-editor.tsx)
Mirror `fields/plugins/text/plugins/table/` exactly (`package.json` has `singularity.collapsed:true`;
barrel only wires `DataViewSlots.CellEditor({ match, component })`; JSX in `web/components/`).
- `fields/plugins/text/plugins/inline/` — `TextEditor`: `Input` (ui-kit), commit on Enter/blur,
  Esc cancel; empty ⇒ `null`.
- `fields/plugins/number/plugins/inline/` — `NumberEditor`: `Input type="number"`, parse to
  `number | null` (empty ⇒ null, `NaN` rejected), `tabular-nums`.
- `fields/plugins/bool/plugins/inline/` — `BoolEditor`: immediate-commit toggle button reusing the
  `MdCheck`/`MdRemove` visual of `BoolCell`; click ⇒ `onCommit(!value)`; Esc ⇒ cancel.
- `fields/plugins/enum/plugins/inline/` — `EnumEditor`: `InlinePopover` (`@plugins/primitives/plugins/popover/web`)
  open-by-default, single-select `ToggleChip` rows over `field.options`; choose ⇒ commit+close;
  dismiss ⇒ cancel.
- `fields/plugins/date/plugins/inline/` — `DateEditor`: native `<input type="date">` (the date
  filter's `NATIVE_CONTROL` chrome), seeded from the value's ISO day; commit ⇒ `Date | null`.

Add an `inline` prose bullet to each parent type's `CLAUDE.md` sub-plugins list (autogen block is
regenerated by build).

## Boundary / build notes
- `data-view` never imports `fields/web` — identities read by id via `useFieldIdentities()`; only
  `resolveTypeChain` from `@plugins/fields/core` (already a sanctioned edge in `cell-slot.ts`).
- `inline` barrels import `DataViewSlots` + `CellEditorProps` (type) from `…/data-view/web` — the
  same edge the `table` sub-plugins use. Barrel purity respected (default export only; JSX in components).
- Do **not** modify load-bearing primitives (`slot-render`, `data-table`, `pane`, …) — only
  consume them. `data-view` and `fields` are not load-bearing.
- Run `./equin build` to discover the new sub-plugins (regenerates `web.generated.ts` +
  autogen CLAUDE blocks), then `./equin check`.

## Verification
- **DOM test** `plugins/primitives/plugins/data-view/web/__tests__/inline-edit.test.tsx`
  (vitest + @testing-library/react + `PluginProvider`, mirroring `inline-text.test.tsx`): mount
  `<DataView views={["table"]}>` with a synthetic `type:"text"` editable field + an in-test plugin
  contributing the table view, text identity, text cell, text editor. Assert:
  (a) click cell → input appears, type + Enter → `onEdit(row, "beta")` called;
  (b) Esc cancels with no `onEdit`; (c) a field **without** `onEdit` never enters edit mode
  (the zero-change guarantee). Run `bun run test:dom plugins/primitives/plugins/data-view`.
- **Visual**: `./equin build`, open a surface that exposes the table view, confirm read-only
  unchanged; (optional Playwright follow-up with a temporary editable demo).

## Follow-ups (file as tasks)
1. **tags inline editor** (multi-value chip editor + array commit channel).
2. **gallery / list / tree inline editing** (extend `useResolveCellEditor` + `EditableCell` into
   those views; generalize tree's existing `onRename`).
3. **Per-consumer write-back wiring** (tasks/pages/agents/deploy): map a cell commit to each
   domain mutation (optimistic where already used). One PR per consumer.
4. **Extensibility demo**: a `relation` / `url` / `person` property type contributing identity +
   cell + inline editor, proving an external plugin adds an editable property type with zero
   data-view changes.
