# Data-view inline cell editing across all views (gallery, list, tree)

## Context

The data-view primitive (`plugins/primitives/plugins/data-view/`) has a pluggable
inline cell-editor capability: a `data-view.cell-editor` dispatch slot keyed by
`field.type`, the `useResolveCellEditor()` hook that walks the field's `extends`
chain to find a per-type editor, and `FieldDef.onEdit` / `FieldDef.onEditValues`
write-back callbacks. Today this is wired into **only the table view**, via an
`EditableCell` wrapper that is *private to the table plugin*.

The result is an inconsistency: a field that declares `onEdit` is click-to-edit in
the table view but renders **read-only** in gallery and list. The tree view has its
own *separate* editing mechanism — `HierarchyConfig.onRename` + the tree primitive's
`RenameInput` — gated only to the text-typed primary field, bypassing the shared
`FieldDef.onEdit` / cell-editor capability entirely.

Goal: make editable fields editable in **every** view by reusing the shared
`useResolveCellEditor` + `EditableCell` capability, and **generalize the tree's
`onRename` onto that same `FieldDef.onEdit` contract** (removing the redundant
`HierarchyConfig.onRename`).

## Current state (verified)

- **Cell-editor capability** — `web/cell-editor-slot.ts` (slot + `useResolveCellEditor`),
  `core/internal/types.ts` (`CellEditorProps`, `FieldDef.onEdit`/`onEditValues`),
  `web/slots.ts` (`DataViewSlots.CellEditor`). Six editors registered:
  `fields.{text,number,bool,enum,date,tags}.inline`. The text/number/bool editors
  `autoFocus` on mount and commit on blur/Enter, cancel on Esc.
- **Table** — `plugins/table/web/components/table-view.tsx` calls `useResolveCell()`
  + `useResolveCellEditor()` once at top, and wraps cells in `EditableCell`
  (`plugins/table/web/components/editable-cell.tsx`, contains `EditableCell` +
  `ReadAffordance` + `isEmptyScalar`) when `f.onEdit || f.onEditValues`.
- **Gallery** — `plugins/gallery/web/components/gallery-view.tsx` has a private
  `renderFieldContent` (`field.cell` → `String(value)`, no slot). Read-only.
  Title via `pickPrimaryField`, body = remaining non-cover fields.
- **List** — `plugins/list/web/components/list-view.tsx` same private
  `renderFieldContent`. Read-only. Title = primary; trailing = `align:"end"`
  fields; subtitle = the rest, joined inline with ` · `.
- **Tree** — `plugins/tree/web/components/tree-view.tsx` `DefaultRow` uses
  `useResolveCell()` for read; for the primary field it swaps in `<RenameInput>`
  **only when** `hierarchy.onRename && primaryField && type==="text"`. RenameInput
  (tree primitive) gives select-then-edit, debounced autosave, and **auto-focus on
  row create** via the public `useTreeRow(node)` → `{ shouldAutoFocus, consumeAutoFocus }`
  / `useTreeListContext()` API (exported from `@plugins/primitives/plugins/tree/web`).
- **`HierarchyConfig.onRename` consumers** (to migrate): tasks tree
  (`plugins/tasks/plugins/task-list/plugins/tree/web/tasks-list.tsx`,
  `patchTask(id,{title})`), agents list
  (`plugins/conversations/plugins/agents/web/components/agents-list.tsx`,
  `patchAgent(id,{name})`), pages sidebar
  (`plugins/apps/plugins/pages/plugins/page-tree/web/components/pages-sidebar.tsx`,
  `updateBlock`). Config-nav has no `onRename` (read-only — unaffected).
- **`FieldDef.onEdit` consumer** today: sonata song library
  (`plugins/apps/plugins/sonata/plugins/library/web/components/song-library.tsx`,
  title + composer, `saveSong`). Uses `views={["gallery","table"]}` → will gain
  inline editing in gallery for free.

## Design

### 1. Hoist the editor chrome into the shared data-view web barrel

Move `EditableCell` + `ReadAffordance` + `isEmptyScalar` out of the table plugin into
the **parent** data-view web barrel so all four view plugins consume one component:

- New: `plugins/primitives/plugins/data-view/web/components/editable-cell.tsx`
  (moved from `plugins/table/...`). Export `EditableCell` from
  `plugins/primitives/plugins/data-view/web/index.ts`.
- Enhance `EditableCell` with two small, general props:
  - `autoEdit?: boolean` — start in edit mode on mount (for tree create-focus). The
    underlying slot editor already `autoFocus`es, so mounting it focuses the input.
  - `display?: "block" | "inline"` (default `"block"`) — `ReadAffordance` uses
    `w-full block` (table/gallery/list-title/trailing full-width click target) vs
    `inline` (list subtitle inline segments). Editor wrapper mirrors this.
- Table view: delete its local `editable-cell.tsx`, import `EditableCell` from
  `@plugins/primitives/plugins/data-view/web`. (Table → parent barrel is a valid
  cross-plugin edge; table already imports `useResolveCell`/`useResolveCellEditor`
  from there.)

### 2. Shared `<FieldCell>` field renderer (read + edit in one place)

Add `plugins/primitives/plugins/data-view/web/components/field-cell.tsx`, exported
from the barrel. It is the single "render a field's value, editable if it declares
`onEdit`" component, replacing each view's private `renderFieldContent`:

```tsx
function FieldCell({ field, row, resolveCell, resolveEditor, display }) {
  const value  = field.value?.(row);
  const values = field.values?.(row);
  const read = field.cell ? field.cell(row)
             : (resolveCell(field, value, row, values) ?? String(value ?? ""));
  if (field.onEdit || field.onEditValues)
    return <EditableCell field={field} row={row} value={value} values={values}
             read={read} resolveEditor={resolveEditor} display={display}
             onEdit={field.onEdit} onEditValues={field.onEditValues} />;
  return <>{read}</>;
}
```

Read precedence becomes uniform across all views: `field.cell` → `data-view.cell`
slot (`resolveCell`) → `String(value)`. This also upgrades gallery/list to honor the
`data-view.cell` display slot (they bypass it today) — an intentional consistency win.
Each view resolves `useResolveCell()` + `useResolveCellEditor()` **once at the top**
(hooks rule) and threads them into `FieldCell` (mirrors the table precedent).

### 3. Gallery + List

- **Gallery** (`gallery-view.tsx`): replace `renderFieldContent(field,row)` calls in
  the title line and each body field with `<FieldCell ... display="block" />`.
  Editing stays contained because `EditableCell` already `stopPropagation`s, so the
  card's `onActivate` does not fire while editing a field.
- **List** (`list-view.tsx`): title line and trailing (`align:"end"`) fields use
  `<FieldCell display="block" />`; subtitle segments use `<FieldCell display="inline" />`
  (keeps the ` · `-joined inline layout while making editable subtitle fields
  click-to-edit). Same `stopPropagation` keeps row `onActivate` intact.

### 4. Tree — generalize `onRename` onto `FieldDef.onEdit`

- **Remove `onRename` from `HierarchyConfig`** (`core/internal/types.ts`).
- Tree-view `DefaultRow`: drive primary-field editing from `primaryField.onEdit`
  instead of `hierarchy.onRename`, reusing the shared cell-editor capability with a
  thin tree-appropriate trigger (the tree label doubles as the navigation target, so
  it must keep select-then-edit rather than table's edit-on-single-click):
  - New `plugins/tree/web/components/editable-tree-label.tsx`. It reuses
    `useResolveCellEditor()` (and the same read resolution as `FieldCell`) and
    `useTreeRow(node)` for create-focus:
    - `editing` initial = `shouldAutoFocus` (new row → opens immediately; slot editor
      `autoFocus`es); call `consumeAutoFocus()` when it opens.
    - Read label click: if the row is **not** selected → `ctx.onSelect(node.id)`
      (navigate, no edit); if already selected → enter edit. Preserves today's
      select-then-edit feel.
    - Commit → `primaryField.onEdit(row, next)`; Esc/cancel → exit. Editor owns
      blur/Enter/Esc.
  - Gate: render `EditableTreeLabel` when `primaryField?.onEdit` exists; else the
    existing read-only `resolveCell` span. Works for any field type (text via the
    text editor, plus number/enum/date/etc.), not just text.
  - `RenameInput` is no longer used by the data-view tree (it remains in the tree
    primitive for other consumers — untouched).
- **Migrate the three `onRename` consumers** to put the write-back on the primary
  `FieldDef.onEdit` (and keep `onCreate` for the create affordance + pending-focus):
  - tasks: `onEdit: (t, next) => patchTask(t.id, { title: String(next ?? "").trim() || "Untitled" })`
  - agents: `onEdit: (a, next) => patchAgent(a.id, { name: String(next ?? "").trim() || "Untitled" })`
  - pages: `onEdit: (b, next) => updateBlock({id:b.id}, { body:{ data:{ ...pageData(b), title: String(next ?? "").trim() || "Untitled" } } })`
  - Guard empty → `"Untitled"` to preserve current RenameInput blank-handling (the
    slot text editor commits `null` on empty). Side effect (intended): these titles
    also become editable in any table/list/gallery view of the same source.

## Files to modify

- `plugins/primitives/plugins/data-view/web/components/editable-cell.tsx` — NEW (moved + `autoEdit`/`display`)
- `plugins/primitives/plugins/data-view/web/components/field-cell.tsx` — NEW
- `plugins/primitives/plugins/data-view/web/index.ts` — export `EditableCell`, `FieldCell`
- `plugins/primitives/plugins/data-view/core/internal/types.ts` — remove `HierarchyConfig.onRename`
- `plugins/primitives/plugins/data-view/plugins/table/web/components/editable-cell.tsx` — DELETE
- `plugins/primitives/plugins/data-view/plugins/table/web/components/table-view.tsx` — import shared `EditableCell` / use `FieldCell`
- `plugins/primitives/plugins/data-view/plugins/gallery/web/components/gallery-view.tsx` — use `FieldCell`
- `plugins/primitives/plugins/data-view/plugins/list/web/components/list-view.tsx` — use `FieldCell`
- `plugins/primitives/plugins/data-view/plugins/tree/web/components/tree-view.tsx` — `EditableTreeLabel`, drop `onRename`
- `plugins/primitives/plugins/data-view/plugins/tree/web/components/editable-tree-label.tsx` — NEW
- `plugins/tasks/plugins/task-list/plugins/tree/web/tasks-list.tsx` — `onRename` → primary `onEdit`
- `plugins/conversations/plugins/agents/web/components/agents-list.tsx` — `onRename` → primary `onEdit`
- `plugins/apps/plugins/pages/plugins/page-tree/web/components/pages-sidebar.tsx` — `onRename` → primary `onEdit`

## Reuse

- `useResolveCellEditor`, `useResolveCell` — `data-view/web` barrel (already used by table/tree).
- `EditableCell` pattern + `ReadAffordance` + `isEmptyScalar` — hoisted, not rewritten.
- `useTreeRow` / `useTreeListContext` (`shouldAutoFocus`, `consumeAutoFocus`, `onSelect`,
  `selectedId`) — public tree primitive API, `@plugins/primitives/plugins/tree/web`.
- Existing per-type editors (`fields.*.inline`) — unchanged; reused everywhere.

## Verification

1. `./equin build` (regenerates registries/docs, type-checks). Fix any boundary
   / type-check errors.
2. `bun run test:dom plugins/primitives/plugins/data-view` — the existing table
   `inline-edit.test.tsx` must still pass after the hoist; add DOM tests for gallery
   (click body field → edit → commit) and tree (create row → auto-focus editor;
   commit → `onEdit`).
3. Manual via Playwright (`e2e/screenshot.mjs`):
   - Sonata library gallery (`http://<wt>.localhost:9000` → sonata library, gallery
     view): click a title/composer card field → inline editor → commit persists.
   - Tasks tree sidebar: create a task → label opens focused for naming; rename an
     existing task → persists via `patchTask`. Pages sidebar + agents list likewise.
4. `./equin check` (boundaries, plugins-doc-in-sync, type-check).

## Tradeoffs / notes

- **Tree keeps select-then-edit** (not table's edit-on-single-click) because the tree
  label is also the navigation target — single-click must still select/navigate.
  `EditableTreeLabel` reuses the same `useResolveCellEditor` capability with a
  tree-appropriate trigger; `EditableCell`'s click trigger stays for flat views.
- Gallery/list now honor the `data-view.cell` display slot (previously bypassed) —
  intentional consistency improvement; could change appearance of fields that have a
  registered cell renderer.
- Removing `HierarchyConfig.onRename` is a breaking change to that internal contract;
  all three consumers are migrated in the same change (no external API).
