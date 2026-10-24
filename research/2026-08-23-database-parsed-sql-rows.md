# Parsed SQL rows — closing the `pool.query<T>` assertion hole

## Context

`pool.query<Row>(sql)` declares a row type that nothing verifies. The generic is a
pure assertion: whatever `pg` decodes is handed to typed code as if it matched.
`tsc` is satisfied, the code reads as typed, and a mismatch surfaces as **wrong
behaviour**, never as an error.

This already cost a real incident. A fork-plan query used `array_agg(relname)`,
which produces `name[]` (OID 1003). `pg` has no decoder registered for that OID,
so the column arrived as the raw Postgres literal **string**
`"{_private_jobs,migrations,…}"` while its declared type said `string[]`.
Downstream, `for (const t of tables)` walked the string one character at a time
and `tables.includes(x)` silently became substring matching. The result: a
database fork that emitted sixty `pg_dump` patterns matching nothing, copied a
whole schema it was meant to empty, and reported success. No check, no lint rule,
no test caught it — the unit tests build their input by hand, so they can only
ever see a well-formed row.

That specific query is fixed (`::text` casts + a `zod` parse — see
`plugins/database/plugins/admin/server/internal/fork-plan.ts`, whose
`CatalogRowSchema` comment is the written-up incident). **The class is not.**
Every other raw-SQL row read in the repo has the same exposure, and the trap is
invisible.

The exposure is not limited to the explicit generic. Three spellings, all
unchecked:

| spelling | what it asserts | why it is worse than it looks |
|---|---|---|
| `pool.query<Row>(sql)` | the whole row | the incident above |
| `db.execute<Row>(sql\`…\`)` | the whole row | same, via drizzle's raw escape hatch |
| `const r = await pool.query(sql); r.rows` | **nothing** — `rows` is `any[]` | *worse*: `any` accepts every downstream misuse silently |

That third row matters for the design: a rule that banned only the generic form
would push authors onto the `any` form, which is strictly less safe. The fix has
to cover "rows were read at all", not "a type argument was written".

**Intended outcome:** a row whose runtime shape disagrees with its declared type
fails **loudly at the boundary**, with an error that names the column, what
arrived, and the pg type OID behind it — instead of being misread by everything
downstream.

## Design

### The end-user experience

```ts
import { queryRows, executeRows } from "@plugins/database/plugins/sql-rows/core";

// pg pool / client (string SQL)
const rows = await queryRows(getAdminPool(), {
  sql: `SELECT datname::text AS datname FROM pg_database ORDER BY datname`,
  row: z.object({ datname: z.string() }),
});
//    ^? { datname: string }[]  — parsed, not asserted

// drizzle raw escape hatch (SQL object)
const triggers = await executeRows(db, {
  query: sql`SELECT tgname::text, relname::text FROM …`,
  row: z.object({ tgname: z.string(), relname: z.string() }),
});
```

and, when the shape is wrong:

```
SqlRowError: row 0 of a SQL result did not match its declared shape.
  column "tables": expected array, received string
  value:  "{_private_jobs,migrations,graphile_worker}"
  pg type: OID 1003 — pg has no type parser registered for this OID, so the
           column arrived as its raw Postgres literal. Cast the column
           (e.g. `::text[]`, `::int`, `::text`) or register a parser.
  sql: WITH RECURSIVE tree AS (SELECT i.inhparent AS root, …
```

The OID line is the whole point. It turns a multi-hour "why is my fork empty"
into a one-line SQL cast.

### Where it lives

A new sub-plugin `plugins/database/plugins/sql-rows/`, owning both halves of the
guardrail:

```
plugins/database/plugins/sql-rows/
  core/index.ts                       # queryRows / executeRows / SqlRowError
  core/internal/parse-rows.ts         # the shared parse + diagnostic
  core/internal/errors.ts
  lint/index.ts                       # contributes the rule repo-wide
  lint/no-unparsed-sql-rows.ts
  lint/no-unparsed-sql-rows.test.ts
  CLAUDE.md
```

`core/` (not `server/`) because the callers span three runtimes: server plugins,
`check/` files (`migrations/check/orphaned-tables.ts`,
`migrations/check/fork-schema-drift.ts`), and `cli/`. `core` is the only barrel
all three may import. It stays web-safe: it depends on `zod` and on
**structural** interfaces only — no `import { Pool } from "pg"`, no drizzle
runtime import.

### API

```ts
/** Anything shaped like a pg Pool / PoolClient / Client. */
export interface SqlQueryable {
  query(sql: string, params?: unknown[]): Promise<SqlResult>;
}
/** Anything shaped like a drizzle db (raw `execute` escape hatch). */
export interface SqlExecutable<Q> {
  execute(query: Q): Promise<SqlResult>;
}
export interface SqlResult {
  rows: unknown[];
  rowCount: number | null;
  fields?: { name: string; dataTypeID: number }[];
}

export function queryRows<T>(
  client: SqlQueryable,
  opts: { sql: string; params?: unknown[]; row: ZodParser<T> },
): Promise<T[]>;

export function executeRows<T, Q>(
  db: SqlExecutable<Q>,
  opts: { query: Q; row: ZodParser<T>; label?: string },
): Promise<T[]>;

/** Exactly one row expected; throws on 0 or ≥2. Not absorbable. */
export function queryOne<T>(client, opts): Promise<T>;
export function executeOne<T, Q>(db, opts): Promise<T>;
```

`ZodParser<T>` is reused from `@plugins/packages/plugins/zod-parser/core` — the
existing canonical "a schema that parses **untrusted** input into a `T`" type,
which closes the `z.ZodType<T>` Input-defaults-to-Output trap that would
otherwise make the parse a second assertion.

Design notes:

- **Client-first, options-object.** The client is the subject; `sql` / `params` /
  `row` are named at the call site so nobody has to remember positional order,
  and `params` is naturally optional. It also gives the helper the SQL text, so
  the error can quote it.
- **No rows-returning door that skips the parse.** `row` is required and
  `ZodParser<T>` cannot be inferred from a type argument, so `queryRows<Row>(…)`
  with no schema does not typecheck. The wrong thing has no spelling *through
  this door*; the lint rule closes the other doors.
- **DDL/DML is untouched.** `pool.query(ddl)` and `db.execute(sql\`DELETE …\`)`
  that never read `.rows` stay exactly as they are. This keeps the change
  proportionate: ~120 `.query(`/`.execute(` call sites exist, but only the
  row-reading subset moves.
- **Failure is a type.** `queryOne` throws rather than returning `T | undefined`,
  so "no row" can never be absorbed as "empty". `queryRows` returning `[]` is a
  legitimately-empty success, which is exactly what the parse guarantees.

### The diagnostic

On a `ZodError`, `parseRows` rethrows a `SqlRowError` built from:

- the failing row index and the zod issue path,
- the **actual runtime value** at that path,
- the column's `dataTypeID` from `result.fields`, matched by the issue path's
  first segment,
- a targeted hint when the received value is a `string` but the schema expected
  an array / object / number — the exact signature of "pg had no decoder for
  this OID" — naming the cast that fixes it,
- the SQL, truncated.

`result.fields` is available on both pg and drizzle results, which is why the
structural `SqlResult` interface carries it.

### Enforcement — where on the ladder

The repo's ladder: 1 inexpressible → 2 type error → 3 check/lint → 4 loud
runtime → 5 docs.

**Chosen: rung 1 through the sanctioned door, rung 3 for the other doors.**

Inside `queryRows`/`executeRows` the unparsed read is *inexpressible* (no
overload accepts a type argument instead of a schema). Getting to the raw
result at all is then a lint error:

`sql-rows/no-unparsed-sql-rows` reports a `CallExpression` whose callee is a
member named `query` or `execute` when **either**

- (a) the call carries explicit type arguments — `.query<T>(…)`, `.execute<T>(…)`, or
- (b) the call's result is read for rows — `(await c).rows`, `const { rows } = await c`,
  or `const r = await c; … r.rows` (resolved through scope analysis on the
  declarator's variable references, so the common two-statement shape is caught).

The rule is **not type-aware**, matching the closest precedents
(`no-raw-bun-spawn`, `no-adhoc-file-sink`, `no-narrow-zodtype`): the
`property-named-query/execute` **and** `rows-are-read` conjunction is specific
enough that a type check would buy precision the repo has not needed. Type-aware
rules are available here (`ESLintUtils.getParserServices`, wired identically in
the IDE and the `type-check` worker) and are the fallback if false positives
appear.

Self-exemption follows the sanctioned mechanism, not `eslint-disable`: an
in-rule owner-directory skip
(`if (filename.includes("plugins/database/plugins/sql-rows/")) return {}`), plus
a barrel-level `ignores` map for any structurally-forced exception, each with a
written justification. Test files are off by default via the framework's
`NON_APP_FILE_GLOBS` (no `enforceEverywhere` entry) — matching
`no-pool-await-in-transaction`.

### Alternatives considered and rejected

**Narrow the pool handouts to a facade type (rung 2).** `getAdminPool()` and
`openShortLivedClient()` could return a `SqlConn` with no `.query` at all, making
the mistake a *tsc* error rather than a lint error for their ~20 callers. Rejected
as the primary mechanism: it cannot reach drizzle's `db.execute` (narrowing the
drizzle instance would break 158 legitimate DDL/DML call sites) nor the ad-hoc
`new Pool(…)` inside `check/` files — precisely where two of the current unchecked
reads live. The lint rule is needed regardless, and it covers 100% of the class;
adding the facade would be a second mechanism enforcing the same rule with
partial reach. Noted as a possible later tightening, not a gap.

**Register the missing pg type parsers** (`pg.types.setTypeParser(1003, …)`).
Fixes `name[]` and hides the class instead of surfacing it — and does nothing for
`numeric`/`int8`, which pg returns as strings *by design*. The parse detects all
of them; the diagnostic then names the cast.

**Do nothing but document it.** Rung 5, reaches only whoever reads it. The
incident happened in a file whose own header documents the surrounding class of
silent misses.

### Out of scope (follow-up)

`sql<T>\`…\`` inside a drizzle **select projection** (23 sites, e.g.
`sql<number>\`count(*)\`` → actually a `string`) is the same assertion one layer
down, but the fix is different in kind: drizzle offers `.mapWith()` for exactly
this, so the guardrail is "`sql<T>` must carry a `.mapWith(…)` unless `T` is
`string`/`unknown`". Filed as a separate task rather than folded in here.

## Implementation

1. **`plugins/database/plugins/sql-rows/core/`** — `SqlResult`/`SqlQueryable`/
   `SqlExecutable` structural types, `parseRows` (the shared parse +
   `SqlRowError` diagnostic), and the four front doors. Unit-tested against
   hand-built results, including the exact `name[]`-as-string case.
2. **`plugins/database/plugins/sql-rows/lint/`** — the rule + its `RuleTester`
   suite, mirroring `plugins/database/lint/no-pool-await-in-transaction.test.ts`
   byte-for-byte in shape (plain `eslint` `RuleTester`, `tsParser`, top-level
   `ruleTester.run`, `messageId` assertions, `filename` cases for the owner-dir
   skip).
3. **Migrate every row-reading raw-SQL site.** Run `eslint` with the new rule to
   enumerate them exhaustively rather than trusting a grep. Representative
   files: `database/plugins/admin/server/internal/{databases,backup}.ts`,
   `database/plugins/change-feed/server/internal/{triggers,view-deps}.ts`,
   `database/plugins/live-state-snapshot/server/internal/{persist,catch-up}.ts`,
   `database/plugins/migrations/check/{orphaned-tables,fork-schema-drift}.ts`,
   `database/plugins/query/server/internal/mcp-tools.ts`,
   `debug/plugins/{timeline,slow-ops/plugins/cluster,profiling/plugins/ops}/…`,
   `search/plugins/engine/server/internal/handle-search.ts`,
   `infra/plugins/jobs/server/internal/*.ts`,
   `apps/plugins/studio/plugins/contributions/plugins/tables/plugins/*/server/…`.
   Each conversion writes an honest schema. Where a column's true pg type is a
   string (`int8`, `numeric`, uncast `name`), the fix is a **SQL cast** so the
   type is honest — not `z.coerce`, except where a value genuinely exceeds
   `Number.MAX_SAFE_INTEGER` and must stay a string.
4. **`CLAUDE.md`** for the new plugin, and a pointer from
   `plugins/database/CLAUDE.md`'s guardrail paragraph (which already pairs
   `no-pool-await-in-transaction` with the branded-executor rung).
5. **Follow-up task** for the `sql<T>` projection class.

## Verification

- `./equin test plugins/database/plugins/sql-rows` — the parse unit tests
  (including the `name[]`-as-string reproduction) and the lint-rule `RuleTester`
  suite.
- `./equin check` — `type-check` (which also runs the type-aware lint pass)
  and `eslint`; the new rule must report **zero** remaining sites after the
  migration, which is the proof the inventory was exhaustive.
- `./equin build` — boot exercises the converted hot paths for real:
  `change-feed/triggers.ts` (trigger install reads `pg_class`/`pg_attribute`),
  `derived-views/rebuild.ts`, `migrations/server/runner.ts`,
  `live-state-snapshot/catch-up.ts`. A schema that disagrees with reality now
  fails the boot loudly instead of being misread — that is the intended
  behaviour, and any such failure is a **real latent bug found**, to be fixed by
  casting the column.
- `query_db` MCP tool still returns arbitrary rows (it parses with a
  passthrough record schema, since its shape is genuinely caller-defined).
- Spot-check in the app: Debug → Slow Events / Timeline and Studio →
  Contributions → Tables (columns / indexes / FKs / row-count / sample rows) all
  read raw catalog SQL and must render unchanged.

## Inventory (measured, not guessed)

A full sweep of the repo found **~75 row-reading raw-SQL sites** in non-test code,
across three spellings, and **zero** shared parsing helpers — `fork-plan.ts`'s
`CatalogRowSchema` is the only zod-at-the-pg-boundary in the codebase, invented
from scratch and reused by nothing.

| spelling | sites | notes |
|---|---|---|
| `pool.query<T>` / `client.query<T>` | 15 | all currently correct-by-luck (scalar `name`, explicit casts) |
| `db.execute<T>` | ~45 | contains the one confirmed live bug (below) |
| `db.execute(...)` then `as T[]` / `as unknown as T[]` | ~15 | invisible to any rule that looks only at the generic |
| `sql<T>` in a drizzle projection | ~20 | **out of scope**, follow-up task |

That third row is why the rule keys on *rows are read*, not on *a type argument
was written*.

### Latent bugs the sweep found (fix during migration)

1. **`plugins/infra/plugins/jobs/server/internal/resources.ts` — `GraphileJobRow`.**
   `run_at`, `locked_at`, `created_at`, `updated_at` are declared `string` but
   selected from real `timestamptz` columns with no `::text` cast — node-postgres
   decodes those to **`Date`**. The declared type is *actively wrong*, not merely
   unverified. Fix: declare the truth (`z.date()` / `Date`), **not** a `::text`
   cast — the values currently reach the wire through `JSON.stringify`, which
   already serialises a `Date` to ISO-8601, whereas `::text` would change the
   payload to Postgres's `2026-08-23 12:00:00+00` format. Typing the truth is a
   zero-behaviour-change fix; casting is not.
2. **`…/studio/…/tables/plugins/sample-rows/server/internal/sample-rows-handler.ts`** —
   `SELECT * FROM <arbitrary table> LIMIT 10` typed `Record<string, unknown>` and
   shipped straight to the HTTP response. The table is unbounded by construction,
   so no schema can describe its columns; the honest parse is
   `z.record(z.string(), z.unknown())`, which asserts exactly what is knowable
   (each row is an object) and nothing more.
3. **`plugins/infra/plugins/jobs/server/internal/introspection.ts`** — `hold` is a
   `CASE`-derived text column asserted into a string-literal union with no check.
   A `jobHoldExpr` branch falling through to an unexpected value mistypes
   silently. Fix: `z.enum([...])` over the real hold classes.

### Sites that must keep an honest wide schema

`plugins/database/plugins/query/server/internal/mcp-tools.ts` (`query_db`) runs
agent-authored SQL: there is no fixed shape to assert, and today it correctly
declares none. It moves to `queryResult` with `z.record(z.string(), z.unknown())`
— which keeps it honest, keeps `fields` (it needs the column names), and brings
it inside the sanctioned door rather than leaving one raw `.query()` outside it.

### Measured pg decoding (probe against the live cluster, 2026-08-23)

> **Corrected after the fact — see "The timestamp trap" below.** The table that
> follows was measured through a **raw `pg` client**. Drizzle's `db.execute`
> decodes timestamps differently, and the `GraphileJobRow` claim below is wrong
> as originally written.

Run against the real embedded Postgres, so these are facts rather than lore:

| expression | OID | JS type node-postgres hands back |
|---|---|---|
| `now()` (timestamptz) | 1184 | **`Date`** |
| `count(*)` (int8) | 20 | `String` |
| `count(*)::int` (int4) | 23 | `Number` |
| `array_agg(c.relname)` (name[]) | 1003 | **`String`** — the incident, reproduced |
| `1.5::numeric` | 1700 | `String` |

No `setTypeParser` override exists anywhere in the repo or in a dependency
(checked `node_modules`), so these defaults are what every raw query gets. This
confirms finding 1 above: `GraphileJobRow.run_at` is a `Date`, the wire schema
`JobsPayloadSchema` declares `runAt: z.string()`, and
`resource-runtime`'s `entry.schema.parse(await entry.loader(...))` runs on every
load — so `jobs-list` throws whenever `_private_jobs` is non-empty. It reads as
healthy most of the time only because graphile deletes finished jobs, leaving the
table empty between ticks. The fix follows the local precedent two functions
below it (`loadDeadJobsList` already converts `Date` → ISO before the wire).


## The timestamp trap (found by the guardrail, during its own migration)

The measured table above was taken with a raw `pg.Pool`, and the conclusion
drawn from it — that `GraphileJobRow`'s `run_at: string` was a live bug because
`timestamptz` decodes to a `Date` — was **wrong**, and was propagated to the
migration agents as instruction.

`drizzle-orm/node-postgres` attaches a per-query type-parser override
(`node-postgres/session.js`) that returns `TIMESTAMPTZ`, `TIMESTAMP`, `DATE` and
`INTERVAL` as their **raw string**, leaving the mapping to drizzle's own column
types. A raw `pg` client has no such override and applies pg's default `Date`
parser. So the same column is:

| read through | what arrives |
|---|---|
| `db.execute(sql\`…\`)` — drizzle raw | **`string`** |
| `pool.query(…)` — raw `pg` client | **`Date`** |
| `db.select().from(table)` — drizzle typed | `Date` |

Nothing in the SQL distinguishes these. `jobs-list` was therefore correct all
along, and the "fix" broke it.

**It was caught in under a minute, by the thing being built.** With a live row
in the queue, the loader refused and said:

```
[resources] loader failed for jobs-list: row 0 of a SQL result did not match its declared shape.
  column "run_at": expected date, received string
  value: "2026-08-23 17:58:18.780242+02"
  pg type: OID 1184
  sql: jobs-list
```

Column, value, OID, query. Under the old `pool.query<T>` spelling the same
mistake would have shipped a `Date` into code typed `string`, and surfaced —
much later — as whatever the first string method to be called on it did.

Reverted: `jobs/resources.ts` declares `z.string()` for the four timestamps and
passes them through unconverted. The timeline sources keep `z.date()`, because
they genuinely read through `openShortLivedClient` (raw `pg`). Both are now
stated in `plugins/database/plugins/sql-rows/CLAUDE.md` under "The timestamp
trap", which is where the next author will look.
