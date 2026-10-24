# Migrate deploy server list onto data-view (+ dense list view & active-row affordance)

## Context

The deploy server list
(`plugins/apps/plugins/deploy/plugins/servers/web/components/servers-list.tsx`)
hand-rolls its own master-detail column instead of reusing the shared
`primitives/data-view` surface that Home, Story, Sonata, and tweakcn now share.
Migrating it onto data-view gives it search / sort / filter / view-state for
free and removes a bespoke list. Two data-view gaps (surfaced while migrating
the galleries) block a clean migration:

1. **No active/selected-row affordance.** The master column highlights the
   selected row (`bg-accent`) to drive the detail pane. `selectedRowId` already
   flows from the host into every view's render props, but **only the tree view
   consumes it** — gallery and table silently drop it.
2. **No compact/dense list view.** data-view only offers chunky gallery cards or
   a wide multi-column table; neither suits a narrow (320px) master column.

**Outcome:** add a `list` view child + wire `selectedRowId` into all flat views,
then migrate deploy onto it with no regression to the selection UX or the
`+ Add` affordance.

Decisions (confirmed with user):
- **Row mapping is field-driven** (not explicit render slots) — keeps status a
  real filterable field so search/sort/filter work for free.
- **Active-row highlight added to all flat views** (list + gallery + table), not
  just list — `selectedRowId` already flows everywhere but is ignored; fixing
  the whole class keeps the primitive coherent.

## Part 1 — Active-row highlight in the flat views (gallery + table)

`selectedRowId` is already threaded into `DataViewRenderProps` by the host
(`data-view/web/components/data-view.tsx:132`). The views just don't read it.

- **Gallery** (`data-view/plugins/gallery/web/components/{gallery-view,data-card}.tsx`):
  add a `selected?: boolean` prop to `DataCard`; in `GalleryView` compute
  `props.rowKey(row, i) === props.selectedRowId` and pass it. When selected,
  `DataCard` applies a persistent ring/accent (e.g. `ring-2 ring-primary` or
  `bg-accent`) — mirror whatever the `Row` primitive uses (`bg-accent`) for
  visual consistency. Custom `renderCard` cards are not wrapped, so they opt out
  (unchanged).
- **Table** (`data-view/plugins/table/web/components/table-view.tsx` →
  `primitives/data-table`): `DataTable` has no `selectedRowId`. Add an optional
  `selectedRowId?: string` + `rowKey` to `DataTableProps` (or pass a
  `isRowSelected` predicate) and apply `bg-accent` on the matching row div
  (alongside the existing `hover:bg-accent/30`). `TableView` forwards
  `props.selectedRowId`.

These are additive/optional — no existing consumer regresses.

## Part 2 — New `list` view child

Create `plugins/primitives/plugins/data-view/plugins/list/` mirroring the
gallery child's structure exactly (the documented "Adding a new view child"
recipe in `data-view/CLAUDE.md`).

### Files

- `core/index.ts` + `core/internal/types.ts` — `ListViewOptions<TRow>` type.
- `web/components/list-view.tsx` — the `ListView` component
  (`ComponentType<DataViewRenderProps<unknown>>`).
- `web/index.ts` — default-export plugin contributing one
  `DataViewSlots.View({ id: "list", title: "List", icon: MdViewList, order: 3, component: ListView })`.
  Also re-export the `ListViewOptions` type (consumers pass a plain
  `viewOptions={{ list: {…} }}` literal; never import the child — same as gallery).
- `package.json` + `CLAUDE.md` — copy gallery's, adjust names/description.

### `ListViewOptions<TRow>`

```ts
export interface ListViewOptions<TRow> {
  /** Leading slot per row (icon / avatar / status-dot). */
  leading?: (row: TRow) => ReactNode;
  /** Full row-body override (escape hatch). Owns its own content; still wrapped
   *  in the selectable/clickable <Row>. */
  renderRow?: (row: TRow) => ReactNode;
  /** Row density. Default "md". */
  size?: "sm" | "md";
}
```

### Rendering (field-driven, composes the `Row` primitive)

`ListView` follows gallery exactly: call `useFlatRows(props.rows, props.fields,
props.state, resolveFilter, props.searchAccessor)`; honor `props.loading` /
`props.loadingState` (use `<Loading variant="rows" />`) and `props.emptyState`;
gate full-surface padding on `!props.embedded`.

Per row render a `Row` (from `@plugins/primitives/plugins/row/web`):
- `selected={props.rowKey(row, i) === props.selectedRowId}` — active-row
  affordance baked in from the start (`Row` already maps `selected → bg-accent`).
- `onClick={() => props.onRowActivate?.(row)}`.
- `icon={options.leading?.(row)}` — leading slot.
- `actions={itemActions ? <itemActions.Row row hasChildren /> : undefined}` —
  hover-revealed trailing (matches gallery/tree).
- `size={options.size ?? "md"}`.

Body (children), field-driven via shared `pickPrimaryField`:
- **primary field** → top label line (`truncate font-medium`).
- fields with **`align === "end"`** → trailing region inside the row body
  (always visible, right of the label/subtitle block, before the hover actions)
  — rendered via `field.cell(row) ?? String(field.value(row))`. This is where
  deploy's status badge lands.
- **remaining non-primary fields** → muted subtitle line(s) (`text-caption
  text-muted-foreground truncate`), rendered via cell/value, joined.
- When `options.renderRow` is set, render it as the row body instead (still
  inside the selectable `Row`).

This is the list analog of the gallery's "title + stacked muted property rows":
primary = label, others = subtitle, `align:"end"` floats to the trailing edge.

### Docs / registration

Run `./equin build` — the registry (`web.generated.ts`) is regenerated
from the filesystem; no manual registration. Update `data-view/CLAUDE.md`'s
sub-plugin list + the `DataViewSlots.View` contributor line (the
`plugins-doc-in-sync` check enforces this; build regenerates the autogen block).

## Part 3 — Migrate deploy servers list

Rewrite `servers-list.tsx` to render `<DataView<Server>>`:

```tsx
const { data: servers, pending } = useResource(serversResource); // existing
const selectedId = serverDetailPane.useRouteEntry()?.params.serverId; // existing
const openPane = useOpenPane(); // existing

const fields: FieldDef<Server>[] = [
  { id: "name", label: "Name", type: "text", primary: true, value: (s) => s.name },
  { id: "address", label: "Address", type: "text",
    value: (s) => `${s.host}:${s.port}` },
  { id: "status", label: "Status", type: "enum", align: "end",
    options: [
      { value: "online", label: "Online" },
      { value: "offline", label: "Offline" },
      { value: "unknown", label: "Unknown" },
    ],
    value: (s) => s.status,
    cell: (s) => <ServerStatusBadge status={s.status} /> },
];

<DataView<Server>
  rows={servers}
  fields={fields}
  rowKey={(s) => s.id}
  views={["list"]}
  defaultView="list"
  storageKey="deploy:servers"
  loading={pending}
  selectedRowId={selectedId}
  onRowActivate={(s) => openPane(serverDetailPane, { serverId: s.id }, { mode: "push" })}
  actions={<Button variant="default" size="sm"
            onClick={() => openPane(addServerPane, {}, { mode: "push" })}>+ Add</Button>}
  emptyState="No servers registered. Add one to get started."
/>
```

- Defining `status` as an `enum` field gives a status **filter** for free (the
  filter funnel button appears automatically — `hasFilters` in the host); and
  `address`/`name` become searchable. Net new capability, no regression.
- `ViewSwitcher` renders nothing for a single view → matches the current
  switcher-less header.
- **Wrapper:** change `ServersRoot` in `panes.tsx` from
  `<div className="h-full overflow-auto">` to a bounded flex column
  (`<div className="flex h-full flex-col">`) so DataView's surface mode
  (`min-h-0 flex-1` + its own internal scroll) works; DataView owns scrolling.
- Delete the bespoke `ServerRow` markup. Keep `ServerStatusBadge`
  (`server-status-badge.tsx`) — reused as the status cell.

### What is preserved
- URL-driven selection + `bg-accent` highlight (now via `Row selected`).
- Row content: name (label), `host:port` (subtitle), status badge (trailing).
- `+ Add` → `openPane(addServerPane, …)` (now in DataView `actions`).
- Empty + loading states.

## Critical files

- `plugins/primitives/plugins/data-view/plugins/gallery/web/components/{gallery-view,data-card}.tsx` — add `selected`.
- `plugins/primitives/plugins/data-view/plugins/table/web/components/table-view.tsx` + `plugins/primitives/plugins/data-table/web/internal/data-table.tsx` — add `selectedRowId`.
- `plugins/primitives/plugins/data-view/plugins/list/**` — new view child (mirror gallery).
- `plugins/primitives/plugins/row/web` (`Row`), `data-view/web` (`useFlatRows`, `useResolveFilter`, `pickPrimaryField`, `DataViewRenderProps`, `FieldDef`, `ItemActionsDescriptor`) — reused.
- `plugins/apps/plugins/deploy/plugins/servers/web/components/servers-list.tsx` — rewrite onto DataView.
- `plugins/apps/plugins/deploy/plugins/servers/web/panes.tsx` — `ServersRoot` wrapper → flex column.
- `data-view/CLAUDE.md` (+ build-regenerated autogen) — document the `list` child.

## Verification

1. `./equin build` (regenerates registry + migrations, runs checks). Then
   `./equin check` clean (esp. `plugins-doc-in-sync`, `type-check`,
   `plugin-boundaries`).
2. Scripted Playwright run against `http://<worktree>.localhost:9000/deploy`:
   - List renders servers as dense rows (name / host:port / status badge).
   - Click a row → `bg-accent` highlight + detail pane opens
     (`e2e/screenshot.mjs --click "<server name>"`, capture before/after).
   - `+ Add` opens the add-server pane.
   - Search box filters by name/host; status filter funnel filters by status.
3. Sanity-check the active-row highlight didn't regress existing consumers:
   load Sonata library (gallery + table) and a tree consumer (pages sidebar) —
   selection/hover still correct.
4. Optional unit test: a jsdom `web/__tests__/list-view.test.tsx` asserting the
   field→label/subtitle/trailing mapping and `selected` on the matching rowKey.
