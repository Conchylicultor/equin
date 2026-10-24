# Table Detail Sub-Plugins

## Context

The Tables tab in Forge > Catalog lists every DB table by plugin. Expanding a row renders `<TableDetail.Host tableName={...} pluginId={...} />` — but no sub-plugins contribute to this slot yet, so the expansion is empty. This plan adds 5 sub-plugins that surface live PostgreSQL metadata: columns, indexes, foreign keys, row count, and sample rows.

## Architecture

All 5 sub-plugins live under `plugins/apps/plugins/forge/plugins/catalog/plugins/tables/plugins/<name>/`. Each has:

- `web/index.ts` — contributes `TableDetail.Section({ id, label, component })`
- `server/index.ts` — declares one `GET /api/catalog/tables/:tableName/<aspect>` route
- `server/internal/<handler>.ts` — queries PG metadata via `db.execute(sql\`...\`)`
- `web/components/<section>.tsx` — fetches via `useQuery` + `fetch`, renders with `DataTable`
- `package.json` — `@singularity/plugin-apps-forge-catalog-tables-<name>`

### Key decisions

- **DB access**: Use `db.execute(sql\`...\`)` from `@plugins/database/server` (Drizzle tagged template). All params except table identifiers go through Drizzle's `$1` parameterization.
- **Table name safety**: Every handler validates the table exists in `information_schema.tables WHERE table_schema = 'public'` before querying. For `sample-rows` (which interpolates the name as an identifier), the validated name is double-quoted via `"${tableName.replace(/"/g, '""')}"` and injected with `sql.raw()`.
- **Caching**: All `useQuery` calls use `staleTime: 60_000` — metadata is static relative to development.
- **Types**: Response types are defined inline in web components (no cross-barrel server imports — this project doesn't do web → server type imports).
- **Rendering**: All 5 use `DataTable` from `@plugins/primitives/plugins/data-table/web`. Row-count renders a stat card instead. Sample-rows builds `ColumnDef[]` dynamically from the response's `columns` array.
- **Loading/error**: `Spinner` from `@plugins/primitives/plugins/spinner/web`, `Placeholder` from `@plugins/primitives/plugins/placeholder/web`.

### Section ordering

Slot contributions render in plugin load order (alphabetical by path). Natural order: `columns` → `foreign-keys` → `indexes` → `row-count` → `sample-rows`. Acceptable — users can reorder via the reorder primitive.

## Sub-plugins

### 1. `columns` — Table column definitions

**Route**: `GET /api/catalog/tables/:tableName/columns`

**SQL**:
```sql
SELECT column_name, data_type, is_nullable, column_default, ordinal_position
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = $1
ORDER BY ordinal_position
```

**Response**: `{ columns: { column_name, data_type, is_nullable, column_default, ordinal_position }[] }`

**UI**: DataTable with columns: `#` (ordinal), `Column` (mono), `Type`, `Nullable`, `Default` (mono, muted).

### 2. `indexes` — Table indexes

**Route**: `GET /api/catalog/tables/:tableName/indexes`

**SQL**:
```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = $1
ORDER BY indexname
```

**Response**: `{ indexes: { indexname, indexdef }[] }`

**UI**: DataTable with columns: `Name` (mono), `Definition` (mono, muted, break-all).

### 3. `foreign-keys` — FK relationships

**Route**: `GET /api/catalog/tables/:tableName/foreign-keys`

**SQL** (two parallel queries):
```sql
-- Outgoing: this table references others
SELECT tc.constraint_name, kcu.column_name,
       ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  AND tc.table_name = $1

-- Incoming: other tables reference this one
SELECT tc.constraint_name, tc.table_name AS source_table, kcu.column_name AS source_column,
       ccu.column_name AS target_column
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  AND ccu.table_name = $1
```

**Response**: `{ outgoing: OutgoingFk[], incoming: IncomingFk[] }`

**UI**: Two sub-sections with `SectionLabel` headers ("References" / "Referenced by"). Each renders a DataTable. Show `Placeholder` if both are empty.

### 4. `row-count` — Estimated row count

**Route**: `GET /api/catalog/tables/:tableName/row-count`

**SQL**:
```sql
SELECT n_live_tup::int AS estimate
FROM pg_stat_user_tables
WHERE relname = $1
```

**Response**: `{ estimate: number | null }`

**UI**: Stat card — large number + "rows (estimated)" label. Show "—" when `estimate` is null (table not yet vacuumed).

### 5. `sample-rows` — First 10 rows

**Route**: `GET /api/catalog/tables/:tableName/sample`

**SQL** (after validation):
```sql
SELECT * FROM "<validated_table>" LIMIT 10
```

**Response**: `{ columns: string[], rows: Record<string, unknown>[] }`

**UI**: DataTable with dynamically-constructed `ColumnDef[]` from the response columns array. Each cell renders `null` in italic or `String(value)`. Horizontal scroll for wide tables.

## File structure per sub-plugin

```
plugins/apps/plugins/forge/plugins/catalog/plugins/tables/plugins/<name>/
├── package.json
├── server/
│   ├── index.ts
│   └── internal/
│       └── <name>-handler.ts
└── web/
    ├── index.ts
    └── components/
        └── <name>-section.tsx
```

## Shared handler pattern

Every handler starts with the same validation:

```typescript
import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";

export async function handleGet...(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const tableName = params.tableName;
  if (!tableName) return new Response("Missing tableName", { status: 400 });

  const exists = await db.execute<{ exists: boolean }>(
    sql`SELECT EXISTS(
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${tableName}
    ) AS exists`,
  );
  if (!exists.rows[0]?.exists) {
    return new Response("Table not found", { status: 404 });
  }

  // ... query-specific logic ...
  return Response.json({ ... });
}
```

## Shared web component pattern

```typescript
import { useQuery } from "@tanstack/react-query";
import { DataTable, type ColumnDef } from "@plugins/primitives/plugins/data-table/web";
import { Placeholder } from "@plugins/primitives/plugins/placeholder/web";
import { Spinner } from "@plugins/primitives/plugins/spinner/web";

export function MySection({ tableName }: { tableName: string; pluginId: string }) {
  const { data, isLoading, isError } = useQuery<ResponseType>({
    queryKey: ["table-<aspect>", tableName],
    queryFn: () =>
      fetch(`/api/catalog/tables/${encodeURIComponent(tableName)}/<aspect>`)
        .then((r) => r.json()),
    staleTime: 60_000,
  });

  if (isLoading) return <Spinner />;
  if (isError) return <Placeholder tone="error">Failed to load.</Placeholder>;

  return <DataTable data={data?.items ?? []} columns={COLUMNS} rowKey={...} />;
}
```

## Parallel agent split

5 independent agents, one per sub-plugin. No inter-agent dependencies.

| Agent | Sub-plugin | Files to create |
|-------|-----------|----------------|
| 1 | `columns` | 4 files: package.json, server/index.ts, server/internal/columns-handler.ts, web/index.ts, web/components/columns-section.tsx |
| 2 | `indexes` | 5 files (same structure) |
| 3 | `foreign-keys` | 5 files (two SQL queries, two sub-sections with SectionLabel) |
| 4 | `row-count` | 5 files (stat card UI, not DataTable) |
| 5 | `sample-rows` | 5 files (dynamic ColumnDef[], identifier quoting) |

After all agents finish: run `./equin build` once to register all plugins.

## Verification

1. `./equin build` — auto-registers all 10 barrels (5 web + 5 server)
2. `./equin check` — boundary rules pass
3. Open `http://<worktree>.localhost:9000`, navigate to Forge > Catalog > Tables
4. Expand any table row — all 5 sections should render with live data
5. Verify columns show correct types, FKs link to real tables, row count is plausible
