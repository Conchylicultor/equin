# Reusable DataTable Primitive

## Context

The Forge catalog (`/forge/catalog`) has 5 hand-rolled flex-layout tables (routes, panes, slots, resources, contributions) that all share the same skeleton: sticky header, flex rows, manual filtering, no sorting. Each is ~60–95 lines where most is identical boilerplate (Header, EmptyState, row mapping, filter `.includes()` logic). We want a lightweight reusable table primitive that eliminates this boilerplate and adds sorting for free.

## API Design

### Core idea: `value` unifies sort + filter

Each column optionally defines a `value(row)` accessor. This single function drives:
- **Sorting** — click the header to cycle none → asc → desc → none
- **Filtering** — when a `filter` string is provided, the table matches it against all columns that have `value`
- **Default cell** — when no custom `cell` is provided, renders `String(value(row))`

```ts
type ColumnDef<TRow> = {
  id: string;
  header?: string;
  width?: string;                                       // Tailwind class(es): "w-12 shrink-0", "flex-1 min-w-0"
  value?: (row: TRow) => string | number | undefined;   // drives sort + filter + fallback cell
  cell?: (row: TRow) => ReactNode;                      // custom display; omit to use value() as plain text
};
```

Rules:
- `value` defined → column is sortable (header is clickable) and contributes to string filter
- `cell` defined → custom display
- `cell` omitted, `value` defined → renders `String(value(row))` as plain text in a `<span className="truncate">`
- Neither → column renders nothing (for pure structural/spacer columns)

### DataTable component

```tsx
<DataTable<TRow>
  data={rows}
  columns={columns}
  filter={filter}
  rowKey={(row) => row.id}
  emptyLabel="No items found"
/>
```

```ts
type DataTableProps<TRow> = {
  data: readonly TRow[];
  columns: ColumnDef<TRow>[];
  filter?: string;                          // case-insensitive substring match across all value() columns
  rowKey: (row: TRow) => string;            // stable React key
  emptyLabel?: string;                      // defaults to "No results found"
};
```

### End-user code: RoutesTable after migration

```tsx
import { DataTable, type ColumnDef } from "@plugins/primitives/plugins/data-table/web";

type RouteRow = { item: RouteInfo; plugin: PluginNode };

const columns: ColumnDef<RouteRow>[] = [
  {
    id: "method",
    header: "Method",
    width: "w-12 shrink-0",
    value: (row) => parseRoute(row.item.route).method,
    cell: (row) => {
      const { method } = parseRoute(row.item.route);
      return (
        <span className={cn("font-mono text-[10px] font-semibold", METHOD_COLORS[method])}>
          {method}
        </span>
      );
    },
  },
  {
    id: "path",
    header: "Path",
    width: "flex-1 min-w-0",
    value: (row) => parseRoute(row.item.route).path,
    cell: (row) => (
      <code className="truncate font-mono text-foreground">
        {parseRoute(row.item.route).path}
      </code>
    ),
  },
  {
    id: "plugin",
    header: "Plugin",
    value: (row) => row.plugin.hierarchyId,
    cell: (row) => <PluginChip hierarchyId={row.plugin.hierarchyId} />,
  },
  {
    id: "callers",
    cell: (row) =>
      row.item.callers.length > 0 ? (
        <span className="shrink-0 text-[10px] text-muted-foreground/60">
          {row.item.callers.length} caller{row.item.callers.length !== 1 ? "s" : ""}
        </span>
      ) : null,
  },
];

export function RoutesTable({ plugins, filter }: { plugins: PluginNode[]; filter: string }) {
  const rows = useMemo(
    () => flattenTree<RouteInfo>(plugins, (p) => p.publicApi?.routes ?? []),
    [plugins],
  );
  return (
    <DataTable
      data={rows}
      columns={columns}
      filter={filter}
      rowKey={(row) => `${row.plugin.hierarchyId}:${row.item.route}`}
      emptyLabel="No routes found"
    />
  );
}
```

RoutesTable goes from 95 lines → ~40 lines. Header, EmptyState, row mapping, and filter logic are all gone.

## Sorting

- **Single-column only** — click header to cycle: none → asc → desc → none
- **State**: `useState<{ columnId: string; direction: "asc" | "desc" } | null>(null)`, fully internal
- **Default comparator**: `typeof value === "string"` → `localeCompare`, `typeof value === "number"` → subtraction
- **Sort indicator**: `MdUnfoldMore` (neutral), `MdArrowUpward` (asc), `MdArrowDownward` (desc) from `react-icons/md`. Subtle muted color when inactive, foreground when active. Only shown on columns with `value`.
- **Header click**: only columns with `value` get `cursor-pointer` and sort behavior

## Filtering

When `filter` is a non-empty string:
1. Lowercase the filter string once
2. For each row, collect all `value(row)` results from columns that define `value`
3. If any `String(v).toLowerCase().includes(filterLc)`, the row passes

This replaces the per-table `useMemo` filter boilerplate. The SlotsTable case (`${groupName}.${memberName}`) works naturally:

```tsx
{ id: "name", value: (row) => `${row.item.groupName}.${row.item.memberName}`, ... }
```

## Internal architecture

```
plugins/primitives/plugins/data-table/
├── package.json
└── web/
    ├── index.ts                     # barrel + PluginDefinition (contributions: [])
    └── internal/
        ├── types.ts                 # ColumnDef<TRow>, DataTableProps<TRow>
        ├── use-data-table.ts        # sort + filter hook
        └── data-table.tsx           # DataTable component
```

### `use-data-table.ts`

```ts
function useDataTable<TRow>(data, columns, filter) {
  const [sortState, setSortState] = useState(null);

  const toggleSort = useCallback((columnId) => { /* cycle none→asc→desc→none */ }, [sortState]);

  const rows = useMemo(() => {
    let result = [...data];
    // 1. Filter
    if (filter) {
      const lc = filter.toLowerCase();
      const valueFns = columns.filter(c => c.value).map(c => c.value!);
      result = result.filter(row =>
        valueFns.some(fn => String(fn(row) ?? "").toLowerCase().includes(lc))
      );
    }
    // 2. Sort
    if (sortState) {
      const col = columns.find(c => c.id === sortState.columnId);
      if (col?.value) {
        result.sort((a, b) => {
          const va = col.value!(a), vb = col.value!(b);
          const cmp = typeof va === "number" && typeof vb === "number"
            ? va - vb
            : String(va ?? "").localeCompare(String(vb ?? ""));
          return sortState.direction === "desc" ? -cmp : cmp;
        });
      }
    }
    return result;
  }, [data, columns, filter, sortState]);

  return { rows, sortState, toggleSort };
}
```

### `data-table.tsx`

- Calls `useDataTable`
- Renders sticky header row: each column header is a `<button>` (when sortable) or `<span>` with the column's `width` class, showing header text + sort icon
- Maps `rows` to flex row divs with the standard row chrome: `flex items-center gap-2 border-b border-border/30 px-3 py-1.5 text-xs hover:bg-accent/30`
- Each cell wrapped in `<div className={column.width}>`, renders `column.cell(row)` or falls back to `String(column.value(row))`
- Empty state: `<div className="flex h-32 items-center justify-center text-xs text-muted-foreground">{emptyLabel}</div>`

### `web/index.ts` barrel

```ts
import type { PluginDefinition } from "@core";
export { DataTable } from "./internal/data-table";
export type { DataTableProps, ColumnDef } from "./internal/types";

export default {
  id: "data-table",
  name: "Data Table",
  description: "Sortable/filterable flex-layout data table primitive.",
  contributions: [],
} satisfies PluginDefinition;
```

## Implementation steps

### Step 1: Create `plugins/primitives/plugins/data-table/`
- `package.json` with `"name": "@singularity/plugin-primitives-data-table"`
- `web/internal/types.ts` — `ColumnDef<TRow>`, `DataTableProps<TRow>`
- `web/internal/use-data-table.ts` — sort + filter hook
- `web/internal/data-table.tsx` — `DataTable` component
- `web/index.ts` — barrel exports + plugin definition
- Register in `web/src/plugins.ts`

### Step 2: Migrate the 5 catalog tables

Each table migration is mechanical — replace Header/EmptyState/row-mapping/filter boilerplate with a `columns` array + `<DataTable>`. The `flattenTree` useMemo stays (domain logic).

| Table | `value` columns | Custom cells | Notes |
|---|---|---|---|
| `routes-table.tsx` | method, path, plugin.hierarchyId | MethodBadge, `<code>`, PluginChip | callers column has no `value` (not sortable) |
| `panes-table.tsx` | paneId, segment, plugin.hierarchyId | `<code>` with `"—"` fallback | Straightforward |
| `slots-table.tsx` | `${groupName}.${memberName}`, slotId, plugin.hierarchyId | `<code>` bold, PluginChip | Computed value in first column |
| `resources-table.tsx` | key, mode, plugin.hierarchyId | `<code>`, PluginChip | Simplest table |
| `contributions-table.tsx` | slot, id, plugin.hierarchyId | `<code>` with `"—"` fallback, PluginChip | id may be undefined → `value` returns undefined, handled |

### Step 3: Build & verify
- `./equin build`
- Open `/forge/catalog` → each tab renders correctly, filter works, click headers to sort

## Not included (intentional)

- No row selection / checkboxes
- No column resizing or pagination
- No server-side sort/filter
- No `@tanstack/react-table` dependency
- No HTML `<table>` element (keeps flex layout)
- No virtualization

## Critical files

- New: `plugins/primitives/plugins/data-table/web/**`
- Migrate: `plugins/apps/plugins/forge/plugins/catalog/web/components/categories/{routes,panes,slots,resources,contributions}-table.tsx`
- Register: `web/src/plugins.ts`
- Pattern reference: `plugins/primitives/plugins/detail-sections/web/internal/define-detail-sections.tsx`
