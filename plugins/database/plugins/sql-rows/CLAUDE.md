# sql-rows

Raw SQL rows, **parsed** instead of asserted.

```ts
import { queryRows, executeRows } from "@plugins/database/plugins/sql-rows/core";

const dbs = await queryRows(getAdminPool(), {
  sql: `SELECT datname::text AS datname FROM pg_database ORDER BY datname`,
  row: z.object({ datname: z.string() }),
});
//    ^? { datname: string }[]

const triggers = await executeRows(db, {
  query: sql`SELECT tgname::text AS tgname, relname::text AS relname FROM …`,
  row: z.object({ tgname: z.string(), relname: z.string() }),
});
```

## Why this exists

`pool.query<Row>(sql)` declares a row type that nothing verifies. The generic is
a pure assertion: whatever `pg` decodes is handed to typed code as if it matched.
`tsc` is satisfied, the code reads as typed, and a mismatch surfaces as **wrong
behaviour**, never as an error.

That cost a real incident. A fork-plan query used `array_agg(relname)`, which
produces `name[]` (OID 1003). `pg` decodes a column with the parser registered
for its type OID, and there is none for `name[]` — so the column arrived as the
raw Postgres literal string `"{_private_jobs,migrations,…}"` while its declared
type said `string[]`. Downstream, `for (const t of tables)` walked the string one
character at a time and `tables.includes(x)` silently became substring matching.
The result: a database fork that emitted sixty `pg_dump` patterns matching
nothing, copied a whole schema it was meant to empty, and reported success. No
check, no lint rule, no test caught it — the unit tests build their input by
hand, so they can only ever see a well-formed row. See
`plugins/database/plugins/admin/server/internal/fork-plan.ts`, whose
`CatalogRowSchema` comment is the written-up incident.

The exposure is not the explicit generic. `const r = await pool.query(sql);
r.rows` asserts *nothing* and is strictly worse — `rows` is `any[]`, which
accepts every downstream misuse in silence. So the guardrail is about "rows were
read at all", not "a type argument was written".

## What a failure looks like

```
SqlRowError: row 0 of a SQL result did not match its declared shape.
  column "tables": expected array, received string
  value: "{_private_jobs,migrations,graphile_worker}"
  pg type: OID 1003 — pg has no type parser registered for this OID, so the column
           arrived as its raw Postgres literal. Cast the column (e.g. `::text[]`,
           `::int`, `::text`) or register a parser.
  sql: WITH RECURSIVE tree AS (SELECT i.inhparent AS root, …
```

The OID line is the whole point. It turns a multi-hour "why is my fork empty"
into a one-line SQL cast.

Every line is conditional: a result with no `fields` prints no OID line, a query
with no SQL text prints no `sql:` line. The cast hint fires only on the signature
that means "no decoder" — a `string` arriving where an array / object / number /
boolean was expected.

## Which door

| you have | use |
|---|---|
| a `pg` Pool / PoolClient / Client and a SQL **string** | `queryRows` |
| …and the query returns exactly one row | `queryOne` |
| …and you also need `fields` or `rowCount` | `queryResult` |
| a drizzle db and a `sql\`…\`` object | `executeRows` |
| …and the query returns exactly one row | `executeOne` |
| …and you also need `fields` or `rowCount` | `executeResult` |

`queryOne` / `executeOne` **throw** on 0 or ≥2 rows rather than returning
`T | undefined`. "No row" is a failure of the caller's expectation, not an empty
success something downstream can absorb.

`queryRows` returning `[]` *is* a legitimately-empty success — which is exactly
what the parse guarantees and an unparsed read cannot.

`queryResult` / `executeResult` are for the callers that genuinely need more
than the rows: the column descriptors, or the count. The MCP `query_db` tool
runs agent-authored arbitrary SQL and needs `fields` to name columns nobody knew
ahead of time. **This is not an escape hatch** — the `rows` it hands back are
`T[]`, parsed by the same code path as `queryRows`; `ParsedResult` widens what
you can see, never what you can skip. Without it those callers would be pushed
back onto the raw `.query()` form, and the guardrail would leak at exactly the
sites reading the least predictable SQL. `fields` is `[]` rather than absent
when the driver did not supply any, so there is no missing case to handle.

`queryRows` / `executeRows` are thin wrappers over these two, so there is
exactly one parse implementation behind every door.

`executeRows` has no SQL string to quote (drizzle holds the query object), so
pass `label` when the call site is not obvious from the stack; it is what the
diagnostic names the query by.

## Writing an honest schema

`pg` decodes a column with the parser registered for its type OID, so what
arrives is a property of the column, not of the row. Measured against this
repo's own cluster:

| SQL | OID | JS value |
|---|---|---|
| `text` / `varchar` / `uuid` / scalar `name` | 25 / 1043 / 2950 / 19 | `string` |
| `int2` / `int4` | 21 / 23 | `number` |
| `int8`, bare `count(*)` | 20 | **`string`** |
| `numeric` | 1700 | **`string`** |
| `float4` / `float8` | 700 / 701 | `number` |
| `bool` | 16 | `boolean` |
| `date` | 1082 | `string` |
| `json` / `jsonb` | 114 / 3802 | decoded value |
| `text[]` | 1009 | `string[]` |
| `name[]` — a bare `array_agg` over a `name` column | 1003 | **`string`**, the raw literal |

`int8` and `numeric` are strings **by design** — neither fits in a JS number —
so the honest schema says `z.string()` and the caller converts, or the SQL adds
a cast (`count(*)::int`). `name[]` is the one with no decoder at all; there the
SQL is what is wrong, and the fix is `array_agg(x::text)`.

### The timestamp trap: it depends on who ran the query

`timestamp` / `timestamptz` / `date` / `interval` do **not** have one answer.

| read through | what arrives |
|---|---|
| `db.execute(sql\`…\`)` — drizzle raw | **`string`** |
| `pool.query(…)` — a raw `pg` client | **`Date`** |
| `db.select().from(table)` — drizzle typed | `Date` |

`drizzle-orm/node-postgres` attaches a per-query type-parser override
(`node-postgres/session.js`) that returns those four types as their raw string,
leaving the mapping to drizzle's own column types. A raw `pg` client has no such
override and applies pg's default `Date` parser. So the *identical* `SELECT
j.run_at` is a string through `executeRows` and a `Date` through `queryRows`.

Nothing in the SQL shows this. It was got backwards once during this plugin's
own migration, on the strength of a probe run against a raw client — and the
parse is what caught it, naming the column, the value and `OID 1184` instead of
letting a `Date` flow into code typed `string`. Which is the argument for the
whole plugin, made against its own author.

A **column** is the fourth row of that table and the one place the answer is
free: it always decodes, because a drizzle column carries a real decoder. Keeping
it that way when the column is narrower than its pg type is `sql-column`'s job.

The same trap accounts for every lie the sibling
[`sql-projection`](../sql-projection/CLAUDE.md) found one layer down: three
``sql<Date | null>`…` `` projections holding a `string`, because a raw projection
has no column type to do the mapping. That plugin owns the projection half —
``sql`…` `` selected as a value — and gives it a decoder rather than a parse.

## What stays as it is

**DDL and DML that never read rows.** `pool.query(ddl)` and
`db.execute(sql\`DELETE …\`)` are untouched — there is no row to parse, so there
is nothing to get wrong. Only the row-reading subset moves.

**Honest schemas, not coercion.** When a column's true pg type is a string
(`int8`, `numeric`, an uncast `name`), the fix is a **SQL cast** so the declared
type is true — not `z.coerce`. The exception is a value that genuinely exceeds
`Number.MAX_SAFE_INTEGER` and must stay a string, which the schema should then
say.

## Shape

`core/` rather than `server/`, because the callers span three runtimes: server
plugins, `check/` files, and `cli/`. `core` is the only barrel all three may
import. It stays a leaf: `zod`, `ZodParser`, and **structural** interfaces only —
no `import { Pool } from "pg"`, no drizzle import, not even type-only.
`SqlQueryable` / `SqlExecutable` / `SqlResult` are satisfied by the real types
with no cast at any call site.

`ZodParser<T>` comes from `@plugins/packages/plugins/zod-parser/core` — the
canonical "a schema that parses **untrusted** input into a `T`" type. Using
`z.ZodType<T>` here would make the parse a second assertion, since its `Input`
defaults to `Output`.

`row` is required, and a `ZodParser<T>` cannot be produced by writing a type
argument — so `queryRows<Row>(…)` with no schema does not typecheck. Through this
door the wrong thing has no spelling; `lint/no-unparsed-sql-rows` closes the
other doors.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Parsed raw-SQL row reads: queryRows / executeRows parse every row against a ZodParser and throw a SqlRowError naming the column, the value and its Postgres type OID — closing the pool.query<T>() assertion hole.
- Exemptions:
  - Exempts itself from: `sql-rows/no-unparsed-sql-rows` — `.` (sanctioned)
  - Exempted by: `database/sql-rows` (0 debt)
- Core:
  - Exports (types):
    - `ParsedResult`
    - `SqlExecutable`
    - `SqlField`
    - `SqlQueryable`
    - `SqlResult`
    - `SqlRowFailure`
  - Exports (values):
    - `castHintFor`
    - `executeOne`
    - `executeResult`
    - `executeRows`
    - `formatSqlRowError`
    - `parseRows`
    - `queryOne`
    - `queryResult`
    - `queryRows`
    - `renderSqlValue`
    - `runtimeTypeOf`
    - `SqlRowError`

<!-- AUTOGENERATED:END -->
