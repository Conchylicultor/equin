# query-resource

The SQL compiler under `network/live`'s live-resource API. **It is not a way to
declare a resource.** A new collection is a `liveCollection` served by
`serveCollection`, and a new value is a `liveValue` served by `serveValue` —
see `plugins/network/plugins/live/CLAUDE.md`. What lives here is what those
compile to:

- **`windowQueryResource`** — the bounded (window / point) compiler.
  `serveCollection` runs every collection's window and `:rows` sibling through
  it (see *Bounded membership* below).
- **`compileGroupsQuery`** — the grouping compiler: a collection's `:groups`
  sibling (see *Routes* below).
- **`compileCountQuery`** — the count compiler: a collection's `:count`
  sibling (declared `count: true`). Planned by the grouping planner
  (`planGroupArm`, a constant in place of the grouped column — the same `full`
  routes, the same per-tuple joins) and rendered without the GROUP BY, so it
  is always one row.
- **`compileAllCollection`** — the whole-ordered-set compiler: a collection
  declared `all` and its `:rows` sibling, set-at-a-time with grouped CTEs (see
  *The `all` compiler* below).

`query-resource` never imports `network/live` — the dependency runs the other
way, test files included.

Every keyed compiler takes ONE constrained drizzle declaration and derives the
FULL loader, the Layer-2 scoped loader, the scope policy (the ROUTES its SQL
reads plus a membership — see *Routes*; never hand-authored, so it cannot drift
from what the loader reads), and the client keyField — producing exactly the
object the two-arg keyed `defineResource(descriptor, KeyedServerResourceOptions
& ScopePolicy)` already accepts (a keyed contract takes no `mode`). The grouping
compiler's `:groups` value is the one non-keyed output (a push value with a
`reach` plan).

## Routes: the bounded and grouping compilers emit what their SQL reads

`windowQueryResource`, `compileGroupsQuery`, `compileAllCollection` and the
union compiler are **routed**
(`research/2026-09-29-global-scoped-change-routing.md`, P1): each emits, from
the same declaration it renders the SQL from, the `RoutePlan` the runtime's
`routeTableChange` serves it by (`internal/routes.ts`):

- **window / point** — `routes`: an `identity` route (`base`) on the base table,
  read by every tuple in the `membership` role, plus one route per declared join
  (see *Joins*). When the identity pk IS the table's primary key the change
  feed's ids are the host ids as they stand; otherwise the route reads the pk
  column off the change's key layout (`tableLayoutRequirements` carries every
  map `column`, so the routed trigger sends it) — scoped as well.
- **`all`** — `routes` as for a window (identity + one per row-wise join, one
  per rollup SOURCE, and the grouped joins' routes — *The `all` compiler*),
  under a `scopedMembership` alias policy (`orderOf` = orderIds,
  `orderSignatureOf` read off the wire row); its `:rows` sibling is a point
  membership over the same routes.
- **grouping** — `reach` (the non-keyed arm): one `full` route per relation (the
  base table, and each join). A write to a table a grouping reads recomputes it;
  a write to any other table reaches none.
- A route's `columns` (what the `unchanged` gate skips on, P4) are exactly the columns of
  its table the compiled SQL may reference over every tuple — projection,
  identity, join conditions, a static `where`, the declared per-params `where`
  columns (`whereReads` on the window spec, `reads` on the grouping spec) and
  the order signature. A function `where` with no declared universe makes them
  every column of every relation (the safe over-approximation); with one, each
  tuple's `where` is checked against it and a column outside throws.
- **A routed compile reads a base table, never a view** (A1): a change arrives
  under its base tables' names, which no route of a view can state. The spec's
  `from` is typed `RoutedSource` (`PgTable | EntitySource`), and an untyped view
  throws at module eval. The change-feed's boot assertion checks every route table
  is triggered (`change-feed/server/internal/route-coverage.ts`).
- **No cascade edges**: a routed entry is never a cascade upstream (A5), and
  routes the tables it reads itself (the runtime refuses `dependsOn` beside
  `routes` / `reach`).
- **`internal/routes.ts` is the one production minter.** A plan is made by
  `mintRoutePlan` / `mintReachPlan` (resource-runtime), never written as a literal
  (a type brand), and the `resource-runtime:compiled-routes` check allows the
  minters only there and in test code: a route's `columns` gate which updates reach
  the resource, so only the code that renders the SQL may state them.
- The runtime's drift guard (A8) checks each loader run's captured tables against
  the route tables, so a compiler that forgets a table fails its tests loudly —
  plus the plan's `derivedReads` (A22): a rollup the SQL reads, which no route
  may name (A1) and whose every source the plan routes (see *Rollup routes*).
- **One join, its routes (`joinRoutes`), its route ids (`JoinPlan.routeIdsOf`).**
  A window join is one route, id = its alias; a rollup is one route per SOURCE.
  `routedReads`' `tuple()` fans a join's use out over every id `routeIdsOf`
  lists, so the runtime's per-route read-set stays exact. A compile with no
  rollup emits exactly the routes and uses it always did (the compile-SQL golden
  and the union snapshot are byte-identical across the generalization).

## Joins: provenance-driven read-sets (`core/internal/joins.ts`, `server/internal/joins.ts`)

A bounded or grouping compile reads its base table plus declared **joins, as
data** (`JoinSpec`, in `core/`, type-only so the browser bundle pulls no
drizzle):

| Kind | Join | Route |
|---|---|---|
| `extension` — a 1:1 side table (`infra/entity-extensions`' `ext.join(alias)`) | LEFT, `key = parentKey` (the host id) | `alias` on the side table's pk: a side I / U / D is a host U |
| `extension` with `on` — a RELATED entity's side table (`ext.join(alias, { on })`, `on` a column of the base or an earlier join naming the parent's id) | LEFT, `key = on` | `reverse` on the side table's pk, probed through `on`'s chain like a lookup (A10 applies) |
| `lookup` — N:1 on `pk`, `on` a column of the base or an EARLIER join (chainable) | INNER when `required`, else LEFT | `reverse` on `pk` (see *Reverse routes*), or `alias` when `on` is the host identity |
| `keyed-side` — a composite-keyed side table (`hostKey` + fixed `selectors` covering its pk) | LEFT, on the host identity (compared as `hostKey`'s type) | `alias` on `hostKey`, `rows` = the selectors — scoped on the routed trigger's key layout |

- **Every join renders against its alias** (`"playback"."last_played_at"`), so
  the relation a column belongs to is read off the SQL itself. `compileJoins`
  (`server/internal/joins.ts`) renders and checks the specs, and walks any SQL
  fragment for the relations it reads (`columnsIn` / `relationsIn`); a relation
  that is neither the base nor a declared join throws ("declare it as a join").
  Raw `sql.raw` text carries no column objects and is invisible to the walk — a
  routed compile's SQL is built from drizzle columns. The one exception is an
  **aggregate** (below).
- **A tuple reads a join** when its SQL references it: projected, a required
  lookup, named by its `where` / order, or hung off by one that is. Every shape
  of that tuple — full, scoped refill, `windowIdsOf`, point, grouping — joins
  exactly those relations, and `usesOf(params)` names exactly them, so the
  loader and the membership authority read one relation set (the provenance
  property test in `network/live`'s `serve-collection-joins.test.ts`).
- **Role.** A join is `membership` for a tuple when it is required (INNER) or its
  `where` / order reads it — directly or through a later join in its chain (the
  chain's ancestors too); otherwise `value` (a LEFT join that is only projected).
  A membership use (the base's included) also carries **`moves`**: the columns of
  its table whose change can move that tuple — its `where` and order columns,
  and the conditions of the joins it reads as membership. A `U` touching none of
  them is a value change for the tuple (`resource-runtime`'s `TupleUse.moves`):
  an event's title edit reaches only the windows holding it, a source's config
  edit resolves within the members.
  The runtime drops a value-role write to a row the tuple does not hold, while
  the tuple is quiescent (`resource-runtime`'s quiescence guard). A grouping
  joins only what its grouped column and `where` read (plus required lookups),
  and every use is `membership`.
- **A4 — checked at module eval:** a `ColumnRef.col` belongs to the relation
  `from` names; a lookup's `on` names an earlier relation, and its `pk` is its
  table's primary key or unique; a keyed side's `hostKey` + selectors cover its
  primary key; an extension hangs off the base table, its key is its own
  primary key and its parent key the resource's identity; aliases are unique and
  never `base` or the base table's name; a join needs an explicit `select`; the
  key field projects the base identity; a joined sortable column is projected and
  in the order signature (matched by relation AND name, so a join's `created_at`
  is never the base's). A column a LEFT join reads is NULL for a host with no
  joined row, so it orders as nullable.
- **T2 — types:** a column override returns one of the refs its `j` offers
  (`JoinRef<JoinRefs<…>>`: `j.<relation>.<column>` is a `TypedColumnRef` naming
  both), so an undeclared relation, another table's column, or a server-only
  column is a tsc error. `j` offers each relation's WIRE columns: the base
  source's (an entity's `wireColumns`), and a join's `wireColumns` when it
  carries them (an extension handle's `join()` does), else its table's columns.
  A lookup's `on` stays a plain `ColumnRef`, checked by A4.
- **A spec with no `select`** (a select-all) projects every column of its
  source, so its route columns are all of them — the exact-columns rule reads
  the projection, never only the declared `select`.
- **A missing extension row reads its defaults** (`ReadColumn`): an EXTENSION
  join's column whose table column declares a literal default (drizzle's
  `.default(value)` — an entity extension's meta `default`) renders as
  `COALESCE("alias"."col", <default>)` wherever the SQL reads it — the
  projection, a filter, an order key, a cut. An extension row that does not
  exist means its declared defaults, so a never-played song has `playCount = 0`
  in SQL. Such a column is never NULL (`JoinPlan.canBeNull`: non-nullable keyset
  keys, exempt from the LEFT-join nullable-field rule); its provenance is still
  the alias column (`columnOf`, a module-level map, so a plan handed another
  plan's rendered columns still reads them). A join CONDITION always compares the
  raw stored key, and a static predicate's `j` (`JoinPlan.columns()`) offers the
  raw columns — a predicate states its own NULL handling. A computed default
  (`defaultNow()`, SQL) is never coalesced. An extension join's `absent`
  (an exposing extension's — `exposure.fields[f].absent`, derived from each
  field's declared default) overrides the default per column: `null` reads
  the raw column, a literal is bound PLAIN (`sql.param(value)`).
- **Presence fields** (`ExtensionJoin.presence`, an exposing extension's
  `exposes.presence`): a field read off the side row's EXISTENCE, no column.
  `presenceExpr(join, id, keyRef)` (server barrel) makes it an `ExprField`
  over the join's key ref — `(<alias>.<key> IS NOT NULL)` (boolean) or
  `(CASE WHEN <alias>.<key> IS NOT NULL THEN $p::text ELSE $a::text END)` —
  never NULL, bound like any expression field (its provenance the key
  column), so it projects, filters, sorts and groups.
- `QueryDb`'s step gains `leftJoin` / `innerJoin`; `server/testing`'s
  `recordingQueryDb` is the fake that renders every query through drizzle's real
  dialect.

### Expression fields — `ExprField` (`core/internal/expr.ts`)

A row field computed by a SQL expression binds where a column override does,
over the same `j`: `(j) => expr(sql\`upper(${j.artist.name})\`, { decoder,
sqlType, notNull?, serverOnly?, wire? })` (network/live's `serveCollection`
`columns`; the union arms and the persisted alias reuse it). `expr` is published
from the core barrel (the run arms' labels and outcomes are the first shipping
declarations).

- **`j`'s refs render.** Each `j.<relation>.<column>` is also a SQL fragment
  (`joinRefs`' `getSQL`): the relation's DEFAULTED wire column (an extension
  column's COALESCE). A server-only base column is named by the table's own
  column and declared in `serverOnly`.
- **Rendered once per compile** (`JoinPlan.renderExpr`): `(<sql>)` with the
  decoder `.mapWith`'d, registered in the module-level `readExpressions` (now a
  union: `column` — a defaulted / member read standing for one column — or
  `expr`), so every plan recognises the SQL object: `canBeNull` is
  `!notNull`, `sqlTypeOf` its `sqlType` (a cut's cast), `nameOf` its field
  name. `columnOf` / `relationOf` THROW on an expression (it reads no one
  column); callers use `nameOf` / `memberOf` / `relationKey` / `relationsIn`.
- **Provenance is read off the SQL** (`columnsIn`): its columns are route
  columns like a projected one's, an order or filter over a lookup it reads makes
  the lookup membership, and a relation that is neither the base nor a declared
  join throws — a correlated subquery over an undeclared table cannot be
  written. A column that is neither a wire column of its relation nor a
  declared `serverOnly` one throws; so does an expression that is exactly one
  column (bind a column override), and an `sqlType` outside `SQL_TYPE_RE`
  (checked by `expr` and again by `renderExpr`).
- **Unforgeable.** An `ExprField` carries an unexported brand only `expr` sets:
  an object literal cannot spell one (tsc), and `isExprField` reads the brand,
  not `kind`.
- **Value type.** `V` is the decoder's result, `| null` unless `notNull: true`,
  or the `wire` codec's output; the binding's return type must be an
  `ExprField<Row[K]>` (tsc), and serveCollection backstops a nullable
  expression on a non-null field at module eval. Never the id.

### Aggregates — provenance declared (`JoinPlan.renderAggregate`)

A grouped value a raw shape reads off a CTE or a rollup by name
(`"__agg"."n"`) carries no column object, so no walk could see what it reads.
`renderAggregate(sql, { name, relation, reads, nullable, sqlType, decoder })`
registers it in `readExpressions` as the third kind, `aggregate`: `columnsIn`
(so every route, gate and `moves` derived from it, and any expression over it)
descends into `reads` — the rendered columns it is computed from — instead of
its SQL. Otherwise it answers like an expression (`nameOf`, `sqlTypeOf`;
`columnOf` / `relationOf` throw; `isComputed` — "reads no one column", true for
an expression too — is what callers branch on). `canBeNull` is its declared
`nullable`, or true when its `relation` sits behind a LEFT join (`outer`): a
host with no joined row reads it NULL, as it would a column; asked of an
aggregate another plan registered over a relation this plan lacks, it throws
naming both. Rendered once per plan per (`relation`, `name`), like
`renderExpr` per field: a repeat call returns the SAME object (memos of
renderings key on identity), and one whose SQL, `reads`, `nullable`,
`sqlType` or `decoder` disagree with the first is refused. Refused at compile: `reads` that
resolve to no relation column (nothing would route a change to it: silent
staleness), a `relation` that is neither the base nor a declared join, a bad
`sqlType`. Its consumer is the `all` compiler's grouped reads (*The `all`
compiler*; `research/2026-10-06-global-scoped-change-routing-p8-v3.md`, C7).

### `all`-only join kinds — `AllJoinSpec` (`core/internal/all-joins.ts`)

A collection declared `all` (network/live) is computed set-at-a-time —
grouped CTEs hash-joined to the base — so beside the window joins it reads
three more kinds, declared in `core/` (P8 v3 §4.1; compiled by
`compileAllCollection` — *The `all` compiler* below):

| Kind | Declared by | Reads |
|---|---|---|
| `rollup` | a literal `{ kind: "rollup", alias, rollup, on }` | a `derived-tables` rollup (`defineRollup`), LEFT on its key; `on` a base column (pk or not) or an earlier join's. The table read is `rollup.handle` (never declared beside it, so one rollup's sources cannot route another's table); routes come from the rollup's sources, never its table (A1) — see *Rollup routes*. |
| `children` | `childrenJoin({ alias, table, fk, rollups?, where?, aggregates })` | the child rows naming the host's pk by `fk` (a column of `table`, asserted), filtered by `where`, with nested rollups keyed by a child column (`NestedRollupJoin`, `on` a column of `table`, asserted) |
| `closure` | `closureJoin({ alias, edges, child, parent, nodes, ancestorJoins?, aggregates })` | the host's transitive ancestors over `edges` (`child` → `parent`, both columns of `edges`, asserted; cycles terminate); an ancestor is a row of `nodes` (the base table), with `ancestorJoins` (rollups — `on` a column of `nodes`, asserted — or children) hung off it |

- **Only aggregates cross to the row.** A children or closure join is read
  through the aggregates its `aggregates(c)` callback declares —
  `aggregate(sql, { decoder, sqlType, notNull?, ifNone? })` or
  `jsonAgg(columns, { orderBy })` — and `AllJoinRefs` exposes them as
  `AggregateRef`s under `j.<alias>`: a raw child column is a tsc error. A33: a
  `notNull: true` aggregate must state `ifNone` (what a host with no group row
  reads — the grouped CTE is LEFT-joined), a type error and a throw. `jsonAgg`
  is never NULL (no rows ⇒ `[]`), its element types are the columns' JSON
  forms (a `Date` crosses as its ISO string), its order is declared and
  non-empty. Both are branded (`isAggregate`), like `ExprField`, and carry a
  type-only FORM phantom their `AggregateRef` inherits (`aggregate` →
  `decoded`, `jsonAgg` → `json`: undecoded JSON, timestamps already ISO-UTC
  text), so a consumer can admit a field's JSON form for a `jsonAgg` alone
  (network/live's `all` binding).
- **A rollup's columns are `OuterColumnRef`s** (a `TypedColumnRef` with a
  type-only outer phantom): a rollup is LEFT-joined, so its NOT NULL columns
  read NULL for a host with no rollup row, and a `jsonAgg` element field over
  one is `| null` whatever the table says.
- **The callbacks are data the compiler runs**, handing refs that render
  against each relation's internal name (`<a>`, `<a>__<r>` for a rollup under a
  children join, `<a>__anc` for a closure's ancestor row, `<a>__anc__<r>` for a
  join hung off it — the `from` the refs are typed with). They are method
  signatures, compared bivariantly, so a join over one table is still an
  `AllJoinSpec` (the wide join's refs are nothing to name).
- **`AllJoinSpec` is the `all` compiler's alone.** A window, a grouping, a union
  arm, a column override and a contributed column keep `JoinSpec`, so a
  rollup, children or closure join there is a tsc error (C9 / A24) — and
  `compileJoins` refuses one a cast let through, at module eval (D24): a
  grouping would mint a `full` route naming the rollup table, which A1 would
  refuse at boot. The `all` compiler plans its joins with `compileAllJoins`
  (the window kinds plus a top-level rollup, joined row-wise); a children or
  closure join is rendered as a grouped CTE instead (`server/internal/grouped.ts`),
  never joined row-wise, so `compileAllJoins` refuses one in its row-wise list —
  it takes their internal relations as `grouped` instead.

### Rollup routes — a rollup is routed through its SOURCES

A rollup join (`compileAllJoins`) is LEFT-joined on its key like an N:1
lookup — `on` the base pk, a non-pk base column or an earlier join's, of the
key's SQL type (asserted) — but the rollup table has no change-feed trigger
(A1), so `joinRoutes` emits one route per SOURCE (`rollup.sources`),
`<alias>[<source table>]`:

| Case | Map | `columns` (the gate) |
|---|---|---|
| `on` = the host pk, no `via` | `alias` on `carry` (none when `carry` is the source's single-column pk: `change.ids`) | the source's pk ∪ `carry` ∪ `reads` — exactly what its maintain function diffs |
| otherwise | `reverse` over the carried values: `on = ANY($keys)` from the base and the chain up to `on`'s relation, the keys being the values or, with `via`, `SELECT key FROM via WHERE match = ANY($values::<carryType>[])` | same |
| a hop or chain join over the changed source table itself | `full`, `pre-image needed: …` (A10) | same |

- **The hop is read after commit as the maintain function reads it at trigger
  time**, so the probe resolves what the rollup re-aggregated: a write that
  moves or removes the hop row (`UPDATE attempts SET task_id`, an RI cascade)
  resolves only its new keys in either. **A35:** the plan therefore refuses at
  compile (`assertHopsCovered`, over the rollup's compiled sources) a source
  whose `via` table is not also a source of the same rollup that sees every
  re-key: its `carry` is the hop's `key` (no `via` of its own), the hop's
  `match` is in its pk ∪ `carry` ∪ `reads` (else `UPDATE … SET <match>` passes
  both the maintain function's diff and the route's column gate), and its `ops`
  include `update` and `delete`. That source re-aggregates, and routes, the old
  key too. The error names the rollup, the source, the hop table and the gap.
- **`within` is cast `{ invalid: "absent" }`** (the 16b.1a policy; the lookup
  probe still passes `"throws"` until that step lands).
- **Uses.** A tuple reading the rollup names every source route, in the role
  it reads the rollup in. A membership use carries no `moves` (every column):
  the reader's SQL reads ROLLUP columns, not source ones, and each source
  route's own gate already skips a write the rollup ignores.
- **`derivedReads`.** `JoinPlan.derivedReads` (each rollup table once, with its
  sources) rides `routedReads` into `compiledRoutePlan` → `mintRoutePlan`,
  which refuses one a route names (A1) or whose source no route names (A22);
  minted only when non-empty, so every existing plan keeps its shape. The
  drift guard accepts the rollup table in a loader's capture.
- Pinned by `server/internal/rollup-routes.test.ts` (shapes, SQL, fan-out,
  refusals) and `rollup-routes-layout.test.ts` (C14: the source route reaches
  `routedTableRequirements()`, the feed's trigger carries it, A3 refuses one
  that does not).

### The `all` compiler — `compileAllCollection` (`server/internal/compile-alias.ts`, `grouped.ts`)

A collection declared `all` (`liveCollection(key, { all })`) is ONE
param-less keyed resource holding every row in a declared order, plus its
`:rows` point sibling. `compileAllCollection({ all, rows }, spec)` compiles
both (P8 v3 §4.1, C2/C3/C5/C7/C18): `{ all, rows, keyField, definition }`,
each half ready for `defineResource`. network/live's `serveCollection` is its
shipping caller (its `all` arm binds the row fields and registers both
halves); the compile-SQL golden and tasks-core's parity oracle reach it
through `server/testing` over declarations nothing serves. The whole set's
descriptor TYPE is `AllQueryResourceContract<Row>` (`core/`, beside the window
and point contracts): param-less, keyed, no placeholder, `all: { orderBy,
unbounded }`, `queryPk`.

- **Spec.** `from` (a base table — its single-column primary key is the host
  identity), `joins` (`AllJoinSpec`: the window kinds, a top-level rollup, and
  children / closure), `select(bind)` and an optional static `where(bind)`,
  both written over `bind` — `j` (base and row-wise join columns as
  `ColumnRef`s, a grouped join's aggregates as `AggregateRef`s), `render`,
  `aggregate`, `expr` — so every read goes through THIS compile's one plan.
  `wire: { encodeRow, ids }` (one option: `encodeRow` is code the definition
  cannot read, so it never comes without the stable ids of the codecs it
  applies — an empty `ids` is refused), `readField` and `debounceMs` (C18) are
  the caller's. The order is the
  contract's `all.orderBy` (row fields), the pk the tiebreaker.
- **Shapes** (raw SQL, `QueryDb.execute` + `decodedRow`):
  - **Full** — `WITH [RECURSIVE] <ctes> SELECT … FROM base <row-wise joins>
    LEFT JOIN <cte> ON <cte>.__k = pk … WHERE where ORDER BY orderBy, pk`. A
    children join is one `GROUP BY fk` CTE (`__c_<a>`, its nested rollups
    LEFT-joined inside); a closure is the recursive pairs CTE `__x_<a>`
    (`UNION`: a cycle terminates, a node in a cycle is its own ancestor), its
    ancestors' children CTEs, and the per-node aggregate CTE `__g_<a>` (the
    ancestor row joined as `<a>__anc`).
  - **Scoped** (the refill, and `:rows`) — the same CTEs restricted to the
    hosts asked for (`= ANY($ids)`), no ORDER BY. A32 — the planner fences are
    in the text: the closure walk is `CROSS JOIN LATERAL (… OFFSET 0)`, the
    ancestors' groups are restricted by `ANY(ARRAY(SELECT DISTINCT __a FROM
    __x_<a>))`, the ancestor row is a pk lateral. The `all` refill casts its
    ids `"throws"` (the runtime's); `:rows` casts them `"absent"` (the
    client's).
  - **orderIds** — `SELECT pk AS __id FROM base <INNER joins + the joins its
    where reads> WHERE where ORDER BY orderBy, pk`: the `scopedMembership`
    `orderOf`, run only when a row enters or an order field moves.
- **Aggregates.** A CTE body is the declaration's expression, or a `jsonAgg`
  rendered here: `json_agg(json_build_object('<field>', <col>, …) ORDER BY
  <order> NULLS LAST, <child pk>)`, a timestamptz as `to_char(<col> AT TIME
  ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` — the text a `Date` crosses the
  wire as, whatever the session's time zone. The row reads
  `COALESCE(<cte>."<name>", <ifNone>)` (`'[]'::json` for a `jsonAgg`),
  registered through `JoinPlan.renderAggregate` with its provenance: the body,
  the fk (the closure's child / parent) and the children `where` (C7).
- **Grouped relations.** Every internal relation of a children / closure join
  (`<a>`, `<a>__<r>`, `<a>__anc`, `<a>__anc__<j>`, `<a>__anc__<c>__<r>`) is its
  table aliased under that name and registered as a GROUPED relation of the
  plan (`compileAllJoins(…, grouped)`): resolved like a join's for provenance,
  never walked or joined row-wise, never outer (`ifNone` is what an empty group
  reads), and readable only inside an aggregate.
- **Routes** (each grouped one read as `value`: an aggregate never moves
  membership):

  | Route | Table | Map | Gate |
  |---|---|---|---|
  | `<a>` (children) | child | `alias` on `fk` | fk, child pk, the columns its where / aggregates / rollup joins read |
  | `<a>__<r>[<src>]` | rollup source | `reverse`: carried keys (through `via`) → child rows whose `on` names one → their `fk` | src pk ∪ carry ∪ reads |
  | `<a>` (closure) | edges | `alias` on `child` | child, parent |
  | `<a>:closure` | edges | `reverse` on `child`: the dependents probe | child, parent |
  | `<a>__anc:closure` | base | `reverse` on its ids: dependents | pk + the ancestor columns the aggregates read |
  | `<a>__anc__<r>[<src>]:closure` | rollup source | `reverse`: keys → ancestor nodes → dependents | src pk ∪ carry ∪ reads |
  | `<a>__anc__<c>:closure` / `…__<c>__<r>[<src>]:closure` | child / rollup source | `reverse`: fk values (or child rows) → dependents | as above |

  The **dependents probe** walks DOWN the edges from the nodes a change names
  (`WITH RECURSIVE __d_<a>` with an `OFFSET 0` lateral per reached node over
  the `parent` index), `LIMIT cap + 1`; `within` goes into the SQL up to
  `WITHIN_IN_SQL_MAX` (256) ids and is filtered in JS past it. A source probe
  that would read, after commit, the table its change is on (its own `via`, or
  a table the hosts are resolved through) is `full`, `pre-image needed` (A10).
- **Asserted at module eval:** A29 (each order field reads a base column; the
  `where` reads no grouped relation), A35 (every nested rollup's hops,
  `assertHopsCovered`), A37 (a children `fk` and a closure's `child` /
  `parent` lead a declared index or the primary key — drizzle's own index
  metadata), A38 (CTE names unquoted, `CTE_NAME_RE`; grouped aliases
  lower-snake), A39 (a `jsonAgg` column is text / boolean / integer /
  timestamptz / json / jsonb / text[], with no `withWire` codec), C7 (every
  field reads at least one relation column; no field reads a grouped column
  outside an aggregate), every declared grouped join read by some field —
  and, within one, every nested rollup read by its where or an aggregate, and
  every closure ancestor join (rollup or children) read by a closure
  aggregate (an unread one would be joined and routed for nothing) —, the
  key field the base pk, a closure's `nodes` the base table, a nested rollup's
  `on` of the key's type, and — after rendering — every relation a read clause
  names quoted (`database/server`'s `quotedRelationsIn`) is a route table or a
  derived read (A1 / A8).
- **Definition (A18 / A40, `server/internal/fingerprint.ts`).** sha256 over
  the full, scoped (ids `["$ids"]`) and orderIds SQL and params as drizzle's
  `PgDialect` renders them, each field's decoder id, SQL type and
  nullability, the row schema (`describeZod`), `wire.ids`, every rollup's DDL
  hash, the order and the key field. A decoder id is read through
  sql-projection's `decoderOrigin` (the `{ mapFromDriverValue }` object
  `.mapWith(fn)` stores unwrapped): a column by table / name / type — plus,
  for a `parsedText` / `parsedJson` column, `describeZod` of the schema it
  decodes through (sql-column's `columnSchema`) —, a native coercion
  (`Number` / `String` / `Boolean` / `BigInt`) by name, `parsed` by its label
  and `describeZod(schema)`, `nullable` by its inner decoder, and every
  `jsonAgg` by core's `jsonAggValue`. Any other function is refused at bind —
  its body could change without moving the definition. `describeZod` is
  FAIL-CLOSED (`describeZodParts`): a part whose output depends on a function
  body — a `transform` / `preprocess`, a `catch`, a `default` that is not one
  stable JSON value — or a zod type it does not know is an `{ $opaque }`
  marker, listed by path; a literal default's value, an object's catchall, a
  regex's flags and array / set lengths are recorded (a refinement is data: it
  never changes a value). A `parsed` decoder with an opaque part is refused at
  bind like an opaque function. **Not refused:** an opaque part of a column's
  schema or of the row schema — the marker is folded in, so the definition
  moves when the schema's shape does, but not when only a transform body does
  (a `tolerantEnum` column's `normalize`, which the tasks entities carry).
  A non-literal param (a `Date`) is refused. It rides the `all` plan's
  `RoutePlanInput.definition`; `:rows` is bounded, never persisted, and has
  none.
- **Tests.** `server/internal/compile-alias.test.ts` (recording db: the
  shapes, the fences, routes, uses, the probes, the definition, every
  refusal), `server/internal/compile-alias-closure.test.ts` (A23: 200 random
  statements over a cyclic graph, change-logged with cascades — full equals a
  JS oracle, the routes, gated as the runtime gates them, reach every moved
  host, scoped ≡ full ∩ S), tasks-core's `all-parity.test.ts` (Full ≡
  `tasks_v` / `attempts_v`, the owner-joined active conversations ≡
  `conversations_v` with the lookups' real probes, scoped ≡ full ∩ S, under
  Europe/Paris, before and after trigger-maintained writes) and the
  compile-SQL golden's `all` group.

### Raw SQL helpers — `server/internal/raw-sql.ts`

The pieces every raw shape shares (the union and the `all` compiler):
`canonicalSqlType`, `nullOf`, `decoderOfRead`, `allOf`, `fromSql(base, plan,
included, label)` and `anyOf(col, ids, { invalid })` (`anyOfExpr` for an
expression of a stated type, a CTE's output column). `anyOf` is ONE array
param cast to the column's type, and its caller must state what an id the type
cannot hold does: `"throws"` for ids the database vouched for (a reverse probe's
changed keys), `"absent"` for untrusted text (a union `kind:raw` key — dropped
through `pg_input_is_valid`, so a bad key is absent, never an invalid-input
error).

**Known gap:** a reverse probe's `within` still passes `"throws"`, but it is
not always vouched for — for a point reader it is the client's own `:rows` id
set (resource-runtime's `reverseWithin`; the union's reverse wrapper decodes it
straight to raw arm ids). A key a non-text pk cannot hold (`uuidarm:x` on a
uuid arm) is absent from the `:rows` load, yet fails every probe of the
looked-up table with an invalid-input error, and the probe's bounded readers —
their `within` sets unioned — all recompute FULL. `within` only bounds the
answer, so `"absent"` is its right policy; switching changes the uuid arm's
probe SQL in the union snapshot, so it is its own step (P8 v3, step 16b.1a).

### Raw execution — `QueryDb.execute`

`QueryDb extends SqlExecutable<SQL>` (sql-rows): drizzle's raw `execute`, for
the shapes the builder cannot render (a union with expression order keys — drizzle's
`unionAll` rewrites column chunks to bare identifiers —, a recursive CTE). Every
raw read goes through `executeRows(db, { query, row: decodedRow(…), label })`
(sql-projection), so its rows decode like a builder's. `recordingQueryDb`
records `execute` too and answers a full `SqlResult`.

### Reverse routes — a lookup's changes, resolved to hosts (P4)

A lookup is joined N:1 from the host side, so a change to a looked-up row names
the ROW, not its hosts: its route is `reverse` on the lookup's `pk`, and its
`resolve(changed, within, cap)` (`server/internal/joins.ts`, `reverseMap`) is the
probe the runtime runs in the drain, once per flush:

```sql
SELECT DISTINCT <host pk> FROM <base> [the joins up to `on`'s relation]
 WHERE <on> = ANY($changed::<type>[]) [AND <host pk> = ANY($within::<type>[])]
 LIMIT cap + 1                       -- more than cap ⇒ "over-cap" (the readers go FULL)
```

- **One array param per list**, cast to the column's own type, so the column's
  index serves the probe and the statement is one shape whatever the count.
- **A10 — the FK-direction rule.** Resolved after commit, the probe is complete
  when it reads only HOST-side rows: the base (a self-join too — `nodes.parent_id`
  of the host rows) or earlier joins over OTHER tables. The referencing column is
  still there whatever happened to the looked-up row (a deleted source's events
  still name it), and a host row that moved its own key is a change of its own
  table, routed by its own route. A chain whose hop is a join over the CHANGED
  table itself would read the post-image of the very rows that changed; that
  route is `full`, reason `pre-image needed: …` (listed by the Read-set pane).
- A tuple reads the lookup as `membership` (required, or filtered / sorted by it)
  — resolved unbounded — or `value` — resolved within its members; `moves` turns a
  `U` of the lookup's projected-only columns into the latter.
- **Host ids are the pk's own values.** The probe answers the host pk as it is
  stored and reads `within` the same way. A single compile's routes are
  `RawRoute`s — an `identity` / `alias` map cannot carry `encode` (T10, a tsc
  error) — so `compiledRoutePlan` mints one key space. A union re-keys its
  arms through `compiledUnionRoutePlan` (below), which encodes the reverse
  answer and decodes `within` together with the identity.
- **The probe does not apply the collection's predicates** (base `where`,
  default scopes): hosts no tuple can hold count toward the cap. A default is
  per tuple, and a predicate reading the looked-up row must not filter the
  post-image (a disabled source's events are exactly the ones to exit), so a
  host-only static predicate is the one that could be ANDed in — no collection
  has one beside a lookup yet.
- The grouping compiler's routes stay `full` (a count has no hosts); a keyed
  side's `full` route there carries its selectors as `rows`, so a write to
  another scope's or member's rows moves no count.

### Union route plans — `compiledUnionRoutePlan` (P6)

A union window lists N arms (tables) in one `kind:raw` key space
(`armKeyCodec(kind)`, core: `encode` = `kind:raw`, `decode` strips the prefix
once — a raw id may contain `:` — and answers `null` for another arm's key;
`KIND_RE` is what a kind may be). `armKeySql(kind, idCol)` (server) is the SQL
that projects the same key, tested byte-equal to `encode` against Postgres.
`compiledUnionRoutePlan(arms, usesOf)` mints the union's plan from each arm's
raw routes:

- route ids are prefixed — the base `<kind>`, any other `<kind>.<id>` — and
  must be unique, kinds too (A14); an arm's `identity` route carries no
  `column` (an arm's raw id is its table's single-column pk);
- `identity` and `alias` maps gain the arm's `encode`;
- a `reverse` map's `resolve` decodes `within` to that arm's raw ids (another
  arm's keys dropped; none left ⇒ no probe), passes `within: null` (an
  unbounded reader) through, and encodes the answer; `"over-cap"` passes
  through;
- `full` is unchanged. `usesOf` answers in the prefixed ids.

### Union collections — `compileUnionCollection` (P6)

The compiler behind network/live's `serveUnionCollection`
(`internal/compile-union-window.ts`): N ARMS — a table each, its id its
single-column primary key — listed as one collection in one key space
(`kind:raw`). It returns the three server halves a `liveCollection({ arms })`
mints (window, `:rows`, `:groups`). It knows tables, joins, SQL and routes; the
filter language (which arms a tuple keeps, an arm's compiled `where`) and the
row's wire shape are the caller's.

- **Routed per arm, rendered positionally.** Each arm is routed exactly as a
  single-table compile is (`routedReads`, `arm-plan.ts`' routed half: its
  base `identity`, one route per join, each gated by the columns its SQL reads,
  `moves` from its `where` and order) and re-keyed by `compiledUnionRoutePlan`;
  `usesOf` answers only the tuple's surviving arms. The SQL is rendered here —
  every arm projects `__kind`, `__key` (`armKeySql`) and `__c<i>` (its read, or
  `NULL::<sqlType>`) — and run raw through `QueryDb.execute`, each row decoded
  by its own arm's decoders (`decodedRow`, dispatched on `__kind`).
- **Shapes.** Full: per surviving arm `SELECT … WHERE arm.where ∧ whereOf ∧ cut
  ORDER BY … LIMIT n`, `UNION ALL`, re-ordered and re-limited outside (zero arms:
  a typed `WHERE false` scaffold). Scoped refill: keys decoded per arm (another
  arm's or an undecodable one dropped), `pk = ANY`, no order. `windowIdsOf`: the
  full shape projecting the key and the order columns. Point (`:rows`): grouped
  by kind over every arm, `arm.where` kept; an unknown kind is absent, never a
  contract error. Groups: a per-arm `GROUP BY 1` (a constant arm groups as one
  value), summed outside, `full` routes per arm.
- **Static nullability.** A column is nullable when ANY registered arm reads
  NULL for it — computed once at bind, never per surviving arm, so a cut and a
  signature never depend on what a tuple pruned.
- **Total order.** The tuple's keys, then the row key. Inside an arm a constant
  key orders nothing and is dropped from its ORDER BY, but the cut (keyset
  `seekPredicate` / `atOrBeforePredicate`) runs over every key, constants
  included, each operand cast to the column's type. The row key is the
  outer `u."__c<i>"::text` of each key — the union's own text.
- **A14 at bind:** kinds unique and `KIND_RE`; `id` the base table's
  single-column primary key; every column's `sqlType` a type name, and every
  arm's read of it producing that type (`canonicalSqlType` folds
  `timestamptz` / `timestamp with time zone`, `int4` / `integer`, …); the key
  field and the discriminator never a bound column. Unit suite:
  `server/internal/compile-union-window.test.ts`.

### Join families — members joined per tuple (P3)

A **`JoinFamily`** (`core/`) is a composite-keyed side table whose set of
MEMBERS is data, not code — a DataView surface's custom columns: `hostKey` +
fixed `selectors` (the surface) + a `member` column (`column_id`) + the `value`
each member reads. A window spec takes them as `families: { joins, valuesKey }`
(window kind only).

- **A member is a keyed-side join** (`familyMember(family, m)`, alias
  `familyMemberAlias(id, m)` — injective: every character outside `[A-Za-z0-9]` is
  spelled `_<hex>_`; a spelling past Postgres's 63-byte identifier limit becomes
  `<id>___h<128-bit hash>`, a form no spelled alias can take, and two members
  meeting on one alias fail the compile). The caller renders a member's value through its plan
  (`JoinPlan.readMember(familyId, m, read?)`, compiled on first use; `read` is a
  cast and the SQL type it produces), and every plan over the same family object
  finds that member again by its alias (a module-level registry, like the
  defaulted-column one), so the plan that applies a tuple's joins knows it.
- **A tuple joins exactly the members its `where` / order names** (read off its
  SQL like any join), as `membership`. ONE route serves the whole family
  (`familyRoute`): an `alias` on `hostKey`, `rows` = the selectors, `match` on the
  member column; a tuple's use matches the members it reads, so a write to
  another member, or another scope's rows, reaches no tuple.
- **A member the tuple orders by is projected** (`__family_<i>`) and folded into
  `row[valuesKey]` by join alias, where its order signature reads it (the
  signature universe `signatureColumns` is static; members are not in it).
  `whereReads` does not apply to members: their route's columns are the family's.
- A cast member's page cut casts back through the expression's own SQL type
  (`JoinPlan.sqlTypeOf`), not its raw column's. A per-tuple order is memoized by
  its keys' RENDERING (an expression key by its object and SQL type), not by
  relation and column name — a retyped member keeps its alias and column but
  reads through a new cast, so its ORDER BY, `__family_<i>` projection and cut
  casts follow the retype on the next load.
- **`recomputeOn`** on the spec is handed to the runtime as the routed entry's
  `recomputeOn`: an external value tuple whose change moved the family's members
  (a column added, dropped, retyped) FULLs every subscribed tuple and drops its
  read-set memo.

## What it derives

1. **Identity** (`resolveIdentity`, `internal/identity.ts`). The source is a
   `RoutedSource` — a `PgTable` or an `Entity`, never a view (A1, above):
   `Entity` → pk = its table's single primary, projection = `wireColumns`;
   `PgTable` → pk = its single primary, select-all. A composite / missing PK
   with no `identity.pk` override throws; such a payload is a pushed
   `liveValue` (`network/live`) instead.
2. **keyField.** The wire field the client `keyOf` reads: the projection key whose
   column matches the pk (matched by DB column *name*, so an aliased projection
   `{ conversationId: table.parentId }` keys on the alias), else the pk's JS
   property name. Throws if the pk is not projected, or if the descriptor's
   `queryPk` disagrees with it.
3. **FULL loader** — the tuple's whole window / point set / ordered set.
4. **Scoped loader** — the same read composed with `pk IN (affectedIds)` and no
   order or limit: the partial refill a membership drain runs for the rows a
   routed change named.
5. **ScopePolicy** — the routes plus a membership (a window / point
   `membership`, or the `all` set's `scopedMembership` alias with its
   `orderOf` and `orderSignatureOf`). Every compiled order declares its order
   signature, so a refilled row whose sort position moved re-derives `order`
   instead of staying in place.

## Keyed, except the grouping

A keyed loader may return a partial (scoped) array, which the keyed diff merges
into the snapshot; a push loader that did the same would broadcast the partial
array as the whole value, corrupting every subscriber. So every compiler that
refills by id emits a KEYED resource, keyed-ness coming solely from the client
descriptor (`liveCollection`'s window / `:rows` / `all` descriptors), and the
grouping compiler — a push value — has no scoped loader at all: every reach
route is `full`. A pushed or on-demand payload of your own is a `liveValue`
served by `serveValue` (`network/live`).

## Bounded membership: `windowQueryResource` (window / point)

`serveCollection` (`network/live`) compiles every collection through here, and
a bounded resource is declared and served only that way: the two descriptor
kinds this compiler takes are minted by `liveCollection` alone (their factories
are internal to `network/live`). This plugin keeps just the contract TYPES the
compiler consumes — `WindowQueryResourceContract` / `PointQueryResourceContract`
in `core/`. The compiler's tests therefore live beside `serveCollection`, in
`network/live/server/internal/` (`compile-window.test.ts`,
`compile-window-runtime.test.ts`), and reach `compileWindowQuery` through this
plugin's `server/testing` barrel; a test here importing `network/live` would
close an import cycle.

**Arms and assembly.** The compile is split in two (`internal/arm-plan.ts`,
`internal/compile-window.ts`). `planArm` plans ONE relation set — identity,
joins, projection, routes, each tuple's reads (`tuple(params)`: where,
included joins, uses with `moves`), the order (plan, cuts, signature parts) and
the SQL each shape renders (`fullQuery` / `scopedQuery` / `idsQuery` /
`pointQuery`, rendered, never executed) plus `fold` — as an `ArmPlan` whose
`mode` is `window` or `point`. `assembleWindow` / `assemblePoint` own the rest:
the order signature, the clamped limit, the loaders, `windowIdsOf`, the membership and the
scope policy. The spec's own guards (kind, codec, `orderBy`, limits, a function
order's `signatureColumns`) run before `planArm`. A single-table spec is the
1-arm case. The union compiler (*Union collections*) reuses the arm's routed
half (`routedReads`) and renders its own positional SQL; so does the persisted
`all` collection (*The `all` compiler*) — raw SQL, never an `ArmMode` (P8 v3
C2). Neither goes through `assembleWindow` / `assemblePoint`, which therefore
take exactly one arm (`readonly [ArmPlan]`). The grouping compiler splits the
same way: `planGroupArm` and `compileArmGroups`, with `compileGroupsQuery` the
1-arm case.

The split is pinned byte for byte by `network/live`'s
`server/internal/compile-sql-golden.test.ts`: a fixed matrix of declarations
(`network/live/server/testing/compile-sql-golden.ts`) whose every shape's SQL
and params, routes, `usesOf`, signatures, folded rows and per-tuple
`where` / `orderBy` resolutions must equal
`network/live/server/testing/compile-sql-golden.json`. Its `all` group pins the `all` compiler (*The `all` compiler*) the same
way — every shape's SQL, the routes and their probes, the uses and the
definition — for a flat and a tree-shaped declaration. The test only reads the
fixture; a deliberate SQL change regenerates it with
`./singularity run plugins/network/plugins/live/server/testing/gen-compile-golden.ts`
and reviews its diff.

The union compile (*Union collections*), which the golden does not cover, is
pinned the same way by `network/live`'s
`server/internal/compile-union-golden.test.ts`. It runs a fixed four-arm union
(`network/live/server/testing/compile-union-golden.ts`) through `compileUnion`
→ `compileUnionCollection`. The arms cover a text pk, a LEFT lookup, an integer
pk, and a uuid pk with a REQUIRED (INNER) lookup. For every window, `:rows` and
`:groups` shape, the test compares the SQL and params, routes (including each
identity route's arm-key `encode` and the re-keyed reverse probes), `usesOf`
and folded rows with `network/live/server/testing/compile-union-golden.json`.
To refactor the union's SQL helpers (`raw-sql.ts`) or the routed half it shares
with the arm, keep both fixtures byte-identical. If the
union snapshot has to change, regenerate it with
`./singularity run plugins/network/plugins/live/server/testing/gen-compile-union-golden.ts`.
Run the generator on the code BEFORE the refactor; output generated afterwards
reproduces whatever the refactor broke.

The bounded-working-set compiler: the subscription's params tuple names a
**bounded selector**, so a change costs O(changed) + O(window), never
O(collection), and the value is never the whole table. Two kinds, one compiler —
two spec TYPES, `WindowQueryResourceSpec` (`window`, `orderBy` and `rowKey`
required, the window-only `signatureColumns` / `families` / `recomputeOn` /
`readField` beside them) and `PointQueryResourceSpec` (`point`, every
window-only field `never`), so a point spec cannot spell an order, a row key
or a family (tsc); `windowQueryResource`'s overloads pair each with its
descriptor kind, and the module-eval guards stay for an untyped caller. What
`serveCollection` derives for a collection `c` over a table (never written by
hand):

```ts
windowQueryResource(c.window, {
  from: table,
  select,                                    // exactly the row schema's keys
  where: (params) => and(base, filterSql(decoded.where)),
  orderBy: (params) => decoded.orderBy,      // { col, dir, nullable }[], per tuple
  signatureColumns,                          // every sortable column
  window: {},                                // maxLimit rides the descriptor's codec
  rowKey: { cutsOf, familyOf, keyField: "$key", maxKeyBytes },  // every window pages
});
windowQueryResource(c.rows, {
  from: table,
  select,
  where: base,                               // the collection's base membership, if any
  point: { by: table.id },                   // IS the identity pk
});
// web: useLive(c) → Row[] at the default window; useLiveRow(c, id) → pending /
//      found / not found, O(1), no .find(); useLive(c, { ids }) → Row[] for a set.
```

What the compiler derives per kind (both kinds also emit their identity route —
see *Routes* above):

- **window** — the windowed FULL loader (`where → ORDER BY → LIMIT`, the limit
  decoded from the params via the descriptor codec and clamped to `maxLimit`),
  the Layer-2 scoped refill (`pk IN affectedIds`, no order/limit), `windowIdsOf`
  (the ids-only windowed query — same where/order/limit as the loader, so the
  membership authority cannot drift from it), and `orderSignatureOf`, emitted as
  `membership: { kind: "window", windowIdsOf, orderSignatureOf, limitOf,
  familyOf }` — `limitOf` the same clamped limit (required by the runtime: a
  window holding fewer rows is not full, so its exits need no `windowIdsOf`)
  and `familyOf` its `rowKey.familyOf`, which together let the runtime derive
  a fresh tuple from rows other tuples of the same query hold
  (resource-runtime's *Seeded derivation*; the union window states both, its
  `window.familyOf` required). `orderBy` is
  `{ col, dir }` pairs, not raw SQL: the compiler appends the pk tiebreaker (a
  window must be a prefix of a strict total order) and renders explicit
  `NULLS LAST`, and a future cursor derives its keyset seek
  (`primitives/keyset`) from the same keys.
- **point** — the loader as a scoped read over `ctx?.affectedIds ??
  point.decode(params)` (an empty set short-circuits to `[]`, no query),
  emitted as `membership: { kind: "point", idsOf: point.decode }`. `point.by`
  **is** the identity pk — the change-feed routes by intersecting changed
  identity ids with each tuple's set, so any other column could never
  intersect (declaring both `identity.pk` and a different `by` throws).

**Client-chosen order (`orderBy` as a function).** `orderBy` may be
`(params) => WindowOrderKey[]`, like `where`: each subscription tuple sorts by
the order its own params resolve (the rendered ORDER BY is memoized per
canonical order; the pk tiebreaker and NULLS LAST are still appended). A
function `orderBy` **requires `signatureColumns`** — the union of every column it
may sort by, each projected. The order signature is **per tuple**:
`orderSignatureOf(row, params)` covers only the columns that tuple orders by,
cut from `signatureColumns`, so an UPDATE to a column re-derives the windows of
the tuples sorting by it (one bounded ids query each) and costs a tuple sorting
by another column nothing — a playback write under a `title` sort stays on the
in-place path. A resolved order column outside `signatureColumns` throws on
first use; a static `orderBy` may pass `signatureColumns` too (it must cover the
declared order columns; the signature is still the order's own columns). A
richer window codec may carry extra params keys (`{ limit; where?; order? }`) — descriptor, contract and compiler are
generic over `P extends WindowParams` — and may carry `window.maxLimit` on the
descriptor instead of the spec (both given ⇒ must be equal; neither ⇒ throw).

**Order-column updates are HANDLED.** `orderSignatureOf(row, params)` is the
canonical join of the wire values of the columns that tuple orders by (the auto
pk tiebreaker is excluded; every signature column must be projected, or module
eval throws). The runtime
compares it per refilled member row and re-derives the window via `windowIdsOf`
when it moved, so a `createdAt` resurface reorders the wire window instead of
leaving it stale. **Cost note:** each order-column update costs one O(window) ids
query (content-only updates stay on the zero-ids-query in-place path), so prefer
mostly-stable order columns for very hot rows. The mutable-`where` rule above does
NOT apply here: a where-flip is a detected membership exit/entry.

**Key-range pages (`rowKey`).** Every window spec declares `rowKey: { cutsOf,
familyOf, keyField, maxKeyBytes }` (required by the window kind; network/live
passes it for every collection window): each tuple may be one key-range page of
a paged read — its order cut by an exclusive `after` and an inclusive `until`
row key — and every full and scoped row carries its own row key in `keyField`.
`familyOf` names the query a page belongs to (one string for every page of it,
whatever its cuts and limit: network/live's codec reads its `where` and
`order`), so any window's page may be derived. ONE key list per tuple order
(the declared keys, then the pk unless one already is) feeds the ORDER BY, the
cuts and the row keys, so the three cannot disagree. The row key is the
canonical JSON of each key's `col::text` (projected under `__row_key_<i>` by
the full and scoped loads — never by `windowIdsOf` — and folded in JS, `null`
over `maxKeyBytes`); cuts render on the order side
(`primitives/keyset`'s `seekPredicate` for `after`, `atOrBeforePredicate` for
`until`, each operand cast `$n::<the key column's type>`), ANDed after the
tuple's `where` has been checked against its `whereReads` universe — so a
sortable-but-not-filterable order column takes cuts. Cuts read only order
columns, which the routes and the signature already cover: routes, `usesOf` and
roles are unchanged. More spec seams serve it: `window.limitOf` (decode the
tuple's limit when the descriptor's codec needs more than the params — a
contributed collection decodes against the column sets it serves),
`window.validateParams` (the params gate for the same reason — it replaces the
descriptor's on the server, through the runtime's
`ServerResourceOptions.validateParams`) and `readField` (where an `encodeRow`
moved a projected field — the order signature reads it there).

**Deferred compile (`deferredWindowQueryResource`).** The same compile, run at
`bindDeferredResources` (server-core's boot step after contributions are
collected): the resource registers now under its descriptor and `specOf()`
compiles at the bind, through the same checks. For a spec that depends on
contributions (network/live's `contributed` collections).

The spec has no `limit` / `recompute` / `scopedMembership` fields (the bound
comes from the params; membership is always incremental); bounded resources are never L2-persisted
(runtime-enforced), so a preloaded window loads via boot-snapshot's
fallback loader at the descriptor's `defaultParams` — the identical tuple a
bare `useLive(c)` subscribes to. `defaultLimit` lives ONLY on the descriptor
(the client default and the boot default must be one number); the spec carries
at most `maxLimit`. Every misuse (window+point, missing `orderBy` or `rowKey`,
an order / row key / family on a point spec,
`defaultLimit > maxLimit`, spec/descriptor `maxLimit` disagreement, a function
`orderBy` without `signatureColumns`, an unprojected signature column, kind/descriptor drift, `point.by` ≠ identity pk,
`queryPk` ≠ derived keyField) throws at module eval — a bad spec is a boot crash,
never a silent misbehavior.

## The `db` seam

`spec.db` defaults to the real per-worktree drizzle `db` (a top-level static
import — the boundary system forbids inline `import()`), coerced once through a
minimal structural `QueryDb` facade; unit tests inject a fake. This works because
`@plugins/database/server` is **import-safe**: the pg pool (and its runtime-namespace
requirement) is built lazily on the first real query, so
importing `db` never touches a worktree — no test env shim needed.

## Boundaries

- `core/` — the contract types (`WindowQueryResourceContract`,
  `PointQueryResourceContract`, `AllQueryResourceContract`, in
  `core/internal/contracts.ts`). Web-safe: **no drizzle** (bundled into the
  browser).
- `core/` also holds the `all`-only join kinds (`AllJoinSpec`, `childrenJoin`,
  `closureJoin`, `aggregate`, `jsonAgg`, `OuterColumnRef`) — type-only drizzle
  imports, and a type-only import of `derived-tables/core`'s `Rollup`.
- `core/` also holds the join vocabulary's types (`JoinSpec`, `ColumnRef`,
  `JoinRefs`, `JoinRef`, `JoinColumns`) and `BASE_RELATION` — type-only drizzle
  imports.
- `server/` — `windowQueryResource` / `deferredWindowQueryResource`,
  `compileGroupsQuery`, `compileAllCollection`, `compileUnionCollection`,
  `compileJoins` / `joinRefs`, and the spec types. Owns
  all drizzle usage and the routes / keyField derivation. `server/testing` publishes `compileWindowQuery` (the bounded
  compiler without registering), `compileAllCollection` and
  `recordingQueryDb` for `network/live`'s and tasks-core's tests; `core/testing`
  publishes `familyMemberAlias` (shipping code reaches it through `familyMember`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Declarative SQL query→resource compiler: one drizzle-based declaration derives the loader, scoped loader, scope policy (the routes the change router serves it by, for a bounded window / point set, a whole ordered set declared `all` — compileAllCollection, grouped CTEs over rollup / children / closure joins — and a grouping), and client keyOf for live-state resources.
- Server:
  - Uses:
    - `database.db`
    - `database.quotedRelationsIn`
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
    - `CompiledUnion`
    - `EntitySource`
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
    - `compileUnionCollection`
    - `deferredWindowQueryResource`
    - `joinRefs`
    - `presenceExpr`
    - `windowQueryResource`
- Cross-plugin:
  - Imported by:
    - `network/live`
    - `runs`
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
    - `AllJoinRefs`
    - `AllJoinRefsOf`
    - `AllJoinSpec`
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
- Test helpers:
  - Server: `@plugins/infra/plugins/query-resource/server/testing`
    - `compileAllCollection` — Compile a collection declared `all` (see the header).
    - `compileWindowQuery` — Turn a bounded spec + its shared contract into the two-arg `defineResource` server half.
    - `recordingQueryDb` — A `QueryDb` that renders every query through drizzle's real `PgDialect` — the SQL a compiler would send — records it, and answers with `script`'s rows instead of running it.
    - Types: `RecordedQuery`
  - Core: `@plugins/infra/plugins/query-resource/core/testing`
    - `familyMemberAlias` — A member's join alias: the family id, then the member id with every character outside `[A-Za-z0-9]` spelled `_<hex>_` — injective, so two members can never share an alias (`cc-1` → `custom__cc_2d_1`).

<!-- AUTOGENERATED:END -->
