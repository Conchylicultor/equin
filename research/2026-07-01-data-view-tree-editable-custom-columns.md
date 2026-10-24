# DataView: editable secondary-field chips in the tree view (custom columns on tree-only surfaces)

## Context

**Task premise:** "Custom user-defined columns … only render in the table and gallery
views. In tree and list views the column exists and is filterable, but its per-row
values are invisible in the row body … A user who adds a custom column on a tree- or
list-only surface sees no effect."

**What research found (the premise is partly stale, but a real gap survives):**

- Custom columns are already folded into the shared `FieldDef[]` schema by the
  **host** (`data-view/web/components/data-view.tsx` → `useCustomColumnFields`), *before*
  any view renders. Every view — including tree/list — receives them as ordinary fields.
- Today's commit `ae52dcedc` ("per-view Properties (visible fields + order)") changed
  tree & list from **label-only** to **show-all**: `resolveBodyFields(fields, null)`
  returns *all* fields, so the tree now renders every non-primary field (incl. custom
  columns) as a chip, and the list renders them as subtitle/trailing cells. The task's
  literal "only render the primary/label fields" describes the **pre-`ae52dcedc`** state
  and is **already fixed for display**. All three named consumers (`tasks-list`,
  `agents-list`, `pages-sidebar`) author no `visibleFields`, no `renderRow`, and no
  `customColumns={false}`, so custom columns already flow into their bodies.
- **The surviving real gap:** the tree renders its secondary chips via a **bare
  `resolveCell(...)` — read-only** (documented v1 follow-up in the tree CLAUDE.md:
  "chips are read-only in v1 … edit those values in the table/list view"). But
  `agents-list` and `pages-sidebar` are **tree-only** (`views={["tree"]}`) — there is no
  table/list view to fall back to. So a user who adds a custom column there gets only an
  empty, uneditable chip and **cannot enter a value → "sees no effect."** The list view
  is already editable (it renders cells through `FieldCell` → `EditableCell`).

**Decision (user-confirmed):** make the tree's secondary chips editable so custom-column
values can be entered/edited directly in the tree, closing the gap uniformly for
tree-only surfaces.

## Approach

Route the tree's secondary-field chips through the **same shared `FieldCell`** the
list/table/gallery already use, instead of the current bare `resolveCell`. `FieldCell`:

- renders `field.cell(row) ?? resolveCell(...) ?? String(value)` for the read, and
- wraps the read in `EditableCell` (click-to-edit) **iff** the field declares
  `onEdit`/`onEditValues`; otherwise renders the read bare.

This makes the tree behave identically to the list: custom columns (which declare
`onEdit`) become click-to-edit; genuinely read-only fields stay read-only. No new
abstraction — it is the established per-view cell path.

**Why click-to-edit (`EditableCell`) for chips, not select-then-edit
(`EditableTreeLabel`):** the primary label uses `EditableTreeLabel` because it doubles as
the row's *navigation target* (first click selects/navigates, second click edits).
Secondary chips are **not** nav targets, so single-click-to-edit is correct and matches
every other view. The tree row selects on `onClick={onSelect}`
(`tree/web/internal/tree-row-chrome.tsx:98`); `EditableCell` calls `stopPropagation()` on
its click, so clicking a chip to edit does **not** trigger row selection/navigation.

**Bonus — fixes discoverability:** `EditableCell`'s `ReadAffordance` shows a muted italic
"Empty" hint for empty editable values, so an unset custom column becomes a visible,
clickable target on every tree row (directly answering "sees no effect") — the same
affordance the list/table already show.

## Files to modify

1. **`plugins/primitives/plugins/data-view/plugins/tree/web/components/tree-view.tsx`**
   — the only code change. In `DefaultRow`:
   - Import `FieldCell` and `useResolveCellEditor` from
     `@plugins/primitives/plugins/data-view/web` (both already public; `useResolveCell`
     is already imported, `useResolveCellEditor` is already used by `EditableTreeLabel`).
   - Add `const resolveEditor = useResolveCellEditor();` alongside the existing
     `const resolveCell = useResolveCell();`.
   - Replace the secondary-chip render (currently lines ~127–143):
     ```tsx
     {secondaryFields.map((f) => (
       <span key={f.id}>
         {resolveCell(f as FieldDef<unknown>, f.value?.(row) ?? null, row) ?? String(f.value?.(row) ?? "")}
       </span>
     ))}
     ```
     with:
     ```tsx
     {secondaryFields.map((f) => (
       <span key={f.id}>
         <FieldCell
           field={f as FieldDef<unknown>}
           row={row}
           resolveCell={resolveCell}
           resolveEditor={resolveEditor}
           display="inline"
         />
       </span>
     ))}
     ```
   - Keep the surrounding `<Inline gap="xs" className="shrink-0">` cluster and the
     primary-label path (`EditableTreeLabel`) unchanged.

2. **`plugins/primitives/plugins/data-view/plugins/tree/CLAUDE.md`** — update the
   "Secondary fields" prose: the chips are no longer read-only; a secondary field that
   declares `onEdit`/`onEditValues` is now **click-to-edit** through the shared
   `FieldCell`/`EditableCell` (same per-type editors as the table/list), while fields
   without a write-back stay read-only. Remove the "read-only in v1 … edit those values
   in the table/list view" follow-up note.

No server, schema, or host changes: the custom-columns upsert endpoint, live resource,
and the host's field bridge (`onEdit` → `setCustomColumnValue`) already exist and are
exercised by the table/list today. This purely upgrades the tree's read-only chips to the
shared editable cell.

### Reused existing code (no new primitives)

- `FieldCell` — `data-view/web/components/field-cell.tsx` (read + editable wrapper).
- `EditableCell` — `data-view/web/components/editable-cell.tsx` (click-to-edit,
  `stopPropagation`, "Empty" affordance).
- `useResolveCellEditor` — `data-view/web/cell-editor-slot.ts` (per-type editors).
- Custom-columns write-back is already wired by the host bridge
  `data-view/web/internal/use-custom-column-fields.ts` (`onEdit` →
  `useSetCustomColumnValue`).

## Edge cases / notes

- **DnD:** the whole tree row is the drag source, but a click-in-place on a chip does not
  start a drag (dnd-kit activation constraint — the existing primary-label read span
  likewise does not stop pointerdown and works today). No extra pointer-handling needed;
  `EditableCell`'s existing `stopPropagation` on click is sufficient to protect row
  selection.
- **Inline editor width in a dense row:** an open editor takes natural width in the
  `shrink-0` chip cluster and squeezes the flexible (`min-w-0 flex-1`, truncating) label —
  same trade-off the list subtitle already accepts. Acceptable for this change.
- **`renderRow` escape-hatch consumers** keep full control (they bypass `DefaultRow`);
  unaffected. None of the three named surfaces use it.
- **Read-only fields** (no `onEdit`, e.g. tasks' `status`/`updatedAt`) render bare via
  `FieldCell` — no "Empty" hint, byte-equivalent to today.

## Verification

1. `./equin build` (from this worktree).
2. **Tree-only surface (the sharp case):** open the pages sidebar
   `http://<worktree>.localhost:9000/pages` (or the agents list at `/agents`), use the
   toolbar **Fields** (gear) button to add a custom column (e.g. "Priority"). Confirm each
   tree row now shows a muted, clickable **"Empty"** chip. Click it, type a value, press
   Enter — confirm it commits, persists across reload, and renders as the chip value.
   Scripted check:
   ```bash
   bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/pages --out /tmp/pages-tree
   ```
3. **Persistence (DB):** after entering a value, verify the row landed via the
   `query_db` MCP tool:
   `SELECT * FROM data_view_custom_values WHERE "dataViewId" = 'pages-sidebar';`
4. **No regression on the primary label:** confirm clicking a row still selects/navigates
   (first click) and the primary title still edits via select-then-edit (second click) —
   i.e. chip editing did not hijack row activation.
5. **Tasks list (tree + list):** at `/tasks`, add a custom column; confirm it is editable
   in **both** the Tree view (new) and the Recent list view (already worked), and that the
   read-only `status`/`updatedAt` chips are unchanged.
