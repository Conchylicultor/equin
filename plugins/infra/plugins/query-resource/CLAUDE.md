# query-resource

Rationale (why each rule is so, rejected alternatives): [DESIGN.md](DESIGN.md) — read before changing or removing a rule.

The SQL compiler under `network/live`'s live-resource API.

**It is not a way to declare a resource**: a new collection is
`liveCollection` + `serveCollection`, a new value `liveValue` + `serveValue`
(`plugins/network/plugins/live/CLAUDE.md`).

`query-resource` never imports `network/live` (test files included) — the
dependency runs the other way. The compilers' main tests therefore live in
`network/live/server/internal/` and reach them through this plugin's
`server/testing`.

| Compiler | Compiles |
|---|---|
| `windowQueryResource` / `deferredWindowQueryResource` | a collection's window and its `:rows` point sibling (*Bounded membership*) |
| `compileGroupsQuery` | the `:groups` sibling — the one non-keyed (push) output, with a `reach` plan |
| `compileCountQuery` | the `:count` sibling (`count: true`): the grouping planner (`planGroupArm`) with a constant for the grouped column, no GROUP BY — always one row |
| `compileAllCollection` | a collection declared `all` and its `:rows` (*The `all` compiler*) |
| `compileUnionCollection` | a union's window / `:rows` / `:groups` (*Union collections*) |
| `compileLookup` | a by-key read beside a hand-written value loader (*Lookups*) |
| `compileOffFeedQuery` | the window / point loaders alone, for `serveCollection`'s `changes` (external membership + `reads`, declared unfed) |

Every keyed compiler takes ONE drizzle declaration and derives from it:

- the FULL loader;
- the scoped loader;
- the scope policy (routes + membership — never hand-authored, so it cannot
  drift from what the SQL reads);
- the client `keyField`.

These are exactly the options keyed `defineResource(descriptor, …)` accepts.

## What it derives

1. **Identity** (`internal/identity.ts`, `resolveIdentity`).
   - The source is a `RoutedSource` (`PgTable | Entity`, never a view): an
     `Entity` projects its `wireColumns`, a `PgTable` selects all.
   - The pk is the table's single primary key. Composite / missing pk without
     `identity.pk` throws — such a payload is a pushed `liveValue` instead.
2. **keyField** — the projection key whose column matches the pk (by DB column
   name, so an aliased projection keys on the alias), else the pk's property
   name. Throws if the pk is unprojected or the descriptor's `queryPk`
   disagrees.
3. **FULL loader**, and a **scoped loader** (`pk IN (affectedIds)`, no order /
   limit — the partial refill a membership drain runs).
4. **ScopePolicy** — routes + a membership (window / point `membership`, or the
   `all` set's `scopedMembership` with `orderOf` / `orderSignatureOf`). Every
   compiled order declares an order signature, so a refilled row whose sort
   position moved re-derives order.

**Keyed, except the grouping.** A keyed loader may return a partial (scoped)
array that the keyed diff merges; a push loader doing that would broadcast the
partial array as the whole value. So:

- every compiler that refills by id emits a KEYED resource (keyed-ness from the
  client descriptor);
- the grouping has no scoped loader — every reach route is `full`.

## Routes: the bounded and grouping compilers emit what their SQL reads

Window, grouping, `all` and union compiles are **routed**: from the same
declaration they render SQL from, they emit the `RoutePlan` the runtime's
`routeTableChange` serves them by (`internal/routes.ts`).

- **window / point** — an `identity` route (`base`) on the base table (role
  `membership`) plus one route per join (*Joins*). When the identity pk is not
  the table's primary key, the route reads it off the change's key layout.
- **`all`** — as a window (+ one route per rollup SOURCE and the grouped joins'
  routes), under a `scopedMembership`; its `:rows` is a point membership over
  the same routes.
- **grouping** — `reach`: one `full` route per relation. A write to a table it
  does not read reaches none.
- **Route `columns`** (the `unchanged` gate) are exactly the columns of that
  table the SQL may reference over every tuple:
  - projection, identity, join conditions, static `where`;
  - the declared per-params `where` columns (`whereReads` on a window spec,
    `reads` on a grouping spec);
  - the order signature.

  A function `where` with no declared universe means every column of every
  relation; with one, a tuple's `where` reading outside it throws.
- **Never a view (A1)**: a change arrives under base-table names. `from` is
  typed `RoutedSource`; an untyped view throws at module eval. The change-feed
  boot asserts every route table is triggered
  (`change-feed/server/internal/route-coverage.ts`).
- **No cascade edges (A5)**: the runtime refuses `dependsOn` beside `routes` /
  `reach`.
- **`internal/routes.ts` is the one production minter.** Plans are minted by
  `mintRoutePlan` / `mintReachPlan` (type-branded, never a literal). The
  `resource-runtime:compiled-routes` check allows the minters only there and in
  tests — only the code that renders the SQL may state route columns.
- **Drift guard (A8)**: each loader run's captured tables are checked against
  the route tables (plus `derivedReads`, A22 — see *Rollup routes*), so a
  compiler that forgets a table fails its tests loudly.
- **One join → its routes (`joinRoutes`) → its ids (`JoinPlan.routeIdsOf`)**:
  - a window join is one route (id = alias);
  - a rollup is one per source;
  - `routedReads`' `tuple()` fans uses out over every id.

## Lookups — `compileLookup` (`server/internal/compile-lookup.ts`)

```ts
compileLookup({ label, from, by, joins, select, row }); // joins optional
```

A by-key read ("which checkout is this conversation in?") compiled through the
same point plan as `:rows`, so query and read-set cannot disagree.

- `run(key)` → `LookupResult` (`found` / not).
  - One statement carrying `readTag(label)`.
  - `by` is the single-column pk; joins are N:1 (more rows throws).
- `read(keyOf)` → a branded `LookupRead<P>`:
  - one `full` route per relation (`<label>:<relation>`);
  - exact `columns`;
  - the key table's route `match`ing the key.
- `compiledValueReach` folds `reads.lookups` beside `reads.tables` (lookup
  tables become `taggedReads`). A table in both, a lookup twice, or an unminted
  read is refused.
- Cases: `compile-lookup.test.ts`.

## Follows — `followRead` (`server/internal/follow.ts`)

A computed value (network/live's `serveValue` with `follows`) reading one
TUPLE of a collection — its `:rows` point set (`{ ids }`) or one scope of a
scoped `all` set (`{ where }`) — through that collection's own read
(`research/2026-10-24-global-live-narrowed-reads.md` §2). Nothing about the
read is restated: the compile that minted the collection's plan mints its
**followable** beside it — `CompiledWindowQuery.followable` (a point set;
`null` for a window) and `CompiledAllCollection.followable` (`rows` always,
`all` for a scoped set) — branded, so no literal spells one. network/live
registers a `:rows` set through **`pointQueryResource`** /
**`deferredPointQueryResource`** (`windowQueryResource` plus its followable;
the deferred one's getter throws until bound).

**`followRead(followable, name, tupleOf)`** → a branded `FollowRead<P>` for a
follower keyed by `P`:

- **routes** — the collection's own, one per route of its plan (ids
  `<name>:<route id>`): `columns` (the gate) and static `rows` kept, mapped
  `full` (a value has no host ids to refill), tagged `via: { name,
  collection }` (resource-runtime's `RouteVia`). The base route matches on
  the identity column (`{ ids }`) or the scope columns (`{ where }` — the
  `all` compile's own `scopeOf` match); the feed carries a match column
  old ∪ new, so a re-pointed row reaches the tuple it left and the one it
  joined. A join's far side keeps its gate and has no match (every write
  to its gated columns reaches every follower).
- **`usesOf(p)`** — the collection tuple's own uses (`plan.usesOf` of the
  params the tuple names: the point codec's `encode(ids)`, or the scope,
  checked by the set's own server gate — a value the column's text cannot
  equal throws), re-keyed, the base narrowed to the tuple's ids / scope;
  none for an empty id set. A tuple of the other form throws (the runtime
  reports it and FULLs that follower tuple).
- **An `{ ids }` follow is held to the identity's text** as a `{ where }`
  one is to the scope's (`canonical-text.ts`, shared with `scopeOf`): the
  base route matches an id against the feed's `col::text`, so an id that
  is not the column's canonical text (an upper-case uuid, `"007"`) throws
  in `paramsOf` — the read and the routing alike — and an identity whose
  text has no one spelling (a timestamp, a float) is refused by
  `followRead` when the follow is declared. Every shipping target is
  text-keyed.

**`compiledValueReach(reads | undefined, label, follows)`** folds the follow
reads beside `reads.tables` / `reads.lookups`: `reads` is optional with a
follow; a table read through a follow AND whole or through a lookup is
refused (the other route would reach every write the follow's gate and
match skip); an unminted follow read and a name twice are refused; a value
declaring neither is refused. `mintReachPlan` refuses an unfed / relation /
notified / tagged read of a followed table; the runtime a view read whole
over one (`indexRelationReads`). Pinned by `server/internal/follow.test.ts`;
the real-feed oracle is network/live's `serve-value-follows-oracle.test.ts`.

## Joins: provenance-driven read-sets (`core/internal/joins.ts`, `server/internal/joins.ts`)

Joins are data (`JoinSpec`, in `core/`, type-only so the browser bundle pulls
no drizzle):

| Kind | Join | Route |
|---|---|---|
| `extension` — 1:1 side table (`ext.join(alias)`) | LEFT, `key = parentKey` | `alias` on the side pk: side I/U/D is a host U |
| `extension` with `on` — a RELATED entity's side table | LEFT, `key = on` | `reverse` on the side pk through `on`'s chain (A10) |
| `lookup` — N:1 on `pk`, `on` a base or EARLIER join column | INNER if `required`, else LEFT | `reverse` on `pk`, or `alias` when `on` is the host identity |
| `keyed-side` — composite-keyed side (`hostKey` + fixed `selectors`) | LEFT on host identity | `alias` on `hostKey`, `rows` = selectors |

- **Every join renders against its alias**, so the relation of each column is
  read off the SQL (`compileJoins`: `columnsIn` / `relationsIn`).
  - A relation neither base nor declared join throws ("declare it as a join").
  - `sql.raw` text is invisible to the walk — build routed SQL from drizzle
    columns (the one exception: *Aggregates*).
- **A tuple reads a join** iff its SQL references it (projected, required, in
  `where` / order, or hung off one that is). Every shape of that tuple joins
  exactly those, and `usesOf(params)` names exactly them (provenance property
  test: `network/live`'s `serve-collection-joins.test.ts`).
- **Role.**
  - `membership` when required or read by `where` / order (directly or via a
    later chained join); else `value`.
  - A membership use carries **`moves`** — the columns whose change can move
    the tuple; a `U` touching none is a value change.
  - The runtime drops a value-role write to a row a quiescent tuple does not
    hold.
  - A grouping joins only what its grouped column / `where` read (+ required
    lookups), all `membership`.
- **A4 (module eval):**
  - a `ColumnRef.col` belongs to the relation it names;
  - a lookup's `on` names an earlier relation and its `pk` is primary / unique;
  - a keyed side's `hostKey` + selectors cover its pk;
  - an extension hangs off the base, keyed by its own pk with the resource
    identity as parent key;
  - aliases are unique, never `base` or the base table name;
  - a join needs explicit `select`;
  - a joined sortable column is projected and in the signature (matched by
    relation AND name).

  A LEFT-joined column orders as nullable.
- **T2 (tsc):** a column override returns a ref its `j` offers
  (`j.<relation>.<column>`, a `TypedColumnRef`) — an undeclared relation,
  another table's or a server-only column is a type error.
  - `j` offers WIRE columns (an entity's / extension join's `wireColumns`).
  - A lookup's `on` is a plain `ColumnRef`, checked by A4.
- **Select-all** (no `select`) projects every column, so its route columns are
  all of them.
- **A missing extension row reads its defaults**: an extension column with a
  literal `.default(v)` renders `COALESCE("alias"."col", v)` wherever read
  (projection, filter, order, cut) and is never NULL (`JoinPlan.canBeNull`).
  - Join CONDITIONS and a static predicate's `j` (`JoinPlan.columns()`) use the
    raw column.
  - A computed default (`defaultNow()`) is never coalesced.
  - An exposing extension's `absent` overrides per column (`null` = raw
    column).
- **Presence fields** (`ExtensionJoin.presence`):
  `presenceExpr(join, id, keyRef)` (server barrel) is an `ExprField` over the
  key — `(<alias>.<key> IS NOT NULL)` or a `CASE` text — never NULL.
- `server/testing`'s `recordingQueryDb` renders every query (builder and
  `execute`) through drizzle's real dialect.

### Expression fields — `ExprField` (`core/internal/expr.ts`)

```ts
(j) => expr(sql`upper(${j.artist.name})`, { decoder, sqlType });
```

Options: `decoder`, `sqlType`, and optional `notNull`, `serverOnly`, `wire`.
It binds where a column override does (`expr` is on the core barrel).

- Each `j.<relation>.<column>` is also a SQL fragment (the defaulted wire
  column). A server-only base column is named by the table's column and listed
  in `serverOnly`.
- Rendered once per compile (`JoinPlan.renderExpr`) and registered in the
  module-level `readExpressions` (kinds `column` / `expr` / `aggregate`).
  - `columnOf` / `relationOf` THROW on an expression — use `nameOf` /
    `memberOf` / `relationKey` / `relationsIn`.
  - `isComputed` is what to branch on.
- Provenance is read off the SQL (`columnsIn`). These throw:
  - an undeclared relation (no correlated subquery over an undeclared table);
  - a column neither wire nor `serverOnly`;
  - an expression that is exactly one column (use a column override);
  - an `sqlType` outside `SQL_TYPE_RE`.
- Unforgeable: an unexported brand only `expr` sets (`isExprField` reads it).
- `V` is the decoder's result, `| null` unless `notNull: true` (or the `wire`
  codec's output). Never the id.

### Aggregates — provenance declared (`JoinPlan.renderAggregate`)

A grouped value read off a CTE / rollup by name has no column object, so
`renderAggregate` declares its provenance — `columnsIn` descends into `reads`
instead of the SQL:

```ts
renderAggregate(sql, { name, relation, reads, nullable, sqlType, decoder });
```

- `canBeNull` = `nullable`, or true behind a LEFT join.
- Rendered once per plan per (`relation`, `name`): a repeat call returns the
  SAME object; a disagreeing repeat is refused.
- Refused at compile:
  - `reads` resolving to no relation column (silent staleness);
  - an undeclared `relation`;
  - a bad `sqlType`.

### `all`-only join kinds — `AllJoinSpec` (`core/internal/all-joins.ts`)

| Kind | Declared by | Reads |
|---|---|---|
| `rollup` | `{ kind: "rollup", alias, rollup, on }` | a `derived-tables` rollup, LEFT on its key (`on` a base or earlier join column); the table is `rollup.handle`; routed through its sources (*Rollup routes*) |
| `children` | `childrenJoin({ alias, table, fk, rollups?, where?, aggregates })` | child rows naming the host pk by `fk`, filtered, with nested rollups (`on` a column of `table`) |
| `closure` | `closureJoin({ alias, edges, child, parent, nodes, ancestorJoins?, aggregates })` | the host's transitive ancestors over `edges` (cycles terminate); `nodes` is the base table; `ancestorJoins` (rollups / children) hang off each ancestor |

- **Only aggregates cross to the row**, exposed as `AggregateRef`s under
  `j.<alias>`; a raw child column is a tsc error. The two aggregates:
  - `aggregate(sql, { decoder, sqlType, notNull?, ifNone? })` — A33: a
    `notNull` aggregate must state `ifNone`;
  - `jsonAgg(columns, { orderBy })` — never NULL (`[]`), its elements are JSON
    forms (a `Date` is ISO text), its order non-empty.

  Both are branded (`isAggregate`) with a FORM phantom (`decoded` / `json`).
- A rollup's columns are `OuterColumnRef`s: NOT NULL columns still read NULL
  for a host with no rollup row.
- Internal relation names: `<a>`, `<a>__<r>` (rollup under children),
  `<a>__anc` (closure ancestor), `<a>__anc__<r>`.
- **`AllJoinSpec` is the `all` compiler's alone** (C9 / A24):
  - window, grouping, union arm and column override keep `JoinSpec` (tsc);
  - `compileJoins` refuses one a cast let through (a grouping would route the
    rollup table, which A1 refuses at boot);
  - `compileAllJoins` joins window kinds + top-level rollups row-wise;
  - children / closure are grouped CTEs (`server/internal/grouped.ts`), passed
    as `grouped`, never row-wise.

### Rollup routes — a rollup is routed through its SOURCES

The rollup table has no change-feed trigger (A1), so `joinRoutes` emits one
route per `rollup.sources`, id `<alias>[<source table>]`. Its `columns` =
source pk ∪ `carry` ∪ `reads` (what its maintain function diffs).

| Case | Map |
|---|---|
| `on` = host pk, no `via` | `alias` on `carry` (none when `carry` is the source's single pk) |
| otherwise | `reverse`: `on = ANY($keys)`, keys = carried values or, with `via`, `SELECT key FROM via WHERE match = ANY(...)` |
| hop / chain join over the changed source table itself | `full`, `pre-image needed: …` (A10) |

- **A35** (`assertHopsCovered`): the hop is read after commit, so a write
  re-keying the hop row resolves only new keys. The `via` table must therefore
  also be a source of the same rollup:
  - whose `carry` is the hop's `key`;
  - whose pk ∪ `carry` ∪ `reads` holds the hop's `match`;
  - whose `ops` include `update` and `delete`.

  Refused at compile, naming the gap.
- `within` is cast `{ invalid: "absent" }`.
- A tuple reading the rollup names every source route; a membership use
  carries no `moves` (the SQL reads rollup columns, not source ones).
- `JoinPlan.derivedReads` (each rollup once, with sources) → `mintRoutePlan`,
  which refuses one a route names (A1) or whose source no route names (A22);
  the drift guard accepts the rollup table.
- Tests: `rollup-routes.test.ts`, `rollup-routes-layout.test.ts`.

### The `all` compiler — `compileAllCollection` (`server/internal/compile-alias.ts`, `grouped.ts`)

`liveCollection(key, { all })` is ONE param-less keyed resource holding every
row in a declared order, plus `:rows`.

```ts
// → { all, rows, keyField, definition }
compileAllCollection({ all, rows }, spec);
```

- Shipping caller: `serveCollection`'s `all` arm.
- Descriptor type: `AllQueryResourceContract<Row>` (`core/`):
  - `all: { orderBy }`;
  - bound `AllBound` = `{ max }` | `{ unbounded }`;
  - `queryPk`.
- A capped set's full / orderIds shapes end `LIMIT max + 1` and a load over
  `max` throws; `:rows` enforces `point.maxIds`.

Details:

- **Spec.**
  - `from` (single-column pk), `joins` (`AllJoinSpec`).
  - `select(bind)` and optional static `where(bind)` over `bind` (`j`,
    `render`, `aggregate`, `expr` — every read through THIS plan).
  - `wire: { encodeRow, ids }` (`ids` non-empty: `encodeRow` is code the
    definition cannot read), `readField`, `debounceMs`.
  - Order = `all.orderBy`, pk tiebreaker.
- **Shapes** (raw SQL via `QueryDb.execute` + `decodedRow`):
  - **Full** — `WITH [RECURSIVE] <ctes> SELECT … LEFT JOIN <cte> ON __k = pk …
    ORDER BY orderBy, pk`.
    - Children = one `GROUP BY fk` CTE `__c_<a>`.
    - Closure = recursive pairs CTE `__x_<a>` (`UNION`) + per-node aggregate
      CTE `__g_<a>`.
  - **Scoped** (refill, `:rows`) — same CTEs restricted to `= ANY($ids)`, no
    order.
    - A32 planner fences are in the text (`CROSS JOIN LATERAL (… OFFSET 0)`,
      `ANY(ARRAY(SELECT DISTINCT …))`).
    - Refill casts ids `"throws"`, `:rows` `"absent"`.
  - **orderIds** — ids only, `orderOf` of the `scopedMembership`, run only when
    a row enters or an order field moves.
- **Scope — `all.by`** (`all: { by: ["pageId"] }`): one tuple per scope.
  - `AllQueryResourceContract<Row, B>`, params exactly the `by` fields,
    `preload` `never`.
  - One loop (`scopeOf`) emits the `eq(col, param)` (full / scoped / orderIds,
    never `:rows`), the base identity route's `match` columns, and each tuple's
    base-use `match` + `moves` — so they cannot disagree.
  - Refused: a field not projected, not a DIRECT base column, or not text /
    varchar / uuid / smallint / integer / bigint (the feed's `col::text` must
    equal the param).
  - The `all` half gets a server `validateParams` enforcing canonical text.
  - Only a scoped set's definition / routes carry `by` / `match`.
  - Tests: `compile-alias-scope.test.ts`, network/live's
    `serve-collection-all-scoped-oracle.test.ts`.
- **Aggregates.**
  - `jsonAgg` renders `json_agg(json_build_object(…) ORDER BY … NULLS LAST,
    <child pk>)`, timestamptz via `to_char(… AT TIME ZONE 'UTC', …)` (session-TZ
    independent).
  - The row reads `COALESCE(<cte>."<name>", <ifNone>)`, registered via
    `renderAggregate` with its provenance (C7).
- **Grouped relations** are registered as GROUPED in the plan: resolved for
  provenance, never joined row-wise, never outer, readable only inside an
  aggregate.
- **Routes** (grouped ones are `value`: an aggregate never moves membership):

  | Route | Table | Map |
  |---|---|---|
  | `<a>` (children) | child | `alias` on `fk` |
  | `<a>__<r>[<src>]` | rollup source | `reverse` → child rows → `fk` |
  | `<a>` (closure) | edges | `alias` on `child` |
  | `<a>:closure`, `<a>__anc:closure`, `<a>__anc__…:closure` | edges / base / child / rollup source | `reverse` → the **dependents probe** |

  The dependents probe walks DOWN the edges (`WITH RECURSIVE __d_<a>`,
  `LIMIT cap + 1`).
  - `within` goes into SQL up to `WITHIN_IN_SQL_MAX` (256) ids; past that it is
    filtered in JS.
  - A probe that would read the changed table after commit is `full`,
    `pre-image needed` (A10).
- **Asserted at module eval:**
  - A29 — order fields read base columns; `where` reads no grouped relation;
  - A35;
  - A37 — children `fk` / closure `child` / `parent` lead an index or the pk;
  - A38 — CTE names match `CTE_NAME_RE`;
  - A39 — `jsonAgg` column types, no `withWire`;
  - C7 — every field reads a relation column; grouped columns only inside
    aggregates;
  - no unread grouped join / nested rollup / ancestor join;
  - key field = base pk, closure `nodes` = base table;
  - every quoted relation is a route table or derived read (A1 / A8).
- **Definition** (A18 / A40, `server/internal/fingerprint.ts`): sha256 over the
  rendered SQL + params of every shape, decoder ids, SQL types, nullability,
  `describeZod(row)`, `wire.ids`, rollup DDL hashes, order and key field.
  - Decoder ids come from sql-projection's `decoderOrigin`; **any other
    function decoder is refused at bind** (its body could change without moving
    the definition).
  - `describeZod` is zod-introspect's `describeSchema`, read off the normalised
    `SchemaNode` (never zod's def layout; a zod 3 schema throws). It is
    fail-closed: a function-dependent part (transform, codec, rewrite check,
    catch, non-literal default) is an `{ $opaque }` marker — refused in a `parsed` decoder, folded in (not refused) for a
    column or row schema (e.g. `tolerantEnum`).
  - A non-literal param (`Date`) is refused.
  - `:rows` has no L2 definition (never persisted).
- **Tests:** `compile-alias.test.ts`, `compile-alias-closure.test.ts` (A23
  random-statement oracle), tasks-core's `all-parity.test.ts`, the compile-SQL
  golden's `all` group.

### Raw SQL — `server/internal/raw-sql.ts`, `QueryDb.execute`

Shared by the union and `all` compilers: `canonicalSqlType`, `nullOf`,
`decoderOfRead`, `allOf`, `fromSql`, `anyOf(col, ids, { invalid })` /
`anyOfExpr`.

- `anyOf` is ONE array param cast to the column type. The caller states the
  invalid-id policy:
  - `"throws"` for database-vouched ids (a probe's changed keys);
  - `"absent"` for untrusted text (via `pg_input_is_valid`).
- Raw reads go through `QueryDb.execute` (drizzle's `unionAll` cannot render
  expression order keys; recursive CTEs) and sql-projection's
  `executeRows(db, { query, row: decodedRow(…), label })`.

**Known gap:** a lookup reverse probe's `within` still passes `"throws"`
(`joins.ts`), though for a point reader it is the client's `:rows` id set — a
key a uuid pk cannot hold fails the probe and its readers recompute FULL.
`"absent"` is right; switching changes the union snapshot's uuid-arm SQL, so it
is its own step.

### Reverse routes — a lookup's changes, resolved to hosts (P4)

A change to a looked-up row names the ROW, not its hosts, so its route is
`reverse` on the lookup's `pk`. `resolve(changed, within, cap)` (`reverseMap`)
runs once per flush:

```sql
SELECT DISTINCT <host pk> FROM <base> [joins up to `on`'s relation]
 WHERE <on> = ANY($changed::<type>[]) [AND <host pk> = ANY($within::<type>[])]
 LIMIT cap + 1  -- more than cap ⇒ "over-cap" (readers go FULL)
```

- **A10 — FK-direction rule.** Resolved after commit, the probe is complete
  only when it reads HOST-side rows (the base, or earlier joins over OTHER
  tables). A hop over the CHANGED table would read its post-image: that route
  is `full`, reason `pre-image needed: …`.
- Membership readers resolve unbounded; value readers within their members.
- Host ids are the pk's stored values.
  - Single-compile routes are `RawRoute`s (an `identity` / `alias` map cannot
    carry `encode` — T10, tsc).
  - A union re-keys via `compiledUnionRoutePlan`.
- The probe does NOT apply the collection's predicates (a predicate reading the
  looked-up row must not filter the post-image); out-of-scope hosts count
  toward the cap.
- Grouping routes stay `full`; a keyed side's `full` route carries its
  selectors as `rows`.

### Union collections — `compileUnionCollection` (`internal/compile-union-window.ts`)

Behind `serveUnionCollection`: N arms (a table each, id = its single-column pk)
in one `kind:raw` key space.

- `armKeyCodec(kind)` in core — `decode` strips the prefix once, `null` for
  another arm.
- `armKeySql` in server, tested byte-equal against Postgres.

Returns window, `:rows`, `:groups`. The filter language and wire shape are the
caller's.

- **Routed per arm** (`routedReads`), re-keyed by
  `compiledUnionRoutePlan(arms, usesOf)`:
  - route ids are prefixed (`<kind>`, `<kind>.<id>`) and unique (A14);
  - `identity` / `alias` maps gain the arm's `encode`;
  - `reverse` decodes `within` to the arm's raw ids (none left ⇒ no probe) and
    encodes the answer;
  - `full` is unchanged;
  - `usesOf` answers only surviving arms.
- **Rendered positionally**: each arm projects `__kind`, `__key`, `__c<i>` (or
  `NULL::<sqlType>`), `UNION ALL`, re-ordered / re-limited outside, decoded per
  arm on `__kind`.
  - Point: an unknown kind is absent.
  - Groups: per-arm `GROUP BY 1`, summed.
- **Static nullability**: nullable if ANY arm reads NULL — computed at bind,
  never per surviving arm.
- **Total order**: tuple keys then row key; constant keys are dropped from an
  arm's ORDER BY but kept in cuts.
- **A14 at bind**: kinds unique and `KIND_RE`; every arm's read produces the
  column's `sqlType` (`canonicalSqlType`); key field / discriminator never
  bound.

### Join families — members joined per tuple (P3)

A `JoinFamily` (`core/`) is a composite-keyed side table whose MEMBERS are data
(a DataView's custom columns): `hostKey` + `selectors` + `member` column +
`value`. Window specs only: `families: { joins, valuesKey }`.

- A member is a keyed-side join (`familyMember(family, m)`).
  - Alias `familyMemberAlias(id, m)` — injective escaping, hashed past 63
    bytes; a collision fails the compile.
  - Render a member through `JoinPlan.readMember(familyId, m, read?)`; a
    module-level registry lets every plan over the same family find it.
- A tuple joins exactly the members its `where` / order names (`membership`).
  ONE route per family (`familyRoute`: `alias` on `hostKey`, `rows` =
  selectors, `match` on the member column).
- An ordered-by member is projected (`__family_<i>`) into `row[valuesKey]`;
  `whereReads` does not apply to members.
- Order memos key on the key's RENDERING, so a retyped member's ORDER BY / cuts
  follow on the next load.
- `recomputeOn` (spec) FULLs every tuple and drops read-set memos when the
  family's member set changes.

## Bounded membership: `windowQueryResource` (window / point)

The descriptor kinds it takes are minted by `liveCollection` alone; this plugin
keeps only the contract TYPES (`WindowQueryResourceContract` /
`PointQueryResourceContract`, `core/`). A subscription's params name a bounded
selector: a change costs O(changed) + O(window), never O(collection).

Spec types:

- `WindowQueryResourceSpec` — `window`, `orderBy`, `rowKey` required;
  window-only `signatureColumns` / `families` / `recomputeOn` / `readField`.
- `PointQueryResourceSpec` — `point`; every window-only field `never` (tsc).

What `serveCollection` derives (never hand-written):

```ts
windowQueryResource(c.window, {
  from: table,
  select,
  where: (params) => and(base, filterSql(decoded.where)),
  // { col, dir, nullable }[], per tuple
  orderBy: (params) => decoded.orderBy,
  signatureColumns, // every sortable column
  window: {}, // maxLimit rides the descriptor's codec
  rowKey: { cutsOf, familyOf, keyField: "$key", maxKeyBytes },
});
windowQueryResource(c.rows, {
  from: table,
  select,
  where: base,
  point: { by: table.id },
});
```

- **window** — FULL `where → ORDER BY → LIMIT` (limit from params, clamped to
  `maxLimit`), scoped refill, `windowIdsOf` (same where / order / limit, ids
  only, so membership cannot drift) and `orderSignatureOf`, as
  `membership: { kind: "window", windowIdsOf, orderSignatureOf, limitOf,
  familyOf }`.
  - `limitOf` + `familyOf` let the runtime seed a tuple from rows other tuples
    hold.
  - The compiler appends the pk tiebreaker and explicit `NULLS LAST`.
- **point** — a scoped read over `ctx?.affectedIds ?? point.decode(params)`
  (empty ⇒ `[]`, no query), `membership: { kind: "point", idsOf }`.
  - `point.by` **is** the identity pk (routing intersects changed identity ids
    with each set; a different `by` throws).
- **Function `orderBy`** (`(params) => WindowOrderKey[]`) **requires
  `signatureColumns`** (every column it may sort by, projected).
  - The signature is per tuple — only the columns that tuple orders by — so an
    UPDATE to a column re-derives only the windows sorting by it.
  - A resolved column outside `signatureColumns` throws.
- **Order-column updates are handled**: a moved signature re-derives the window
  via `windowIdsOf` (one O(window) ids query; content-only updates stay
  in-place) — prefer stable order columns for very hot rows. A `where`-flip is
  a detected exit / entry.
- **Key-range pages (`rowKey`)**: each tuple may be one page — exclusive
  `after`, inclusive `until` row keys.
  - ONE key list per order (declared keys, then pk) feeds ORDER BY, cuts and
    row keys.
  - A row key is the canonical JSON of each key's `col::text`
    (`__row_key_<i>`, never in `windowIdsOf`; `null` over `maxKeyBytes`).
  - Cuts are `primitives/keyset`'s `seekPredicate` / `atOrBeforePredicate`,
    operands cast to the column type. Cuts read only order columns, so routes
    and roles are unchanged.
  - Seams: `window.limitOf`, `window.validateParams` (replaces the descriptor's
    gate on the server), `readField` (where `encodeRow` moved a projected
    field).
- **Deferred** (`deferredWindowQueryResource`): registers now, `specOf()`
  compiles at `bindDeferredResources` — for specs depending on contributions.
- **Spec limits.**
  - No `limit` / `recompute` / `scopedMembership` spec fields.
  - Bounded resources are never L2-persisted; a preloaded window loads at the
    descriptor's `defaultParams`.
  - `defaultLimit` lives ONLY on the descriptor; the spec carries at most
    `maxLimit` (both given ⇒ equal; neither ⇒ throw).
  - Every misuse throws at module eval — a bad spec is a boot crash.
- **Arms** (`internal/arm-plan.ts`, `internal/compile-window.ts`):
  - `planArm` plans one relation set as an `ArmPlan` (`window` | `point`);
  - `assembleWindow` / `assemblePoint` (exactly one arm) add signature, limit,
    loaders, membership;
  - union and `all` reuse only the routed half (`routedReads`);
  - grouping: `planGroupArm` + `compileArmGroups`.

- **Handoff definition (`internal/point-definition.ts`).** A point compile's
  plan carries `handoffDefinition`, a memoized thunk (rendering goes through
  the database driver, which a module-eval compile must not touch): the
  sha256 of the point SQL, each field's decoder id, the row schema, `maxIds`
  and the spec's `encodeRowId` — the epoch handoff inherits a `:rows` tuple
  across a restart only under an equal one. Fail-closed to `null` (never
  inherited) for a function `where`, an `encodeRow` with no `encodeRowId`, an
  opaque decoder or schema part, a non-literal param. `serveCollection` names
  its `$columns` fold as an `encodeRowId`; a wire codec has none. Bump
  `POINT_DEFINITION_VERSION` when the point compile changes what a load
  produces with none of those moving. Pinned by `point-definition.test.ts`.

**Golden fixtures** (`network/live/server/internal/compile-sql-golden.test.ts`
and `compile-union-golden.test.ts`) pin every shape's SQL, params, routes,
`usesOf`, signatures and folded rows byte for byte (incl. the `all` group).

A deliberate SQL change regenerates them and reviews the diff. **Run the
generators on the code BEFORE a refactor** (afterwards they reproduce what the
refactor broke):

```sh
./equin run plugins/network/plugins/live/server/testing/gen-compile-golden.ts
./equin run plugins/network/plugins/live/server/testing/gen-compile-union-golden.ts
```

## The `db` seam

`spec.db` defaults to the real `db` (top-level static import; inline `import()`
is forbidden), coerced to a minimal `QueryDb`; tests inject a fake.

Safe because `@plugins/database/server` builds its pool lazily on the first
query.

## Boundaries

- `core/` — web-safe, **no runtime drizzle** (type-only imports):
  - contracts (`core/internal/contracts.ts`);
  - the join vocabulary (`JoinSpec`, `ColumnRef`, `JoinRefs`, `JoinRef`,
    `JoinColumns`, `BASE_RELATION`);
  - `expr`;
  - the `all`-only kinds (`AllJoinSpec`, `childrenJoin`, `closureJoin`,
    `aggregate`, `jsonAgg`, `OuterColumnRef`);
  - `armKeyCodec`, `JoinFamily`.
- `server/` — the compilers, `compileJoins` / `joinRefs`, spec types; owns all
  drizzle usage and the routes / keyField derivation.
- `server/testing` — `compileWindowQuery` (compile without registering),
  `compileAllCollection`, `recordingQueryDb`.
- `core/testing` — `familyMemberAlias` (shipping code uses `familyMember`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Declarative SQL query→resource compiler: one drizzle-based declaration derives the loader, scoped loader, scope policy (the routes the change router serves it by, for a bounded window / point set, a whole ordered set declared `all` — compileAllCollection, grouped CTEs over rollup / children / closure joins — and a grouping), and client keyOf for live-state resources.
- Server:
  - Uses:
    - `database.db`
    - `database.quotedRelationsIn`
    - `database.readTag`
    - `database/sql-column.columnSchema`
    - `database/sql-column.columnWireCodec`
    - `database/sql-projection.decodedRow`
    - `database/sql-projection.decoderOrigin`
    - `database/sql-projection.nullable`
    - `database/sql-projection.SqlDecoderLike`
    - `primitives/keyset.atOrBeforePredicate`
    - `primitives/keyset.orderByClauses`
    - `primitives/keyset.seekPredicate`
    - `primitives/keyset.SortKey`
  - Exports (types):
    - `AllBind`
    - `AllCollectionContracts`
    - `AllCollectionSpec`
    - `CompiledAllCollection`
    - `CompiledCount`
    - `CompiledGroups`
    - `CompiledLookup`
    - `CompiledOffFeedQuery`
    - `CompiledUnion`
    - `EntitySource`
    - `FollowablePlan`
    - `FollowablePoint`
    - `FollowRead`
    - `FollowTuple`
    - `LookupRead`
    - `LookupResult`
    - `LookupSpec`
    - `PointQueryResourceSpec`
    - `QueryDb`
    - `ReadColumn`
    - `RoutedSource`
    - `SelectMap`
    - `UnionArmSpec`
    - `UnionCollectionSpec`
    - `UnionColumn`
    - `UnionCuts`
    - `UnionGroupsQuery`
    - `UnionOrderKey`
    - `ValueReads`
    - `WindowOrderKey`
    - `WindowQueryResourceSpec`
  - Exports (values):
    - `compileAllCollection`
    - `compileCountQuery`
    - `compiledValueReach`
    - `compileGroupsQuery`
    - `compileJoins`
    - `compileLookup`
    - `compileOffFeedQuery`
    - `compileUnionCollection`
    - `deferredPointQueryResource`
    - `deferredWindowQueryResource`
    - `followRead`
    - `joinRefs`
    - `offFeedReach`
    - `offFeedTablesReach`
    - `pointQueryResource`
    - `presenceExpr`
    - `windowQueryResource`
- Cross-plugin:
  - Imported by:
    - `network/live`
    - `runs`
    - `tasks/tasks-core`
- Exemptions:
  - Exempts itself from:
    - `resource-runtime:compiled-routes` — `server/internal/routes.ts` (sanctioned)
    - `live/no-legacy-resource-spelling` — `.` (sanctioned)
- Core:
  - Exports (types):
    - `Aggregate`
    - `AggregateOrder`
    - `AggregateRef`
    - `AggregateRefsOf`
    - `AggregateSet`
    - `AggregateShape`
    - `AggregateValue`
    - `AllBound`
    - `AllJoinRefs`
    - `AllJoinRefsOf`
    - `AllJoinSpec`
    - `AllQueryParams`
    - `AllQueryResourceContract`
    - `AncestorJoin`
    - `AncestorRelation`
    - `ArmKeyCodec`
    - `ChildRefs`
    - `ChildrenJoin`
    - `ClosureJoin`
    - `ClosureRefs`
    - `ColumnRef`
    - `ColumnRefsOf`
    - `ExprDecoder`
    - `ExprField`
    - `ExtensionJoin`
    - `ExtensionPresence`
    - `JoinColumns`
    - `JoinFamily`
    - `JoinRef`
    - `JoinRefs`
    - `JoinSpec`
    - `JoinWireColumns`
    - `JsonAggElement`
    - `KeyedSideJoin`
    - `LookupJoin`
    - `NestedRollupJoin`
    - `OuterColumnRef`
    - `OuterColumnRefsOf`
    - `PointQueryResourceContract`
    - `RollupJoin`
    - `TypedColumnRef`
    - `WindowQueryResourceContract`
  - Exports (values):
    - `aggregate`
    - `armKeyCodec`
    - `BASE_RELATION`
    - `childrenJoin`
    - `closureJoin`
    - `expr`
    - `familyMember`
    - `isAggregate`
    - `isExprField`
    - `jsonAgg`
    - `jsonAggValue`
    - `KIND_RE`
    - `SQL_TYPE_RE`
- Test helpers:
  - Server: `@plugins/infra/plugins/query-resource/server/testing`
    - `compileAllCollection` — Compile a collection declared `all` (see the header).
    - `compileWindowQuery` — Turn a bounded spec + its shared contract into the two-arg `defineResource` server half.
    - `recordingQueryDb` — A `QueryDb` that renders every query through drizzle's real `PgDialect` — the SQL a compiler would send — records it, and answers with `script`'s rows instead of running it.
    - Types: `RecordedQuery`
  - Core: `@plugins/infra/plugins/query-resource/core/testing`
    - `familyMemberAlias` — A member's join alias: the family id, then the member id with every character outside `[A-Za-z0-9]` spelled `_<hex>_` — injective, so two members can never share an alias (`cc-1` → `custom__cc_2d_1`).

<!-- AUTOGENERATED:END -->
