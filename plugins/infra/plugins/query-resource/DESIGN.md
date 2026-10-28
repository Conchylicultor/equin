# query-resource — design

Why the rules in [CLAUDE.md](CLAUDE.md) are what they are. Read before changing or removing one.

Reference designs: [scoped change routing](../../../../research/2026-09-29-global-scoped-change-routing.md),
its [`all` compiler follow-up](../../../../research/2026-10-06-global-scoped-change-routing-p8-v3.md),
and [compiled narrowing (`all.by`)](../../../../research/2026-10-19-global-live-compiled-narrowing.md).

## What it derives

**Keyed, except the grouping.** The failure a push loader with a scoped refill
would cause: the partial array is broadcast as the whole value, so every
subscriber's list shrinks to the few rows the change named. Keyed-ness is what
makes a partial refill safe, so the grouping (a push value) has no scoped
loader at all.

## Routes: the bounded and grouping compilers emit what their SQL reads

- **Why derived, never hand-authored.** A route's `columns` decide which
  updates reach the resource (the `unchanged` gate). A hand-stated set that
  misses one column silently drops every update to it. Only the code that
  renders the SQL knows what it reads — hence the single minter and the type
  brand.
- **Function `where` without a universe = every column.** The safe
  over-approximation: it costs extra recomputes, never a missed update.
  Declaring `whereReads` / `reads` buys the exact gate, and checking each
  tuple's `where` against it keeps the declaration honest.
- **Never a view.** A change-feed change is named by its base table. No route
  over a view can state which base-table changes reach it, so a routed view
  would never be told about a write.
- **No cascade edges.** A routed entry routes every table it reads itself; a
  `dependsOn` beside it would be a second, unscoped invalidation path that
  bypasses the exact read-set.
- **A key-layout pk.** When the identity pk is not the table's primary key, the
  feed's ids are not host ids. The route reads the pk off the change's key
  layout, which works because `tableLayoutRequirements` carries every map
  `column`, so the routed trigger sends it.
- **`routeIdsOf` fan-out.** A rollup is several routes (one per source); a use
  naming only the alias would leave the other source routes unread, and the
  runtime's per-route read-set would no longer be exact.

## Lookups — `compileLookup` (`server/internal/compile-lookup.ts`)

- **Lookup tables become `taggedReads`.** The drift guard then accepts those
  tables only from the lookup's own tagged statement. A table both in `tables`
  and in a lookup would let an untagged read of it pass unnoticed — hence the
  refusal.

## Joins: provenance-driven read-sets (`core/internal/joins.ts`, `server/internal/joins.ts`)

- **Why `moves`.** Without it every `U` on a membership table re-derives
  membership. With it, an event's title edit reaches only the windows holding
  the event, and a source's config edit resolves within the current members.
- **Matched by relation AND name.** Otherwise a join's `created_at` would be
  taken for the base's, and the signature / route columns would name the wrong
  table.
- **LEFT-joined columns order as nullable**: a host with no joined row reads
  NULL even when the column is NOT NULL.
- **Select-all routes every column.** The exact-columns rule reads the
  projection, never only the declared `select`; a select-all projects
  everything, so gating on fewer columns would drop updates.
- **`j` offers wire columns** (a join's `wireColumns` when it carries them,
  else its table's columns), so a server-only column cannot reach the wire
  through a column override.

**Missing extension rows:**

- **Why COALESCE to the default.** An extension row that does not exist means
  its declared defaults: a never-played song has `playCount = 0` in SQL too, so
  it filters, sorts and cuts like a played one.
- **Provenance stays the alias column.** `columnOf` is a module-level map, so a
  plan handed another plan's rendered (coalesced) column still resolves it.
- **Join conditions and static predicates read the raw column**: a join must
  compare the stored key, and a predicate states its own NULL handling.
- **A computed default (`defaultNow()`) is never coalesced** — it is not one
  value.

**Presence fields:**

Provenance is the join's key column, so a presence field routes, filters,
sorts and groups like any expression field.

### Expression fields — `ExprField` (`core/internal/expr.ts`)

- **Provenance off the SQL** means an order or filter over a lookup the
  expression reads makes that lookup `membership`, as it would for a column.
  It also makes a correlated subquery over an undeclared table unwritable.
- **An expression that is exactly one column is refused**: a column override
  gets the column's defaults, nullability and provenance; an expression would
  lose them.
- **Why a brand, not `kind`.** An object literal with `kind: "expr"` could
  skip `expr`'s checks; the unexported brand makes it a tsc error, and
  `isExprField` reads the brand.
- **Nullability backstop.** `serveCollection` also checks at module eval that
  a nullable expression is not bound to a non-null field.

### Aggregates — provenance declared (`JoinPlan.renderAggregate`)

- **Same object on repeat.** Memos of renderings key on identity; a new object
  per call would miss them.
- **`reads` must resolve to a relation column.** Nothing would route a change
  to an aggregate that reads none: silent staleness.
- **Cross-plan `canBeNull` throws** when asked of an aggregate another plan
  registered over a relation this plan lacks — the answer depends on a join
  this plan does not have.

### `all`-only join kinds — `AllJoinSpec` (`core/internal/all-joins.ts`)

- **Why these kinds exist only for `all`.** An `all` collection is computed
  set-at-a-time — grouped CTEs hash-joined to the base — which only makes
  sense for the whole set. A grouping would mint a `full` route naming the
  rollup table, which A1 refuses at boot.
- **The rollup's table is `rollup.handle`, never declared beside it**, so one
  rollup's sources cannot route another rollup's table.
- **A33 (`notNull` needs `ifNone`).** The grouped CTE is LEFT-joined, so a
  host with no group row reads NULL unless the declaration says what it reads.
- **The FORM phantom** (`decoded` / `json`) lets a consumer accept a field's
  JSON form (timestamps as ISO-UTC text) for a `jsonAgg` alone, never for a
  decoded aggregate.
- **`OuterColumnRef`**: a `jsonAgg` element field over a rollup column is
  `| null` whatever the table says.
- **Callbacks are method signatures** (compared bivariantly), so a join over
  one table is still assignable to `AllJoinSpec`.

### Rollup routes — a rollup is routed through its SOURCES

#### A35 — hop coverage

The failure it prevents: the hop (`via`) is read after commit, as the maintain
function reads it at trigger time. A write that moves or removes the hop row
(`UPDATE attempts SET task_id`, an RI cascade) resolves only its NEW keys —
the hosts under the old key keep a stale rollup value.

The fix is to require a source on the hop table that sees every re-key:

- its `carry` is the hop's `key`, so it re-aggregates and routes the old key
  too;
- the hop's `match` is in its pk ∪ `carry` ∪ `reads` — else
  `UPDATE … SET <match>` passes both the maintain function's diff and the
  route's column gate unnoticed;
- its `ops` include `update` and `delete`.

#### Uses and `derivedReads`

- **No `moves` on a membership use.** The reader's SQL reads rollup columns,
  not source ones, so no source column set describes a move. Each source
  route's own gate already skips a write the rollup ignores.
- **`derivedReads` is minted only when non-empty**, so a plan with no rollup
  keeps its shape (and the golden fixtures stay byte-identical).

### The `all` compiler — `compileAllCollection` (`server/internal/compile-alias.ts`, `grouped.ts`)

- **`LIMIT max + 1` only on full / orderIds.** The scoped refill and `:rows`
  name their hosts, so they are bounded already. An unbounded set's SQL, and so
  its definition, is unchanged by the bound.
- **Closure CTE uses `UNION`**: a cycle terminates, and a node in a cycle is
  its own ancestor.
- **Id casts.** The refill's ids come from the runtime (vouched for:
  `"throws"`); `:rows` ids come from the client (`"absent"`).
- **Grouped relations are never outer**: `ifNone` is what an empty group
  reads.
- **Unread grouped joins are refused** — an unread one would be joined and
  routed for nothing.
- **A37 (indexes).** The grouped CTEs and the dependents probe walk `fk` /
  `child` / `parent`; without a leading index each walk is a scan.

#### Scope — `all.by`

- **One loop emits all three halves** (SQL `eq`, identity-route `match`, the
  use's `match` + `moves`) because they must agree exactly: if the SQL and the
  route disagree, a change is routed to the wrong scope or to none.
- **The router skips another scope's tuple on the key match, before any
  load** — the point of scoping. The feed carries the match columns as keys,
  old ∪ new, and `moves` includes them, so a re-scoped row exits one tuple and
  enters another.
- **Column types are restricted** because the feed compares `col::text` to the
  param: a timestamp's or a float's text has more than one spelling, so a
  change could miss its own scope.
- **`validateParams` canonicalises** (lower-case uuid, canonical in-range
  decimal) so `col = $param` holds exactly when the key matches.
- **Only a scoped set names `by`**, so every other definition and route stays
  byte-identical.
- **Limit:** never persisted (no preload), so per-scope snapshots live only
  while a tuple is tracked.

#### Definition

- **Why fail-closed `describeZod`.** The definition must move whenever the
  rows could change; a part whose output depends on a function body cannot be
  hashed, so it is an `{ $opaque }` marker. A refinement is data (it never
  changes a value), so it is not opaque.
- **Limit — opaque column / row schemas are folded in, not refused.** The
  definition moves when the schema's shape does, but not when only a transform
  body does (a `tolerantEnum` column's `normalize`). Refusing them would rule
  out the tasks entities.
- **`wire.ids` must be non-empty**: `encodeRow` is code the definition cannot
  read, so the stable ids of its codecs stand in for it.

### Raw SQL — `server/internal/raw-sql.ts`, `QueryDb.execute`

- **Why raw at all.** drizzle's `unionAll` rewrites column chunks to bare
  identifiers, breaking expression order keys; it cannot render a recursive
  CTE.
- **`"absent"` via `pg_input_is_valid`**: an untrusted key a non-text pk
  cannot hold (`uuidarm:x` on a uuid arm) becomes absent instead of an
  invalid-input error that fails the whole statement.
- **Known gap, in full.** For a point reader, a reverse probe's `within` is the
  client's own `:rows` id set (the union's reverse wrapper decodes it straight
  to raw arm ids). A bad key is absent from the `:rows` load yet fails every
  probe of the looked-up table, and the probe's bounded readers — their
  `within` sets unioned — all recompute FULL. `within` only bounds the answer,
  so `"absent"` is its right policy.

### Reverse routes — a lookup's changes, resolved to hosts (P4)

- **One array param per list**, cast to the column's own type, so the
  column's index serves the probe and the statement is one shape whatever the
  count.
- **A10 — why reading host-side rows is complete.** The referencing column is
  still there whatever happened to the looked-up row (a deleted source's
  events still name it). A host row that moved its own key is a change of its
  own table, routed by its own route.
- **Why the probe skips the collection's predicates.** A default scope is per
  tuple, and a predicate reading the looked-up row must not filter the
  post-image — a disabled source's events are exactly the ones that must exit.
  Only a host-only static predicate could be ANDed in.
- **Limit:** hosts no tuple can hold count toward the cap, so a probe can go
  over-cap (readers FULL) on hosts nobody watches.
- **Grouping routes stay `full`**: a count has no hosts to resolve. A keyed
  side's `rows` selectors still keep a write to another scope's or member's
  rows from moving any count.

### Union collections — `compileUnionCollection` (`internal/compile-union-window.ts`)

- **`decode` strips the prefix once**: a raw id may itself contain `:`.
- **Static nullability, computed at bind**, so a cut and a signature never
  depend on which arms a tuple pruned.
- **Constant keys stay in the cut** (each operand cast to the column type):
  dropped from an arm's ORDER BY because they order nothing inside it, but the
  cut runs over the union, where they do.
- **Row key = the outer `u."__c<i>"::text`** — the union's own text, so every
  arm's keys are spelled alike.
- **An unknown kind in a point read is absent**, never a contract error: a
  client may hold a key of an arm that no longer exists.

### Join families — members joined per tuple (P3)

- **Alias escaping.** Every character outside `[A-Za-z0-9]` is spelled
  `_<hex>_`; past Postgres's 63-byte identifier limit the alias becomes
  `<id>___h<128-bit hash>`, a form no spelled alias can take. Postgres would
  otherwise truncate silently and merge two members.
- **Members are projected into `row[valuesKey]`** because the signature
  universe (`signatureColumns`) is static and members are not in it; the order
  signature reads them there.
- **Order memos key on the rendering.** A retyped member keeps its alias and
  column but reads through a new cast. Keyed by relation and column name, the
  memo would keep the old ORDER BY, `__family_<i>` projection and cut casts.
- **A cast member's cut casts through the expression's SQL type**
  (`JoinPlan.sqlTypeOf`), not the raw column's.
- **`recomputeOn`**: adding, dropping or retyping a column changes what every
  tuple's SQL reads, so the memoised read-sets are invalid.

## Bounded membership: `windowQueryResource` (window / point)

- **Why `orderBy` is `{ col, dir }` keys, not raw SQL.** The compiler appends
  the pk tiebreaker (a window must be a prefix of a strict total order),
  renders explicit `NULLS LAST`, and derives the keyset cuts from the same
  keys.
- **Why `limitOf` is required.** A window holding fewer rows than its limit is
  not full, so its exits need no `windowIdsOf` query. With `familyOf` it also
  lets the runtime seed a fresh tuple from rows other tuples of the same query
  hold.
- **Why the order signature.** Without it, a `createdAt` resurface refills the
  row in place and the wire window stays in the old order. The pk tiebreaker
  is excluded from it.
- **Per-tuple signature.** A playback write under a `title` sort stays on the
  in-place path; only tuples sorting by the written column pay the ids query.
- **Cost:** each order-column update is one O(window) ids query, so prefer
  mostly-stable order columns for very hot rows.
- **One key list per order** feeds the ORDER BY, the cuts and the row keys, so
  the three cannot disagree.
- **Cuts are ANDed after the `whereReads` check**, so a sortable-but-not-
  filterable column still takes cuts. Cuts read only order columns, which
  routes and signature already cover.
- **`window.limitOf` / `window.validateParams` seams** exist because a
  contributed collection decodes its params against the column sets it serves,
  which the descriptor's codec does not know.
- **`defaultLimit` only on the descriptor**: the client default and the boot
  default must be one number, so a preloaded window loads the identical tuple
  a bare `useLive(c)` subscribes to.
- **Spec types plus module-eval guards.** The two spec types make misuse a tsc
  error; the guards stay for an untyped caller, so a bad spec is a boot crash,
  never a silent misbehaviour.
- **Assemblers take exactly one arm** because the union and `all` compilers
  reuse only the routed half and render their own SQL.

## The `db` seam

Importing `db` never touches a worktree (the pool is built on the first
query), so the default needs no test env shim, and the static import the
boundary rules require costs nothing in tests.
