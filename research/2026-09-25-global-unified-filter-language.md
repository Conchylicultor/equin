# One filter language for DataView and live collections

## Context

The same filter operators are implemented three times, and nothing keeps the copies in step:

| Where | In memory | SQL | What keeps them in step |
|---|---|---|---|
| DataView, per field type (`text`, `enum`, `bool`, `number`, `date`, `tags`) | `fields/*/plugins/filter/web/internal/*-filter-logic.ts` | `fields/*/plugins/filter-sql/server/internal/*-filter-sql.ts` (via `Fields.FilterSql`, `resolveFieldFilterSql`) | Prose comments ("SQL twin", "truth-table parity"). The tests only check the rendered SQL string, and never run against Postgres. |
| Live collections | `network/live/core/internal/ops.ts` (`liveOps[..].test`) | `network/live/server/internal/op-sql.ts` | `LiveOpId` keying plus `op-parity.test.ts`, which runs against real Postgres. |

The two languages disagree on three things:

- **NULL.** Live `ne` / `notIn` drop NULL rows. DataView's text, enum and tags negatives keep them. DataView's number and date `≠` drop them, and `bool` folds NULL into false.
- **Names.** Live uses `eq / ne / in …`; DataView uses `is / is-not / is-any-of …`.
- **Expressiveness.** `LiveWhere` is an AND across columns. DataView's `FilterGroup` has AND/OR nested to any depth, day-granular dates, and relative anchors (`today`, `within the past N`).

So a filtered DataView cannot read from a live collection. The seven revision-tick lists (conversations, runs, mail, events, deploys, reports, release history) keep a second list mechanism.

**Goal:**

- One filter language and one op table.
- Each op defined once, with its SQL and its in-memory check side by side, and pinned against Postgres.
- Every filter the DataView bar can build can be sent to the server as a query. Nothing silently falls back to filtering on the client.
- The live runtime never depends on the field-type registry.
- The server can check a filter in memory for each subscription, with no clock.

## Decisions

- **NULL: complement (user, 2026-09-25).** Every negative op returns exactly the rows its positive op does not. Logic is plain true/false, and NULL is a value that matches no positive op except `isEmpty`.
  - This keeps DataView's text/enum/tags behaviour.
  - It changes number/date `≠` (these now keep NULL) and live `ne` / `notIn` (no caller today).
  - In memory, `not` is then just `!`.
- **Relative time: the client lowers it (user, 2026-09-25).**
  - The browser turns `today`, `N days ago` and `within the past N` into absolute instant bounds, in its own timezone, before the query leaves.
  - The wire language has no op that reads the clock, so a server-side check stays pure.
  - This also closes the server-timezone gap documented in `date-filter-sql.ts`.
- **Two vocabularies, one language.**
  - DataView's operator ids (`is-not`, `is-any-of`, `is-within-past` …) stay as the **field-level UI vocabulary**. Saved views persist them, so no saved config is migrated.
  - Each DataView operator *lowers* to an expression in the one language. The language uses the live names (`eq`, `ne`, `in`, `notIn`, `lt` …).
  - The field-type registry is consulted only during lowering, which is DataView's side of the line. The runtime sees only the lowered expression.

## The language

A new leaf plugin, **`plugins/network/plugins/live/plugins/filter/`** (`core/` + `server/`). Both `network/live` and `primitives/data-view` import it. It imports neither of them, nor `fields`.

### Domains (closed set, `core/`)

A filterable column declares a **domain**, never a field type. Each domain owns:

- how a row value is normalized;
- what emptiness means;
- which ops it takes;
- the operand schema.

| Domain | Row value | Empty | Ops |
|---|---|---|---|
| `text` | string | NULL or whitespace-only | `eq ne in notIn lt lte gt gte`, `eqCi neCi`, `contains notContains` (case-insensitive), `isEmpty isNotEmpty` |
| `number` | finite number | NULL | `eq ne in notIn lt lte gt gte isEmpty isNotEmpty` |
| `boolean` | boolean | NULL | `eq ne isEmpty isNotEmpty` |
| `instant` | ISO-Z string or `Date` (normalized to epoch ms); ISO-Z on the wire | NULL | `lt lte gt gte isEmpty isNotEmpty` |
| `stringArray` | `string[]` (jsonb) | NULL, not an array, or `[]` | `hasAll hasAny hasNone isEmpty isNotEmpty` |

- **Declaration spelling:** `filterable: { status: liveText(StatusSchema), createdAt: liveInstant(), labels: liveStringArray() }`.
  - The optional narrowing schema types the operand in `tsc` only.
  - At runtime an operand is checked against the **domain** (any string, finite number …), never against the column's value schema. An operand is not a stored value (`research/2026-08-27-global-filter-operand-domain.md`), so a stale enum option in a saved view matches nothing instead of throwing.
  - This fixes a latent bug: the live codec parses operands with the column schema today.
- **Enum is `text`** with case-sensitive `eq` / `in`. `int` / `float` are `number`. `uuid` / `multiline-text` / `rank` are `text`.

### Ops: defined once, SQL and in-memory together (`core/`)

Each op is one entry in one table:

```ts
eq: { domains: ["text","number","boolean"], operand: "value",
      test: (v, x) => v !== null && compare(v, x) === 0,
      sql: tpl`${T} = ${P}` },
ne: complementOf("eq"),
```

- **`sql` is a dialect-free template, so `core/` stays browser-safe.**
  - `tpl` is a tiny tagged template in core. Its holes are `T` (the target), `P` (the operand) and `P.list` (one array param).
  - The server has one ~20-line renderer (`renderOpSql(tpl, target: SQL, operand)`) that turns it into drizzle `sql`.
  - Nothing under web imports drizzle today, and this keeps it that way.
- **`complementOf(pos)` is the only way to spell a negative op.**
  - `test = !pos.test`; `sql = (<pos>) IS NOT TRUE`.
  - So "negative keeps NULL" is true by construction, not restated per op.
  - The pairs are `ne/eq`, `notIn/in`, `neCi/eqCi`, `notContains/contains`, `hasNone/hasAny` and `isNotEmpty/isEmpty`.
  - Range ops (`lt`, `gt`, …) are positive, and fail on NULL.
- **Case folding follows the cluster.**
  - The cluster is `C`-collated, where `lower()` / `ILIKE` fold ASCII only.
  - So `eqCi` / `contains` fold ASCII only in memory too.
  - This is a real divergence today: JS `toLowerCase` folds `É`, Postgres does not. The parity test pins it.
- `in` / `hasAny` lists are capped at `LIST_MAX = 100`, as today.

### Expression (`core/`)

```ts
type Filter = Clause | { and: Filter[] } | { or: Filter[] };
type Clause = { column: string; op: OpId; operand: … }   // correlated per op, as LiveClause today
```

- **No `not` node.** Every negation is an op, so negation never has to be pushed through a tree.
- **Canonical form, one function:**
  - flatten same-kind nesting;
  - drop singleton groups;
  - `and: []` is the absent filter;
  - sort and dedupe children by canonical JSON;
  - sort and dedupe list operands;
  - fold `{eq: x}` to `x`.
  - Decode stays strict: re-encode and compare, as `query-codec.ts` does now.
- **Bounds:** at most 4 levels deep and at most 50 clauses, so the params key and the SQL stay bounded. Decode throws on any column not in the declaration's `filterable` (a security whitelist, as today).
- **Evaluation:** `matchesFilter(row, filter, filterable)` evaluates in memory using the ops' `test` and the domain normalizers. It reads no clock, and throws on a missing field (as `matchesLiveWhere` does). This is the per-subscription routing hook the runtime can adopt later.
- **Server compile:** `filterSql(filter, targets: Record<column, SQL>)`, with the targets rendered as `sql\`${col}\`` (the comparison-target rule).
- `LiveWhere`'s per-column object stays as **sugar**. It is an AND of clauses, and a `where` may also be a `Filter` tree (`or(...)`, `and(...)` helpers). Both encode to the same canonical tree.

## DataView onto the language

- **`FilterOperator` loses `predicate` and `isComplete`, and gains `lower`:**
  ```ts
  lower(operand: unknown, ctx: { column: string; now: number }): Filter | undefined
  ```
  - `undefined` means the rule is incomplete. The chip counter and the evaluator both read that one answer, so the two cannot disagree (rung 1: one function replaces the pair).
  - `FilterOperatorSet` declares its `domain`. Lowering examples:
    - `text is` → `eqCi`; `text is-not` → `neCi`; `contains` → `contains`.
    - `enum is-any-of` → `in`; `is-none-of` → `notIn`.
    - `number between` → `and(gte, lte)`.
    - `date is` → `and(gte dayStart, lt nextDayStart)` in ISO; `is-within-past` → the same kind of range, from `withinRange(…, now)`.
    - `bool is v` → `v ? eq true : ne true` (NULL still reads as false, with no OR).
    - `tags contains t` → `hasAll [t]`; `does-not-contain` → `hasNone [t]`.
  - The anchor math (`fields/date/plugins/filter/core/date-anchor.ts`) is reused as is.
- **`lowerFilterGroup(group, fields, resolveOperatorSet, now) → Filter | null`** (`data-view/web`) walks the `FilterGroup`. It also reports `readsClock` when any rule used a relative anchor.
- **In-memory DataViews:** `applyFilter` becomes lower-then-`matchesFilter`.
  - The row accessor is DataView's `projectFieldValue`, coerced to the domain by one DataView-side adapter. Examples: a text projection of an array joins with spaces, as `fieldText` does now; a `Date` becomes epoch ms.
  - The language itself stays strict.
- **Day rollover:** `useFilterClock(readsClock)` returns `now`, and re-renders once at the next local midnight, and only while the filter reads the clock. It is one scheduled timer to a known instant, not a polling loop.
- **Nothing silently falls back to the client.**
  - A server- or live-backed DataView takes its **declared `filterable` map** (column → domain). A live source reads it from `liveCollection`. A tick source gets it from a new `filterable` field on `ServerDataSourceSpec`, declared once in the owning plugin's `core/` and shared with its server column map.
  - The filter bar offers only those fields, and only operators whose set's domain matches.
  - The server decode throws on anything else, so an unbound field can no longer be dropped quietly. Today `compileWhere` drops unmapped fields, e.g. `events` `tags`.
- **Search:** the DataView `query` lowers to `or(contains(col, q) …)` over the source's declared `searchable` columns. The hand-written `searchWhere` in each handler goes away.
- **Deleted:**
  - the six `*-filter-logic.ts` files and their tests;
  - the six `filter-sql` sub-plugins;
  - `Fields.FilterSql` / `resolveFieldFilterSql`;
  - `OperatorSqlResolver`;
  - every "SQL twin" comment.

## Server-delegated (revision-tick) lists onto the language

- `ServerDataSourceSpec.fetchPage` receives the lowered `Filter` instead of the raw `FilterGroup`. The client lowers, so timezone and relative anchors are resolved in the browser.
- `compileWhere(filter, columnMap)`:
  - `ColumnBinding.type` (a field-type id) becomes `domain`.
  - The builder lookup becomes `filterSql` from the language plugin.
  - It stays field-agnostic, and now also stays registry-free.
- `union-query` arm pruning reads clause columns instead of rule `fieldId`s.
- Custom-column augmentor bindings carry the custom field's domain.
- **Consumers to re-point** (column maps and handlers): conversations `all-conversations`, events `event-list`, mail `threads` (`where.ts`), deploy `deployments`, `release` history, `reports`, and `runs` (union).
  - Each column map's `type:` becomes a `domain:`.
  - Each handler parses the body with the language's strict decode against its declared `filterable`.

## Live runtime onto the language

- Delete `network/live/core/internal/ops.ts`, `matches.ts` and `server/internal/op-sql.ts`. Import the language plugin instead.
- `createLiveQueryCodec` encodes and decodes a `Filter` tree:
  - A `where` made only of object sugar canonicalizes to an AND of clauses.
  - The default window stays `{ limit: "100" }`, byte-identical, so boot-snapshot tuples do not change.
- `liveCollection`'s `filterable` takes domain constructors. The two declarations in the repo migrate: `shell/notifications/shared/resources.ts` and `events-core/core/internal/resources.ts`.
- `:groups` and `serveCollection`'s base `where` go through the same compiler.

## What this does not do (follow-ups, to file as tasks)

- **Moving a tick list onto `useLive`.** The filter language is no longer a blocker. What remains is cursor paging past `maxLimit`, and joined or side-table columns: custom columns, and the §9 open question. Every tick list uses custom-column augmentors, except `runs`, whose `duration` is computed against `now()`, which no live query can track.
- **Per-subscription in-memory routing.** `matchesFilter` makes it possible; wiring it into the runtime is the `routeTuples` change from the unified-API doc.
- **`dynamic-enum` stays unfilterable.** It has no operator set, which is the same as today.

## Critical files

- **New:** `plugins/network/plugins/live/plugins/filter/{core,server}/…`: `domains.ts`, `ops.ts` (with `tpl`, `complementOf`), `expr.ts` (types, canonicalize, codec, `matchesFilter`), `server/render.ts` (`renderOpSql`, `filterSql`), `server/parity.test.ts`.
- **Live:** `network/live/core/internal/{query.ts,query-codec.ts,live-collection.ts}`, `network/live/server/internal/serve-collection.ts`.
- **DataView:**
  - `primitives/data-view/core/internal/types.ts` (`FilterOperator`, `FilterOperatorSet.domain`, `ServerDataSourceSpec`);
  - `web/internal/{evaluate-filter.ts,rule-resolution.ts,use-server-data-source.ts,use-flat-rows.ts}`;
  - the filter bar's field and operator offering (`web/filter-slot.ts`);
  - `plugins/server-query/server/internal/{compile.ts,augment.ts}`;
  - `plugins/union-query/server/internal/compile-union.ts`;
  - `plugins/custom-columns/server/internal/query-augmentor.ts`.
- **Fields:** `fields/plugins/{text,enum,bool,number,date,tags}/plugins/filter/web/operator-set.ts` (gains `lower`); delete `…/filter-sql/` and `fields/plugins/server-capabilities/server/internal/filter-sql.ts`.
- **Consumers:** the seven column maps and handlers listed above.
- **Docs:**
  - `network/live/CLAUDE.md`, `server-query/CLAUDE.md`, `fields/*/filter` CLAUDE.md;
  - the unified-API doc's "DataView bridge" paragraph (superseded);
  - a status line on the Resources page, written as an agent note.

## Order of work (each step builds green)

1. Language plugin: domains, ops, expression, render, and the Postgres parity suite.
2. Live onto it: delete the old op table; migrate the two declarations; codec tests.
3. DataView in-memory onto it: `lower` on the six operator sets; `applyFilter` via `matchesFilter`; delete `*-filter-logic.ts`.
4. Server-delegated onto it: `fetchPage` sends the lowered `Filter`; `compileWhere` / `union-query` switch; declare `filterable` / `searchable` per source; migrate the seven consumers; delete `filter-sql`.
5. Docs and the page note.

## Verification

- **Parity (Postgres, `createTestDb`), in `live/plugins/filter/server`:**
  - every op × every domain × values with NULLs, empty strings, whitespace, non-ASCII case, astral characters, non-array jsonb, and ms/µs instants, checked in memory against Postgres;
  - every complement pair is disjoint, and together they cover all rows;
  - random `and`/`or` trees up to depth 4 agree between memory and Postgres.
- **Codec (bun:test):**
  - canonicalization: permuted children, nested same-kind groups, singleton groups, and `{eq:x}` all encode to the same bytes;
  - strict decode throws on an unknown column, a wrong-domain op, depth or clause count over the cap, or a non-canonical input;
  - a stale enum operand decodes and matches nothing.
- **Lowering (bun:test, per field type):** a table of `(operator, operand, row value)` → expected, carried over from the current `*-filter-logic.test.ts` cases.
  - Only the number/date `≠`-with-NULL rows change, and they are listed in the test as the decided change.
  - Date lowering runs under a pinned clock and timezone.
- `./equin test plugins/network/plugins/live plugins/primitives/plugins/data-view plugins/fields`
- `./equin check` (type-check, plugin-boundaries: the language plugin imports no `fields` / `data-view`, and `plugins-doc-in-sync`).
- `./equin build`, then E2E with `screenshot.ts`:
  - on All conversations, filter `status is none of [done]` OR `created within past 1 week`, and check the rows against `query_db`;
  - on the notifications bell, the type chips still work (a live `in` filter);
  - on events, `tags` is no longer offered unless it is bound.
