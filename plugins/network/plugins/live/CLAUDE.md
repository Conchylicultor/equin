# live

The unified live-resource API — design in
`research/2026-09-25-global-unified-live-resource-api.md` (grouping, preload and
the base `where`: `research/2026-09-25-global-live-bell-filter-groupby-preload.md`;
the filter language: `research/2026-09-25-global-unified-filter-language.md`).
**The default for a new DB-backed collection, and for a new value.**

## Usage

```ts
// core/ (browser-safe) — declare once
export const eventSources = liveCollection("events.sources", {
  row: EventSourceSchema,                // a zod OBJECT — its keys are the projection
  id: "id",
  filterable: { status: liveText(SourceStatusSchema), enabled: liveBoolean() },  // domain constructors
  sortable: ["createdAt", "name"],
  default: { orderBy: [["createdAt", "desc"]], limit: 100 },
  maxLimit: 500,
  preload: "none",                       // or "boot" — see Declare
});

// server/ — serve it; spread all three Resource.Declare entries
export const eventSourcesServed = serveCollection(eventSources, {
  from: _eventSources,
  // where: eq(t.dismissed, false)       — optional base membership (see Serve)
});
// contributions: [...eventSourcesServed.declare]

// web/ — read it
useLive(eventSources);                                                // default window
useLive(eventSources, { where: { enabled: true }, orderBy: [["name", "asc"]], limit: 50 });
useLive(eventSources, { where: or({ column: "status", op: "eq", operand: "error" },
                                  { column: "enabled", op: "eq", operand: false }) }); // a Filter tree
useLive(eventSources, { groupBy: "status", where: { enabled: true } }); // values + counts
useLive(eventSources, { count: true, where: { enabled: true } });     // a total (declared `count: true`)
useLive(eventSources, { ids: visibleIds });                           // point set
useLiveRow(eventSources, sourceId);                                   // one row (a null id: not found)

// the whole ordered set, for a set its readers need entire (see `all` below)
export const graphNodes = liveCollection("graph.nodes", {
  row: GraphNodeSchema,
  id: "id",
  all: { orderBy: [["createdAt", "asc"]], unbounded: { reason: "the graph view lays out every node" } },
  preload: "boot",
});
useLive(graphNodes);                                                  // every row, in order
useLive(graphNodes, { select: countNodes });                          // a slice of it (a stable selector)
```

- **Totals (`count: true`).** A window collection may declare `count: true`
  — its author's statement that a COUNT over it is cheap enough to keep live
  (recomputed on every write to a table it reads; leave it off a large or
  write-hot table). It mints `key:count`, read with `useLive(c, { count:
  true, where? })`. A DataView listing the collection as a live `source` reads
  it over the source's scope (never under a view filter or search) and shows
  exact section counts instead of "N+" before every page is loaded. Not on a
  union collection yet (a declaration error beside `arms`).
- **Declare.** The key is a positional string literal (the build scanners read it).
  One declaration mints three resources — `key` (window), `key:rows` (point) and
  `key:groups` (grouping) — and all three show in the docs; declared
  `count: true`, a fourth, `key:count` (see *Totals* below). Bounded by
  construction: `default.limit` and `maxLimit` are required, and a grouping returns
  at most the filter language's `LIST_MAX` (100) groups. The one unbounded
  spelling is a separate form, `all` (below), which must state its
  `unbounded: { reason }`. `row` is a zod object schema: its keys are what the server
  projects. `filterable` maps row fields to the filter language's DOMAIN
  constructors (`liveText(Schema)`, `liveNumber()`, `liveBoolean()`,
  `liveInstant()`, `liveStringArray()`); the domain must fit the row field's
  type (tsc), and `and` / `or` / `column` / `op` / `operand` cannot be column
  names (they spell a filter tree). As for a `liveValue`, a window, id set or
  grouping not loaded yet is `pending`, never `[]`.
- **Lookup-only.** Declared WITHOUT `default` — `liveCollection(key, { row, id })`
  — a collection mints `key:rows` alone: a table whose rows are only ever read by
  id (one row per mounted block: `todo-block-task`, `page-block-doc`). Every
  window field (`filterable`, `sortable`, `maxLimit`) and `preload` is `never`
  there (an id set has no default tuple), and a stray one from an untyped caller
  throws. It is `LiveLookupCollection<Row>`; `useLiveRow` and `useLive(c, { ids })`
  take it (they take `LiveRowsCollection<Row>`, the part every collection has),
  while a list read — `useLive(c)`, `{ where }`, `{ groupBy }` — is a tsc error.
  `serveCollection` compiles and registers only the point resource and returns
  `ServedLookupCollection` (`rows`, `keys: [key:rows]`, a one-entry `declare`).
  Its `:rows` point routing is what "subscribe to one row of a table" means: a
  change to row R reaches only the tuples whose id set holds R. Prefer it to a
  param'd value over a one-row table (`oneRow` routing was rejected — see
  `research/2026-09-26-global-live-values-migration-contract.md` §10).
- **The whole ordered set — `all`.** Declared with `all: { orderBy,
  unbounded: { reason } }` and no window field —
  `liveCollection(key, { row, id, all, preload? })` — a collection holds EVERY
  row, in `orderBy` (row fields; the id breaks ties), for a set small enough to
  hold whole whose readers need all of it (the task tree, a graph). It mints
  `key` — one param-less keyed resource (`AllQueryResourceContract`, minted by
  the internal `allResourceDescriptor`: no window codec, no `defaultParams`, no
  placeholder; any param is `contract-mismatch`; self-registered under `key`, so
  boot hydration resolves it) — and `key:rows`; no `:groups`. **The params gate
  is no skew signal for a param-less predecessor:** an older bundle that
  subscribed the same key with `{}` (the legacy `tasks`, `task-categories`) passes
  it, gets the new rows and parses them with ITS schema — a parse error, not a
  `skew` verdict, unless the two wire rows are identical. Each step converting
  such a key (P8 v3 steps 18–22) must prove the rows byte-compatible or give the
  runtime a contract signal it compares on a `{}` subscription (see the plan's
  *As landed → 16b.3*, C39 open item). `preload` reaches
  `key`. Every window and union field is `never` beside it (T13; `all?: never`
  on the other forms), and a stray one, an empty reason or order, an order field
  that is not a row field (or is named twice) throws. It is
  `LiveAllCollection<Row>` — with the lookup-only collection, one
  `LiveNoWindowCollection<Row, Al>` whose `all` is `undefined` for a lookup — so
  `useLiveRow` / `useLive(c, { ids })` take it and `serveCollection`'s
  lookup arm does not (tsc, and a throw against a cast). It is served by
  `serveCollection`'s `all` arm (*Serve* below) and read by `useLive(all[, {
  select }])` (*Read* below); the join kinds it reads are query-resource's
  `AllJoinSpec`.
  - **C39 — the old-bundle check.** `server/testing`'s
    `subscribeAsOldDescriptor({ key, schema }, { params?, build? })` answers
    what a tab still running a bundle that declared a key with a param-less
    legacy descriptor gets from the entry serving it now: `refused` (the
    sub-error's `reason` and resource-protocol `verdict`), `parsed` (the
    sub-ack's value under the OLD schema) or `parse-failed`. A key converted
    to `all` under the same name passes the gate with `{}` and is parsed with
    the old schema — so a converting step proves `parsed` with its old row
    schema, or renames the key (`unknown-key`, `skew`). Its synthetic cases are
    in `server/internal/serve-collection-all-oracle.test.ts`.
- **Preload.** `preload: "boot"` (or `"boot-and-keep"`) pins the owning plugin
  to the eager tier and hydrates one tuple before first paint. A window
  collection forwards it as is to the WINDOW descriptor, and the boot snapshot
  hydrates the default window (`defaultParams`). An `all` collection forwards it
  to `key`, which has no `defaultParams`: the boot snapshot hydrates its one
  param-less tuple `{}`. `"boot-and-keep"` also keeps that preloaded tuple's
  cache resident. `:rows` and `:groups` are never preloaded — the server cannot know a tab's id sets or
  grouping queries at boot. A declared `:count` preloads with the window, at
  its param-less `{}` tuple (the whole collection's total). Default `"none"`. The scanners read the flag through the resource
  vocabulary (`tooling/resource-vocabulary`: each factory names the field it
  spells its preload with, and each mint whether the flag reaches it).
- **Serve.** `serveCollection(c, { from, joins?, where?, columns? })` binds every ROW
  field to a column of `from` (a `PgTable`, or an Entity's wire columns) BY
  PROPERTY NAME — type-checked: a field that is not a column fails in `tsc` until
  it is given in `columns: { name: (j) => j.base.col }` (and throws at module eval
  if it still binds nowhere).
  - **Joins.** `joins: [songPlayback.join("playback"), lookup, keyedSide]`
    reads other tables beside `from` (the vocabulary, its routes and checks:
    `plugins/infra/plugins/query-resource/CLAUDE.md`, *Joins*). A joined column
    binds through an override, `columns: { lastPlayedAt: (j) => j.playback.lastPlayedAt }`
    — `j` offers only the base's and each declared join's WIRE columns, and an
    override returns one of them, so another relation, another table's column
    or a server-only column cannot be spelled (tsc); a `ColumnRef` naming a
    column of the wrong relation, or one `j` did not offer, throws. A joined
    field filters, sorts (in the order signature like any sortable field),
    groups and is wire-encoded (`withWire`) like a base one; the id binds to the
    base. A field read through a LEFT join is NULL for a host with no joined
    row, so its row schema field must accept null — module eval throws
    otherwise.
    Routing: a write to a joined table refills only the host rows it keys, and
    only in the tuples whose SQL reads the join — as `value` (projected only: a
    write to a row the tuple does not hold loads nothing) or `membership` (its
    where / order reads it, or a required lookup). A grouping joins only what its
    column and `where` read.
  - **Expression fields.** A field computed by SQL binds in `columns` too, over
    the same `j`: `label: (j) => expr(sql\`${j.base.title} || ' by ' ||
    ${j.artist.name}\`, { decoder: String, sqlType: "text", notNull: true })`
    (query-resource's `ExprField`: `j`'s refs render as their relation's
    defaulted wire columns). It projects, filters, sorts, cuts and groups like a
    column; its provenance (route columns, the joins it reads) is read off its
    SQL. Its value type must be the field's (tsc: the decoder's result,
    `| null` unless `notNull`), and it is never the id.
  - **The projection is derived from the row schema**: exactly its keys, so a
    server-only column (a dedup key, a secret) can never reach the wire.
  - **`where`** is the collection's base membership — the collection IS the rows
    of `from` matching it. It is ANDed into the window, the `:rows` point reads
    and every grouping. A mutable column is fine: a flip is a membership exit for
    a window tuple and a point tuple (the point refill omits the id), and a
    recount for the groups. A predicate over the joins is `(j) => …` over their
    rendered columns (`(j) => gt(j.playback.plays, 0)`), and makes each join it
    reads membership for every tuple. A table the predicate reads that is not the
    base or a declared join throws at module eval.
  - **`defaults`** — DEFAULT scopes: `[{ unless: "sourceId", where: (j) =>
    eq(j.source.enabled, true) }]`. Each predicate is ANDed into a window or
    grouping tuple UNLESS that tuple's filter names its `unless` column (any op) —
    a default the user overrides by asking about the column, not base membership
    (the events list hides a disabled source's events and soft-deleted ones, and
    a filter on `sourceId` / `disappearedAt` shows them). Written like `where`,
    checked like it (an `unless` that is not filterable throws), routed like it
    (its columns are route columns, and a join it reads is membership for the
    tuples it applies to); never ANDed into the `:rows` point read.
  - The window and `:rows` compile through `windowQueryResource`: the window
    decodes `where` / `order` per subscription tuple (the filter compiles
    through the filter language's `filterSql`, over each column RENDERED as SQL,
    never the column object) with every sortable column as the universe each
    tuple's order signature is cut from (a tuple signs only what it sorts by);
    the point sibling is
    `point: { by: <id column> }` with no client filter.
  - `:groups` is a plain (non-keyed) push value per grouping tuple, compiled by
    query-resource's `compileGroupsQuery`: `SELECT col AS value, count(*) …
    WHERE <base> AND <where> GROUP BY col ORDER BY count(*) DESC, col NULLS LAST
    LIMIT n`. A write to the table recomputes every subscribed grouping tuple
    (its `reach` plan: one `full` route on the table), a write to any other
    table reaches none, and push mode drops a byte-identical result. Each value
    is checked against the ROW schema's field (a group value is a stored value;
    an operand narrowing like `liveText(Enum)` is tsc-only), so a value the row
    type cannot hold fails loudly.
  - `:count` (declared `count: true`) is a plain push value per `where`,
    compiled by query-resource's `compileCountQuery`: the grouping's plan —
    the same `full` routes and per-tuple joins — rendered as `SELECT count(*)
    … WHERE <base> AND <defaults> AND <where>`, so it counts exactly the rows
    the window lists.
  - **All three are ROUTED** (research/2026-09-29-global-scoped-change-routing.md):
    each compiler emits the routes its SQL reads, and the runtime's
    `routeTableChange` serves them — never the loader read-set — so a change
    reaches exactly the tuples whose query reads the changed table. `from` is
    therefore a base table or an Entity, never a view (`CollectionSource`), and
    every table a collection reads must be triggered (the change-feed's boot
    assertion). Each route's columns are exact: the window declares the
    filterable columns and the base predicate as its `whereReads`, the grouping
    as its `reads`. The joined read-sets are pinned by
    `server/internal/serve-collection-joins.test.ts` (routes, roles, the
    provenance property over random params) and, on a real database through the
    real feed, `serve-collection-oracle.test.ts` (the differential oracle).
  - **A column type's wire form.** A column built through sql-column's
    `withWire` (collab-doc's `bytea` → unfolded base64) is encoded IN JS on every
    row a loader returns (`encodeRow` on the window / point spec) — never in SQL,
    whose `encode(…, 'base64')` folds lines at 76 chars. The row schema's field
    must BE the codec's wire type (plus `| null` for a NULL-able column): a
    mismatch on a by-name binding is a tsc error naming the field. A
    wire-encoded column cannot be filterable or the id (an operand, a group value
    and an id are compared as stored); that throws at module eval.
  - The served object exposes `window`, `rows`, `groups`, `keys` (all three
    minted keys — for anything that must know every reader of the table) and
    `declare`. `compileCollection` is the same derivation without registering
    (for tests), and also returns the derived `select`.
  - **The `all` arm** (`server/internal/serve-all.ts`; P8 v3 step 16b.6, C4).
    `serveCollection(c, { from, joins?, columns?, where?, throttleMs? })` over a
    collection declared `all` is checked FIRST — before the lookup-only branch,
    which would otherwise serve it as `:rows` alone — and compiled by
    query-resource's `compileAllCollection`: it registers the whole ordered set
    (`key`, a routed `scopedMembership` alias: an insert is one refill and one
    `orderOf`, a delete or where-flip an exit, an order-field move one
    `orderOf`, any other write a one-row refill, and a persisted one keeps its
    `{}` snapshot current with nobody subscribed) and `:rows`, returning
    `ServedAllCollection` (`all`, `rows`, `keys: [key, key:rows]`, a two-entry
    `declare`). Bound eagerly, never deferred. Fields bind like a window's —
    by property name, or in `columns` over `j` (`AllJoinRefs`): a column ref,
    an AGGREGATE of a children / closure join (`(j) => j.att.done`, its value
    type the field's, `| null` unless declared not-null — tsc) or an `expr`
    over either. A `jsonAgg` aggregate (its ref's form phantom is `json`) may
    instead hold the field's JSON FORM (a `Date` as its ISO string,
    recursively): it hands its elements back as the JSON the driver parsed,
    never decoded — byte for byte what the wire makes of the decoded value —
    and the client parses the field with the row schema either way
    (`attempts`' `conversations`, P8 v3 step 20). A scalar `aggregate` (form
    `decoded`) must hold exactly the field's type — its text form of a
    `timestamptz` is Postgres's, not ISO (tsc). `joins` takes `AllJoinSpec` (the window kinds, rollups,
    `childrenJoin`, `closureJoin`); `where` is static, over the base's and the
    row-wise joins' raw columns (`AllWhereColumns`), never an aggregate;
    `throttleMs` is the set's flush throttle (the runtime's `debounceMs`, C18).
    Refused at module eval: a cast that makes it `contributed`, `columnScope`d
    or a union (and contributed / scoped sets handed to `compileCollection`),
    a field that may read NULL on a non-null field, a ref `j` never offered,
    and a wire-encoded value (sql-column `withWire`, an `expr`'s `wire`) — an
    `all` set is L2-persisted and its definition cannot read an encoder's
    code. `compileCollection` takes it too (`AllCollectionSpecs`, nothing
    registered). Tests: `serve-collection-all.test.ts` (both keys registered,
    A28's runtime half — what each form registers is exactly what it minted —,
    every refusal, the types) and `serve-collection-all-oracle.test.ts` (the
    real feed, L2 hooks on: entrant, exit, where-flip, order move, value-only
    and child writes, each with its exact loads and `orderOf` calls; the idle
    `{}` snapshot and its floor persist; the C39 harness).
  - Hand-written loaders are out of scope for now — keep those on
    `windowQueryResource` / `defineResource`.
- **Read — `useLive(c, query?)`.** The query's SHAPE picks the resource; there is
  one hook for every list read, and a separate hook only where the result has
  different STATES (`useLiveRow`).
  - A window query returns `LiveListResult<Row>` — live-state's
    `PagedResourceResult<Row>`: `ResourceResult<Row[]>`
    (`status: "loading" | "error" | "ready"`, see `live-state/CLAUDE.md`) whose
    `ready` arm adds live-state's `ResourcePaging`: `canGrow` (`rows.length === limit && limit < maxLimit`),
    `growing` and `loadMore()` (grow by one default page, clamped to
    `maxLimit`). While a grown window loads the hook stays `ready` on the
    previous rows (`growing: true`) — the previous tuple stays subscribed only
    until the grown one has a value — so a list that already rendered never
    flashes a spinner. A grow that FAILS before its first value is the `error`
    arm with the previous window as `stale`. Each grow step is a new tuple;
    that is fine up to `maxLimit`.
  - A **grouping** — `{ groupBy, where?, limit? }` — returns the same
    `LiveListResult`, of `{ value: V | null; count: number }`. `groupBy` is any
    declared filterable column of a `text` / `number` / `boolean` domain, and
    `V` is the ROW field's type. Groups are ordered count descending, then value
    (code-point order); NULL is its own group, selected with
    `{ isEmpty: true }`. `orderBy` is a type error (the order is fixed). Default
    limit 50, max `LIST_MAX`;
    `canGrow` / `loadMore()` page through groups exactly like rows. `where`
    applies as given — to keep every chip visible while one is picked, leave the
    grouped column out of it.
  - A **total** — `{ count: true, where? }` — on a collection declared
    `count: true`: `ResourceResult<number>`, how many rows match `where`
    (see *Totals*). A `null` query (and collection) reads nothing (pending):
    a surface whose count is not cheap right now.
  - An `{ ids }` query reads the point sibling: `ResourceResult<Row[]>`, no
    paging fields.
  - **A collection declared `all`** — `useLive(all)` → `ResourceResult<Row[]>`,
    every row in the declared order; `useLive(all, { select })` →
    `ResourceResult<S>` (`LiveAllSelect`). Both read straight through
    `useResource` on the param-less tuple (the one boot hydrates) with no row
    map. A plain read hands React Query no selector, so its `data` IS the
    cached array: every observer shares it and its row objects (a per-snapshot
    memo such as a `WeakMap` keyed on the array hits across observers), it
    keeps its identity until a push changes the set, and a delta keeps every
    row it does not change — a row an `order` delta moves included (live-state's
    structural sharing keeps a reference the previous array held). Both are
    one gated read (`gate: true`, with or without a `select`), so a push that
    changes nothing they read re-renders nothing: the first value renders
    whatever the slice, a `select` re-renders only when its slice changes, and
    the derived latch makes a boot-hydrated read, plain or selected, render
    once (live-state CLAUDE.md, *Slice selectors*). Pass a stable selector. The
    overloads sit after the window and group ones; an id read of the set is
    `useLive(all, { ids })` / `useLiveRow(all, id)` on `:rows`. Pinned by
    `web/__tests__/use-live-all.test.tsx`.
  - Every query is identified by its canonical encoding, so inline object
    literals are fine. A list result (and its `loadMore`) keeps its identity
    until its rows, state or limit change, so a consumer may memoize on it.
- **Read — `useLiveRow(c, id: string | null)`.** `{ status: "loading" } |
  { status: "error"; error; stale? } | { status: "ready"; found: true; row } |
  { status: "ready"; found: false }`, every arm with `refetch`. A point read: it ignores every client filter and window bound (the
  base `where` still applies — a row outside the collection is not found), so
  `found: false` means the row is not in the collection — never "outside the
  window".
  - **A `null` id** (nothing to look up yet) is `{ status: "ready", found:
    false }` from the FIRST render, and reads nothing: the substrate's skip
    (`useResource(desc, null)` — no subscription, no HTTP read or cold-start
    prime, not a pending mount), the same one a value's `useLive(v, null)` uses
    (which, having no row to be absent, reads `loading`).
  - **An id the point codec cannot carry** — `""`, or one holding a `,` (the
    wire id set is comma-joined; `isPointId`) — is answered the same way:
    `found: false` from the first render, nothing read. No row is addressable
    by it, so it is a determinate miss, never the render error `encode` would
    throw. A reader handed an id from outside (a URL, a `[[page:…]]` token, an
    agent's tool input) renders its not-found state. `useLive(c, { ids })`
    still throws on one: an explicit set is the caller's to build.
- **Optimistic reads** are `optimistic-mutation`'s, over the same argument
  shapes: `useOptimisticResource(value, params?, options)` and
  `useOptimisticResource(c, { ids }, options)` (the `:rows` read — the queue's
  ranks). `loading` until a real value lands, never on a placeholder, and
  `dispatch` only on the `ready` arm — named by `status` like every read, with
  live-state's one named exemption: once a value has landed, a failing read
  stays `ready` and carries the failure as `error` (see live-state CLAUDE.md). The hook asks the server for standalone
  ack frames on its tuple (client-requested, per subscription), so a write
  that changes nothing in the tuple still confirms — nothing is declared here.
- `useLive` is on `live-state/no-pending-data-collapse`'s watched list
  (`useLiveRow` has no `data` to collapse), and both on `no-ready-negation`'s:
  never `status !== "ready"` — name `"loading"` and `"error"`.

## Paged collections — `scroll: true` / `useLiveCollectionPages`

A list that scrolls with no depth limit (a live DataView source) reads a
collection declared `scroll: true` as **key-range pages**: each page is one
bounded window tuple `(after, until]` at a `limit`, the pages tile the order by
server-minted cuts, and **liveness follows the viewport** — the pages near the
rows on screen are subscribed, the rest keep the rows they last held (stale).
Design: research/2026-10-09-global-live-key-range-pages-v2.md (P1: the plan,
the hook, the viewport and the reader swap; P2: the stale budget and its
placeholders; P3: seeded derivation).

- **Declare.** `scroll: true` needs `maxLimit ≥ 2 · default.limit` (a
  declaration throw): a page that splits is read at `2 · default.limit`, a step
  of headroom over the rows it holds. `maxLimit` bounds one page's `limit`; it is
  no depth bound. The collection is typed `LiveScrollCollection` (`scroll:
  true`), which is what `useLiveCollectionPages` and `liveDataSource` take.
- **`$key` — the server-minted row key.** Every full and scoped row of a scroll
  window carries `$key`: the canonical JSON array of the tuple's order keys as
  exact Postgres text (`col::text` — a µs `timestamptz`, a long `numeric`, a
  `float8` cross exactly), then the id (omitted when the order already names it).
  Over `LIVE_ROW_KEY_MAX_BYTES` (1 KiB, a long text sort key) it is `null`: no
  page can be cut there. It is declared on the window's wire schema only (never
  a row field, never on `:rows`), and every read hands rows out WITHOUT it
  (`useLive` and `useLiveCollectionPages` split it off, one copy per row object).
- **Cuts.** A window tuple may carry `after` (exclusive) and `until` (inclusive)
  — each a `$key` verbatim, never derived on the client (a decoded row lost the
  exact text). The codec refuses them on a collection not declared `scroll`, and
  decodes them strictly (exactly the order's arity, a non-NULL id, canonical
  JSON). The compiler renders them on the ORDER side over the tuple's own keys
  (keyset's `seekPredicate` / `atOrBeforePredicate`, each operand cast back to its
  column's type) — never through `where`, so a sortable-but-not-filterable order
  column takes cuts, and the routes and roles are those of the tuple without them.
- **`useLiveCollectionPages(c, query | null, { viewport, resetKey? })`** → `{ status:
  "loading" } | { status: "error"; error; refetch }` (the first page failed with
  no rows; `error` is that read's `ResourceError`, unwidened) `| { status:
  "ready"; rows; exhausted; canGrow; growing; loadMore; truncated; pageErrors;
  placeholders }`.
  The plan is pure data (`shared/page-plan.ts`, shared by the hook and the DB
  oracle); the hook reads one window tuple per LIVE page through live-state's
  `useResources(…, { release: "now" })` (subscribed by diff, a page leaving its
  band unsubscribed at once).
  - **`viewport: VisibleRange` is required and branded** (`web/internal/visible-range.ts`):
    `measuring` (liveness stays as it is), `none` (every page releases), or the
    first and last row on screen, by id. Only data-view mints one
    (`mintVisibleRange`), from the rows a DataView draws — enforced by the
    `live/visible-range-minter` lint (any import of the minter from this
    barrel; data-view's `exempt/index.ts` holds the one sanctioned entry). A
    surface reads pages through data-view's `useLivePagesPaging`, which hands
    out the read and the paging whose sink feeds its viewport together — so a
    reader with nothing measuring a viewport (a set reader, a count) cannot
    page: it reads one bounded window with `useLive`, which never widens past
    `maxLimit`.
  - **One structural operation: split a full page at a row's key.** `loadMore`
    splits the full last page at its last cuttable row: `(a, k]` at
    `2·default.limit` keeps its rows with headroom, and `(k, ∞)` at
    `default.limit` is the new page. A full page that is not last (inserts
    filled its headroom — it may be hiding rows) splits at its median cuttable
    key into two pages at `2·default.limit`. Two adjacent pages holding ≤
    `default.limit` rows between them merge (the cut between them dropped); an
    empty page always merges. Every structural step applies at once: each new
    page shows its slice of the rows it replaces (handed over, stale) until its
    own read lands, so the result never flips back from `ready`.
  - **Seeded pages — `loadMore` reads only the new page, a merge reads
    nothing.** A page a step mints whose whole range is a slice of the rows the
    pages it replaces hold carries a `seed` (`PageSeed`): the known part of a
    split — `(a, k]` of `loadMore`, an overflow's half up to its cut — and a
    merge of two pages neither full (each holds its whole range) sharing no
    row. The hook passes it to `useResources` as the tuple's `derive`
    (live-state's seeded derivation): the server answers from the snapshots it
    holds when the sources are pages of the same query (the codec's
    `familyOf`: the `where` and `order`, served as the window's
    `scroll.familyOf`) and quiescent at the version sliced — no load, a
    value-less `sub-ack` the client fills with its slice — and loads the tuple
    whole otherwise. The hook subscribes a seeded page before it releases the
    pages it replaces (`useResources` observes the new tuples first), so the
    server still holds the sources when the sub arrives. The unknown part — `loadMore`'s `(k, ∞)`, the half of an
    overflow past its cut (its page was full: it may hide rows) — is always
    read. A seed is read on the page's first subscribe only; a released page
    drops it.
  - **Liveness.** A page within one page of what is on screen is live; three
    or more pages away it is released (its rows kept, stale — it does not see a
    change until it is live again); two away it stays as it was (the band that
    keeps a back-and-forth scroll from churning subscriptions). A live page
    whose read has not answered yet (just minted) stays live until it does, and
    a read showing no row at all stays live (an empty list has no row to be
    seen by); a page whose read FAILED follows its band like any other
    (released with what it shows, retried in view). Live cost per reader is ≤
    visible pages + 4 (plus reads in flight), whatever the depth; there is no
    segment cap. A page released is unsubscribed AND its cached value dropped
    (live-state's `release: "now"`), so coming back it is pending — showing
    the rows it held — until the server vouches for a value again; a stale
    cache never passes for a settled read.
  - **The stale budget — placeholders.** The released pages of one read keep
    at most `8 · default.limit` rows between them (`PageLimits.staleRows`;
    `STALE_STEPS` in the hook), handed out walking away from the visible
    pages one page each side at a time (from the head when nothing is on
    screen). The first released page past it — and every page beyond it on
    that side, as does any page past one already DRAWN as a placeholder —
    drops its rows and becomes a PLACEHOLDER (`held: { kind: "placeholder",
    size }`, the count it held). "Drawn as" is read from what the page shows,
    not from `held`: a page subscribed again from a placeholder keeps that
    `held` until released, also once its read landed and it is drawn as rows,
    and it ends no side. What a read holds, and what a surface draws, is
    O(viewport + budget) whatever the depth: one placeholder element per far
    page.
    - **Drawn only at the edges.** The pages drawn as rows are one contiguous
      run (the core — the run holding the most live pages); every page outside
      it is a placeholder, so `placeholders: { before, after }` sit before and
      after `rows`, never between two rows (no view has an entry kind for
      that). A page holding rows past a placeholder (a read that landed out
      there) is drawn as a placeholder of their count until it joins the core.
    - **Never a value.** A placeholder carries a `key` (`placeholderKey(page)`,
      unique among row ids) and a row count — no row. Subscribed again, it
      stays a placeholder until its own read lands.
    - **Re-subscribed when seen.** A viewport names a placeholder by its key
      as it names a row by its id: on screen, its page is in the band and
      live again (as is its neighbour, ±1), and its rows replace it.
    - `exhausted` is false while any page is a placeholder (its rows are not
      held), and `canGrow` needs the last page drawn as rows.
  - **Dedup.** A row two pages hold (a sort-key move, between the frames of the
    page it left and the page it entered) is shown once: a live copy beats a
    stale one, and between two of the same kind the page whose value was
    APPLIED most recently wins — live-state's per-tuple `appliedSeq` — never
    "the later page", since a sort key can move a row backwards.
  - **`exhausted` / `canGrow`.** `exhausted` once every page knows its own rows
    and the last is not full. `canGrow` only on a LIVE, cleanly settled, full
    last page with a cuttable row: a stale last page never pages (`loadMore`
    re-subscribes it first). `truncated` is `{ reason: "long-sort-key" }` — a
    `PagesTruncation` KIND the surface words for its user, logged in the plan's
    own terms (`TRUNCATION_DETAIL`) — when the full last page has no cuttable
    row. A full page that is not last with no cuttable row COLLAPSES: the pages
    after it are dropped and it becomes the last page (one `clientLog` line),
    so no row is ever hidden between pages.
  - **Failures.** A page whose read fails keeps its rows and adds a `pageErrors`
    entry (`key`, `afterRowId`, `error`, `blocksPaging`, `retry` — which re-reads
    that page's tuple, never `loadMore`). `blocksPaging` marks the failure paging
    stopped on: the last page's own read, or — when the read can neither grow nor
    is exhausted, nothing is loading and no page is a placeholder — every
    failure. (A read with placeholders is held short by the viewport, not by
    a failure: its other failures stay notices over the rows.)
  - **Keys.** A plan is one collection's: its key is the collection's key and
    the query's encoding, so a surface switching collection starts over even
    when the two queries encode alike. A query changed and then changed back
    before the new head settled restores the plan still on screen.
  - **A `columns` change keeps the plan.** The column sets a query brings only
    name what its `where` / `orderBy` may read — they are not wire params, and
    every row carries the collection's whole projection (each contributor's
    `$columns` slice) whichever the query brings. So a change of them alone
    (a custom column added to the surface) keeps the plan, its cuts and its
    rows, re-reads nothing, and new pages encode with the new sets; no held
    row can lack a column the new query names. (A projection that varies per
    query — a follow-up — would re-read the live pages and turn the released
    ones into placeholders.)
  - **`resetKey`**: a query change under the same key keeps the previous rows until
    the new head settles (a search typed into a list); any other change starts over,
    loading. A `null` collection and query read nothing (a surface whose origin is
    not live still calls the hook, so its hook order is fixed).
  - **Logs.** The `live-pages` channel records the plan's shape as it changes
    (`pages=N live=M`), a collapse, and a read that stops short.
  - Pinned by `shared/page-plan.test.ts` (the plan against a simulated server:
    loadMore as a split, overflow, no cuttable key, the merge bound, the live
    band and its hysteresis, dedup on a backward move, contiguity, a stale last
    page's `canGrow`, the stale budget and its placeholders at the edges, a
    placeholder on screen subscribed again, random walks),
    `web/__tests__/use-live-collection-pages.test.tsx` (the hook over a real
    NotificationsProvider: placeholders past the budget, a `columns` change,
    a `loadMore` sent seeded, a merge seeded from both pages and an overflow
    split from its known half, each before the replaced pages' release),
    data-view's `web/__tests__/page-placeholders.test.tsx` (the DOM: height,
    anchoring, bounded on a deep scroll), and
    `server/internal/serve-collection-pages-oracle.test.ts` (the real feed:
    random writes, paging and viewport moves — live pages converge, no row twice,
    refills O(changed), a gap-free prefix once all are in view, a head-burst
    splitting past any cap; seeded, `loadMore` loads exactly `step` rows and a
    merge loads none).

## Contributed columns — `contributed: true` / `liveColumns` / `serveColumns`

A collection declared `contributed: true` can be sorted and filtered by columns
OTHER plugins own (Sonata's library by a song's play count). The set is open, so
the collection names none of them.

```ts
// the contributor's core — a handle, nothing registered
export const playbackColumns = liveColumns(songLibrary, "playback", {
  row: z.object({ playCount: z.number(), lastPlayedAt: z.coerce.date().nullable() }),
  filterable: { playCount: liveNumber() },
  sortable: ["playCount", "lastPlayedAt"],
});
// the contributor's server — a contribution, not a registry
contributions: [LiveColumns.Serve(serveColumns(playbackColumns, { join: songPlayback.join("playback") }))]
// web
{ id: "plays", value: (s) => playbackColumns.read(s).playCount, column: playbackColumns.column("playCount") }
```

- **Rows.** The row type is `Row & { $columns }`: the row schema declares
  `$columns` (a zod `extend`, so its keys stay readable); each contributed column
  is projected flat under its wire name (`<contributor>.<field>`), wire-encoded
  like any column (`withWire`), and folded into `$columns[contributor][field]`;
  `:rows` points carry it too (one row shape per collection). `handle.read(row)`
  parses a contributor's slice with its own schema, once per row object. A row
  always carries every contributor's slice.
- **Queries.** A query names a contributed column by wire name and hands the codec
  the handles it names (`LiveQuery.columns`); the server decodes against every
  handle it serves — its params gate too (the window spec's
  `window.validateParams`, replacing the descriptor's, whose decode knows no
  contributed or scoped column). There is no registry. A collection's own column cannot contain
  `.`. Groupings stay over the collection's own columns.
- **Serving.** `serveColumns(handle, { join, columns? })` — `join` is an
  EXTENSION join (`ext.join(alias)`: LEFT, 1:1 on the host's id — typed, and
  thrown on at compile for a cast), so a contributor can neither drop host rows
  (a required lookup's INNER join) nor change routing roles; a field binds to its
  join's wire column of the same name, or through `columns` (typed like
  `serveCollection`'s overrides). A `contributed` collection's `serveCollection`
  registers its three resources DEFERRED (`defineDeferredResource`: key, preload
  and `Resource.Declare` at module eval) and compiles them at
  `bindDeferredResources` — the boot step right after contributions are
  collected — folding every `LiveColumns.Serve` naming it. Boot fails on two
  contributions of one name and on a `Serve` for a collection nothing serves here;
  `liveColumns` itself refuses a collection not declared `contributed`.
- **The `live:contributed-columns-served` check**: every `const x =
  liveColumns(` handle has a `serveColumns(x` in its own plugin's `server/` —
  an unserved handle's columns reach no row. It reads whole files with comments
  and strings masked (a call wrapped over lines still reads), resolves a serve
  through the file's import aliases, ignores test code on both sides, and
  reports a `liveColumns(` call no `const` binds.
- **Defaults.** An extension column with a literal default reads it where the side
  row is missing (query-resource's `ReadColumn`: `COALESCE`), so a never-played
  song has `playCount = 0` in SQL — in a filter, a sort and the projection.
- **Custom columns** (data-view's user-defined columns) are the open-vocabulary
  twin of this seam: a *scoped* column set, below.

## Scoped column sets — `columnScope` / `LiveColumns.Scoped` / `scopedLiveColumns`

A collection declared with `columnScope: "<DataView id>"` sorts and filters by
columns whose SET is data, not code — the custom columns defined on that one
DataView surface (research/2026-09-29-global-scoped-change-routing.md P3).

- **Server** (the column set's owner — data-view's custom-columns):
  `LiveColumns.Scoped(serveScopedColumns({ name, table, scope, hostKey, member,
  value, members, recomputeOn }))` — one composite-keyed side table (scope, host
  key, member, value), `members(scope)` the members a scope has NOW (each's filter
  domain and, for a typed value, its cast and the SQL type it produces), and
  `recomputeOn(scope)` the external value tuple notified when they change.
  Collected at boot; every `columnScope` collection's `serveCollection` (deferred,
  like a `contributed` one) folds every contribution as a query-resource join
  FAMILY bound to its scope (`query-resource/CLAUDE.md`, *Join families*). The
  fold is the set's `bind(scope)`, which records the scope: `scopes()` is exactly
  the scopes served, which the owner watches to notify `recomputeOn(scope)`.
- **Wire names** are `<name>.<member>` (`custom.cc-1`). The server decodes a tuple
  against the members it has at decode time (a declaration rebuilt when they
  change); a member's value is read through its cast at LOAD time, so a retyped
  column reads its new type on the next load, and a member the scope lost fails the
  load loudly.
- **One route per set**, whatever its members: an alias on the host key, kept to
  the scope's rows, matched per tuple on the members its `where` / order names (as
  membership). A write to a member a tuple does not read, or to another surface's
  rows, reaches no tuple; the values table's routed trigger carries the key
  columns, so a write reaches only the hosts it names.
- **A member a tuple ORDERS BY** rides the window row under `$scoped`
  (`LIVE_SCOPED_KEY`, by join alias) — declared on the window's wire schema like
  `$key`, read by the order signature, split off by every read (`useLive`,
  `useLiveCollectionPages`). Values a list DISPLAYS still come from the custom-columns value
  (`customColumnValues`): only a sort / filter joins a member, so an unused column
  costs nothing.
- **`recomputeOn`**: the window's routed entry recomputes on each set's
  `recomputeOn(scope)` — a column added, dropped or retyped FULLs every subscribed
  tuple once (the runtime's routed `recomputeOn`).
- **Browser**: `scopedLiveColumns(scope, name, members)` declares the members as
  the browser knows them (built from the definitions each render) and mints their
  refs (`.column(member)`, whose owner is `{ kind: "scoped", scope }` rather than a collection). The codec
  takes a scoped set only on a collection whose `columnScope` is its scope. A
  DataView listing a scoped collection must BE its scope (its `storageKey` —
  asserted at mount), and hands the scope to its field extensions
  (`FieldExtensionProps.liveColumnScope`).

## Union collections — `arms` / `liveArmColumns`

A collection declared with `arms: { discriminator }` lists rows of several
KINDS — each served from its own table — in one window (the runs of every run
kind): `liveCollection(key, { row, id, arms: { discriminator: "kind" }, scroll:
true, filterable, sortable, default, maxLimit })`. Its id is the union row key
`kind:raw` (query-resource's `armKeyCodec`).

- **The overload (T12).** `scroll: true` is required (a union is listed as a
  live DataView); `contributed` and `columnScope` are `never` — a union's
  column vocabulary is its arms' static handles. The discriminator is a row
  field (tsc) other than the id. An untyped caller's stray field throws. The
  collection is `LiveArmsCollection` (`arms` set); every single-table
  collection is `arms: null`, which is what `serveCollection` takes (a union
  is a tsc error there, and throws against a cast).
- **Rows** carry `$columns` like a contributed collection's: each arm's OWN
  columns under `$columns[<arm>]`.
- **`liveArmColumns(collection, arm, { row, filterable, sortable })`** declares
  one arm's own columns in the arm's core: wire names `<arm>.<field>`;
  `read(row)` is `null` for another arm's row, parses its own slice once per
  row object, and THROWS on its own arm's row with no slice (A16 — a server
  that did not fold the arm is a bug, never "no values").
- **Owners (T11).** Every column set's declaration carries an `owner` —
  `contributed` (`liveColumns`), `scoped` (`scopedLiveColumns`) or `arm`
  (`liveArmColumns`) — and a column ref's owner adds `own`. The codec, data-view's
  field resolution and the server switch on it exhaustively, so a codec takes
  an arm set only on its own union, a contributed set only on its
  `contributed` collection, a scoped set only in its scope.
- **Serve — `serveUnionCollection(c, { arms: () => UnionArmBinding[] })`**
  (P6 of `research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md`). Each
  binding is one arm: its column set (`columns`, a `liveArmColumns` handle —
  its arm IS the kind), its table and single-column primary key (`from`, `id`),
  its `joins`, `base(j)` (every base field but the id and the discriminator →
  a column ref, an `ExprField`, or `null` for "no such notion"), `extra(j)`
  (exactly its column set's fields) and an always-on `where(j)`. A domain
  types this through its own facade (`runs`' `defineRunKind`, T9).
  - **Deferred.** `arms` is read once at `bindDeferredResources` (arms register
    in the register phase), and the three resources compile there — before
    anything serves and before the change feed rebuilds triggers from routes.
  - **The compile** is query-resource's `compileUnionCollection` (its CLAUDE.md,
    *Union collections*): per-arm positional SQL, static nullability over every
    arm, the row key `kind:raw` as the total order's tiebreaker, each arm routed
    as a single-table compile is and re-keyed by `compiledUnionRoutePlan`.
  - **Filter targets.** In an arm a field's target is its read; on another
    arm's rows a typed `NULL`; the discriminator is the arm's kind as a literal.
    The decode is strict over the static set of the arms' column sets.
  - **Arm pruning** (`armsOf`): a clause reachable from the root through AND
    groups only, over an arm CONSTANT (a typed NULL, or the discriminator), is
    answered once by the op's own `testClause`; `false` prunes the arm — no SQL,
    no routes in `usesOf`. A negative op or `isEmpty` keeps it (NULL satisfies
    it). Groupings prune the same way.
  - **Rows on the wire.** The compiler names the row back (the key field and
    the discriminator are its own projections), and `encodeRow` folds the row's
    own arm columns into `$columns[<kind>]` (wire codecs applied per arm); the
    order signature reads an arm column off `$columns`.
  - Bind-time throws: a binding naming a field that is not a base field (or
    missing one), an arm column with no binding, a read that may be NULL on a
    non-nullable field, two arms of one kind, a set owned by another
    collection. The DB oracle is `server/internal/serve-union-oracle.test.ts`
    (real triggers: arm-`where` flips, `pid` writes loading nothing, a lookup
    rename under and over the reverse cap, retention and cascade deletes,
    raw ids containing `:`). The byte pin is
    `server/internal/compile-union-golden.test.ts`. It checks every shape's
    SQL, routes and folded rows for a fixed four-arm union against
    `server/testing/compile-union-golden.json`. Regenerate the fixture from
    the code before a refactor, with
    `./singularity run plugins/network/plugins/live/server/testing/gen-compile-union-golden.ts`
    (query-resource's CLAUDE.md, *Bounded membership*).

## Values — `liveValue` / `serveValue` / `useLive(value)`

Design: `research/2026-09-25-global-live-values.md`. A value is ONE payload per
params tuple, pushed whole whenever it changes (a count, a status, a detail
object). Anything row-shaped that grows is a collection.

```ts
// core/ — declare
export const notificationsUnread = liveValue("notifications.unread", {
  schema: NotificationsUnreadSchema,     // z.object({ errors, warnings })
  preload: "boot",                       // "none" (default) | "boot" | "boot-and-keep"
});
export const pluginChanges = liveValue("review.plugin-changes", {
  schema: PluginChangesSchema,
  params: ["conversationId"],            // → P = { conversationId: string }
  // load: "on-demand",                  — opt out of push (slow loader; tabs refetch over HTTP)
});
export const configValues = liveValue("config-v2.values", {
  schema: ConfigValuesSchema,
  params: ["path", "scopeId?"],          // → P = { path: string; scopeId?: string }
  preload: "boot-and-keep",              // a param'd preload: the server names the tuples
});

// server/ — serve
export const unreadServed = serveValue(notificationsUnread, {
  source: "db",                          // or "external" (then .notify(params?))
  loader: countUnread,                   // (params: P) => Promise<T> | T
});
// contributions: [...unreadServed.declare]

// server/ — a param'd preload names its boot tuples
export const configValuesServed = serveValue(configValues, {
  source: "external",
  loader: ({ path, scopeId }) => resolve(path, scopeId),
  preloadParams: () => [{ path: "a" }, { path: "a", scopeId: "app:x" }],
});

// web/ — read
useLive(notificationsUnread);            // ResourceResult<T>
useLive(pluginChanges, { conversationId });  // params required iff declared
useLive(pluginChanges, id === null ? null : { conversationId: id });  // no subject yet: skipped, pending
```

- **Declare.** The key is a positional string literal (the scanners read it).
  `params` is a const tuple of names; `P` is derived from it (no phantom
  generic to restate). There is **no `initial`**: not known yet is `loading`,
  never a stand-in — no descriptor carries a placeholder (an optimistic read of
  a value is `useOptimisticResource(value, params?, options)`, loading until the
  first value — see below). `live: "value"` is the discriminant `useLive`
  dispatches on.
  - **An optional param** is declared with a trailing `?` (`"scopeId?"` →
    `scopeId?: string`); the descriptor records the bare names in `params` and
    the optional ones in `optionalParams`. An optional param is present iff it
    is a non-empty string: `canonicalParams` (`packages/canonical-params`, one
    copy for the browser and the resource runtime) drops an `undefined`
    or `""` one wherever params enter the substrate — `useResource`'s entry (the
    subscription, the HTTP fallback URL, the prime, the query key),
    `hydrateResource`, `useOptimisticResource` — and the resource runtime does
    the same on the server (every incoming frame, the HTTP read, `notify`,
    each mapped `recomputeOn` tuple), as does `preloadParams` — so
    `{ path }`, `{ path, scopeId: undefined }` and `{ path, scopeId: "" }` are
    ONE tuple, and a notify can never miss the tuple a read holds.
  - **Typed params.** `params` may instead be a record of string parsers —
    `params: { window: z.enum(LATENCY_WINDOWS) }` → `P = { window: "1h" | … }`,
    so `useLive(v, { window: "2h" })` and the loader's argument are typed by
    each parser's OUTPUT. Every typed name is required. A parser may only
    NARROW the wire string: its output must be a `string` (tsc — `z.number()`
    is an error), and the declaration throws on a `ZodEffects` (transform,
    preprocess, refine), `ZodDefault` or `ZodCatch` anywhere inside it, on a
    string check that rewrites the value (`.trim()`, `.toLowerCase()`,
    `.toUpperCase()`), and on a parser that accepts `undefined`. The names
    must be literal keys (tsc — a record typed `Record<string, …>` is an
    error, since `useLive` would read it as param-less). So the loader
    receives the wire tuple itself, unchanged.
  - **The params gate.** The descriptor's `validateParams` (run by the runtime
    on the canonical tuple, before a sub registers) refuses an unknown name, a
    non-string value, or a missing REQUIRED name as `contract-mismatch`; an
    absent optional param is valid. A typed param is also parsed: a refusal is
    `contract-mismatch` too, and a parser whose result is not the wire string
    (one that slipped past the declaration walk) throws a plain Error — the
    backstop. The gate stays `void`: the runtime keys and loads the tuple as
    sent.
  - **The default tuple.** A param-less preloaded value sets
    `defaultParams: {}`, the tuple both the boot snapshot and `useLive(v)` use.
    A PARAMETERIZED value has none, so it is branded
    (`preloadsParams: true`, `LivePreloadedParamValue`) and its `serveValue`
    must pass `preloadParams: () => P[] | Promise<P[]>` (tsc, and a throw at
    serve time for an untyped caller; any other value may not pass it) — see
    Preload below.
- **Load (delivery mode).** `load` defaults to `"push"` (the value is
  recomputed and pushed); `"on-demand"` is the runtime's `invalidate` — the
  server never ships the value over the socket, and each tab reads it over
  HTTP (on mount, and again after every `invalidate`). It is declared on the
  `liveValue`, never on `serveValue`, because BOTH halves act on it: the
  server picks its mode from it and `useResource` enables the HTTP read from
  it. Declared once, they cannot disagree (when `load` was a serve option the
  client waited forever for a sub-ack value the server never sent).
- **Preload.** `"boot"`: hydrated by the boot snapshot before first paint
  (settled on the first render), the owning plugin pinned eager, and a
  DB-backed param-less one L2-persisted. A parameterized one is an ENUMERATED
  preload: the boot snapshot loads every tuple its `preloadParams` names — the
  loader alone per tuple, through the resource's own `load` (no flight, no
  commit watermark, no profiler span: nothing compares these values
  causally) — ships them under `tuples[key]`, and the client hydrates each; it
  is never L2-persisted (an L2 row is one param-less tuple per key). Enumerate
  exactly what first paint reads: every tuple is loaded on every page load.
  A central value is never preloaded. `"boot-and-keep"`: the same, plus the
  client cache is never garbage-collected (`gcTime: Infinity`, for every tuple
  of the key, hydrated or observed) — for small values read
  by surfaces that mount late.
- **Serve.** `source` is required and says where the truth lives:
  - `"db"`: the loader's read-set is captured at the DB pool chokepoint; a change
    to any table it read recomputes every subscribed tuple (full recompute, no
    scope policy — a keyed payload is a collection). No `notify`, at runtime
    too.
  - `"external"`: truth outside Postgres; the served value has `notify(params?)`.
  - **The bound rule is a type:** a `"db"` value whose type is an array or a
    string-indexed record must pass `unbounded: { reason }` (recorded on the
    served value and shown in the docs), and nothing else may. An external
    array is bounded by the process holding it.
  - Returns `ServedValue` = the runtime `Resource` + `source` + `unbounded?` +
    `keys` (`[key]`) + `declare` (a 1-tuple — spread it like a collection's);
    the external arm adds `notify`. `compileValue` is the same derivation
    without registering, and `shared/compile-value.ts`'s `registerValue`
    registers it on any runtime (tests use their own).
  - **`throttleMs`** (both arms): at most one flush per window — the first
    change arms a trailing timer later changes do not re-arm (the runtime's
    `debounceMs`, which was always a throttle). A flush already happening
    drains it early.
  - **`recomputeOn: [served, { value: served, params: (up) => P }]`** (both
    arms): upstream served values whose change recomputes this one. A bare
    served value recomputes **every currently-subscribed tuple** of this value
    (the runtime's `toSubscribed` edge — it tracks them, so the hand-kept
    "active set" filled by `onFirstSubscribe` is gone); a param-less value
    always recomputes its `{}` tuple, so its version moves even with no tab
    subscribed. The mapped form is one per-tuple edge; `params` is typed
    against that upstream's params (the array is a const tuple, inferred per
    element). It compiles to the runtime's value-aware `map`, so every notify
    of the upstream computes the upstream's value even with nobody subscribed
    to it — prefer one notify fan-out over a mapped edge for values that move
    together (config's documents, conflicts and tiers).
  - **`whileSubscribed(params, notify?) → stop | Promise<stop>`**: start
    something for as long as a tuple has a subscriber, return what stops it —
    one function, so a start without its stop cannot be written. The external
    arm is handed `notify` for that tuple; the db arm gets `params` only (tsc).
    Paired in `shared/compile-value.ts` over the runtime's 0→1 / N→0 hooks: an
    async start is awaited on the subscribe path, and a last unsubscribe that
    arrives first runs the stop after the start resolves. A failed start has
    nothing to stop (the runtime reports it). Nothing watches the source between
    a stop and the next start, and nothing needs to: the runtime opens every
    subscription span with a fresh version, so a tab reconnecting after the gap
    never gets `up-to-date` for a value it read before it (`resource-runtime/CLAUDE.md`).
  - **`revalidate`** (both arms): the ETag signature, passed through
    (read path only; co-produce it with the loader, e.g. `createSignedMemo`).
  - **A refused question is `ResourceRefusal`.** A loader that cannot answer
    well-formed params as asked (an unknown id, an empty range) throws
    `ResourceRefusal` (`packages/resource-protocol`; subclass it per domain).
    The reader's error arm is `kind: "refused"` with the server's message
    (`ResourceErrorInline` shows it, offers no Retry); it is never retried,
    never counted as a failing read and never reported as a server failure.
    Anything else a loader throws is `loader-failed`, reported.
  - Not spelled: `ackChannel` (an optimistic reader asks for acks on its own
    subscription), a read-side `select`, row-scoped `recomputeOn` edges (an
    upstream's change recomputes whole tuples) — see
    `research/2026-09-26-global-live-values-migration-contract.md`.
- **Central.** `liveValue(key, { …, origin: "central" })` declares a value the
  machine-wide central runtime serves (`LiveValue<T, P, "central">`; the browser
  subscribes over the central socket; never preloaded). It is served by
  `network/live/central`'s `serveValue` — external arm only (central has no
  change feed), registered by the central plugin's `resources: [served]`, so no
  `declare`. Each `serveValue` rejects the other origin's value (tsc). Both
  compile options through `shared/compile-value.ts`, so they cannot drift.
- **Read.** `useLive(value, params?)` → `ResourceResult<T>` (it delegates to
  `useResource`, which canonicalizes the params). A value with no
  placeholder makes no HTTP fetch on mount — the WS sub-ack fills it (the
  query stays disabled until a value lands; `refetch()` still works).
  - **No subject yet — `useLive(value, null)`** (a param'd value only — tsc):
    the read is `{ pending: true, error: null }` for as long as the params are
    `null`, and NOTHING is read — no subscription, no HTTP read or prime, and
    it is not a pending mount (the page is not waiting on the server for it).
    A value whose subject has not arrived is not known yet. A subject that
    will NEVER arrive (a missing registration, a legacy record with no id) is
    a settled answer: the caller renders it or throws — it never leaves a
    `null` read spinning. The old workaround, a `""` stand-in
    (`{ id: x ?? "" }`), subscribed a real tuple the server loaded for nothing;
    the `live/no-sentinel-param` lint rejects it at a `useLive` /
    `useLiveRow` call.

## Typed-query values — `liveValue(key, { query })`

Design: `research/2026-10-09-global-live-structured-paged-values.md` §1. A
value whose question is STRUCTURED — a range union, a tz, a split or compare,
typed params — declares a zod `query` schema instead of `params`:

```ts
// core/
export const metricQuery = liveValue("metrics.query", {
  schema: MetricResultSchema,
  query: MetricQuerySchema,      // any JSON-safe zod schema
  load: "on-demand",
});
// server/ — every hook takes the DECODED question
export const metricQueryServed = serveValue(metricQuery, {
  source: "external",
  loader: (q) => runQuery(q),
  whileSubscribed: (q, notify) => watch(q.metric, notify),
});
metricQueryServed.notify(q);     // recomputes that question's one tuple
// web/ — the question is the schema's INPUT (defaults optional)
useLive(metricQuery, query);     // ResourceResult<T>; null reads nothing
```

- **Wire.** One param, `{ q }`: the canonical JSON (`canonicalJson`,
  `packages/canonical-params` — keys sorted at every depth, non-JSON refused)
  of the schema's PARSED value, so `{}` and `{ x: <its default> }` are one
  tuple. Everything below the declaration (the runtime, WS frames, the HTTP
  fallback's URL, tuple keys, ETags, the query cache) still sees
  `Record<string, string>`. The descriptor is `LiveQueryValue<T, Q, QIn>`
  (`live: "value"`, `params: ["q"]`) carrying its codec as `query`
  (`core/internal/query-value.ts`) — the ONE codec the params gate, `useLive`
  and the served half (`shared/compile-value.ts`) use.
- **The gate is strict.** `q` must be the only key, parse as JSON, pass the
  schema, and re-encode byte-identically (`canonicalJson(parsed) === q`) —
  else `contract-mismatch` (`ResourceContractError`). The equality is what
  makes one question one tuple, and it refuses a schema whose parse is not
  idempotent (a transform that moves its own output: every read of it is a
  mismatch) without walking the zod tree. A refinement passes.
- **Size.** `LIVE_QUERY_MAX_BYTES` (2 KiB) on the encoded `q`: encoding past it
  throws (a plain `Error`, at the read), and the gate refuses it. A question
  that big is a request body, not a tuple.
- **Types (tsc).** `query` excludes `params` and `preload` (no default tuple);
  `origin: "central"` is allowed. `useLive(v, query | null)` is chosen by the
  descriptor's `query`; `useLive(v)` without it, or with a `{ q }` wire tuple,
  is an error. The serve overloads type the loader, `whileSubscribed`, a
  mapped `recomputeOn` and `notify` over the decoded `Q` (`ServeValueOptions<T,
  Q, Src>`); `compileQueryValue` is `compileValue` for this form.
- A changed question is a new tuple: the read shows loading. An
  `invalidate` (on-demand) refetch keeps the previous answer on screen.

## Paged values — `liveValue(key, { query, paged })`

Design: same plan, §2. A read paged by an EXTERNAL source's opaque cursor (git,
a file archive, a provider's own paging) is a chain of live pages — every
loaded page its own tuple, each invalidated and refetched on its own. A paged
Postgres list is a `liveCollection` (`scroll: true`), never this.

```ts
export const metricDetails = liveValue("metrics.details", {
  query: DetailsSelectorSchema,  // the question, without cursor / limit
  paged: {
    item: DrillItemSchema,
    id: "id",                    // dedupe across page boundaries (a string field — tsc)
    meta: z.object({ total: z.number() }),  // optional: a per-question fact page 0 carries
    limit: 50,                   // page size; the read may ask a smaller first page
  },
  load: "on-demand",
});
serveValue(metricDetails, {
  source: "external",            // the only arm (a "db" paged value is a tsc error)
  loader: (q, { cursor, limit }) => ({ items, nextCursor, meta: { total } }),
  whileSubscribed,               // per PAGE tuple
});
useLive(metricDetails, selector, { first: 5 }); // → LivePagesResult<Item, Meta>
```

- **One page, one tuple** `{ q, n, c? }`: the question, the page size and the
  server's cursor (absent on the first page). The wire schema is derived —
  `{ items: item[], nextCursor: string | null, meta }` — so a paged value
  declares no `schema`. The gate also checks `n` (canonical decimal, `1..limit`)
  and `c` (non-empty, ≤ `LIVE_PAGE_CURSOR_MAX_BYTES` = 1 KiB). The served
  loader's page is checked against its tuple: more than `n` items, or a
  `nextCursor` the next tuple could not carry, fails loudly.
- **`notify(q)`** recomputes every page of that question a tab holds right now
  — `shared/compile-value.ts` tracks the subscribed page tuples per `q` from
  the runtime's own 0→1 / N→0 hooks.
- **The chain** is pure data (`shared/page-chain.ts`, the cursor twin of
  `shared/page-plan.ts`); `web/internal/use-live-pages.ts` reads it through
  live-state's `useResources`. Page 0 is `{ q, n: first ?? limit }`; page k+1
  is `{ q, n: limit, c: page_k.nextCursor }`, minted only by `loadMore()`.
  - **Re-mint.** A refreshed page whose `nextCursor` moved re-mints its
    successor from it; the page it replaces stays read and rendered until the
    new one settles (the key-range pages' handoff), so the chain never flips back to
    loading. A page that now answers `nextCursor: null` drops the pages after
    it.
  - **Dedupe** by `id`, first occurrence kept (data that shifted across a
    boundary). `meta` comes from page 0.
  - **Cap.** `MAX_LIVE_PAGES` (32): `canGrow` false, `truncated: true`.
- **Result** `LivePagesResult<Item, Meta>` = live-state's
  `PagedResourceResult<Item>` with `meta` (ready arm; error arm when known) and
  `truncated`. A failed page is the error arm with every item already held as
  `stale`; a changed question (or `first`) starts over, loading; `null` reads
  nothing.
- Not spelled: preload, limit growth, a paged `"db"` value.

## Old spellings — lint `no-legacy-resource-spelling`

Contributed by `lint/` (repo-wide), beside `live/no-sentinel-param` (a `""`
stand-in for a param that has not arrived — see Values → Read). It flags every
import of an old spelling
from the barrel that exports it — named or aliased, `export { … } from`, or a
read off the barrel's module object (a namespace import or an awaited
`import()`, by member or by destructuring, resolved through scope):
`resourceDescriptor`,
`keyedResourceDescriptor`, `queryResourceDescriptor`,
`windowQueryResourceDescriptor`, `pointQueryResourceDescriptor`,
`defineResource`, `defineExternalResource`, `queryResource`,
`windowQueryResource`, `useResource` — and `usePointResource(s)` and
`useWindowResource`. Several no longer exist: `resourceDescriptor`,
`usePointResource(s)`, `useWindowResource`, `keyedResourceDescriptor`,
`queryResourceDescriptor` and `queryResource` are deleted, and
`windowQueryResourceDescriptor` /
`pointQueryResourceDescriptor` are internal to `network/live`
(`core/internal/window-descriptor.ts`) — all still listed so a stale import is
told its replacement, not only tsc's "no exported member". Its exemptions
(`exempt/index.ts` of the plugins that hold them) are the substrate only —
the plugins that define the old spellings or are compiled onto them
(`./singularity exempt list --rule live/no-legacy-resource-spelling`); no
debt entry remains. **Never add an entry for new code** — declare it with
`liveValue` / `liveCollection`. A file-level entry whose file no longer
imports an old spelling is reported `(unused-exemption)` by the type-check
worker (`framework/tooling/exempt`), so a stale one cannot linger.

**Request/response reads — lint `live/no-endpoint-read`.** In `web/` code
(tests out of scope) it flags `useEndpoint`, `useEndpointResource`, TanStack's
`useQuery` / `useInfiniteQuery` / `useSuspenseQuery` (and their
`Suspense*` / `useQueries` siblings) — resolved like the rule above — and a
`fetchEndpoint(...)` call inside a `queryFn` property. A server read is a
`liveValue` (`params`, a typed `query`, or `paged`) or a `liveCollection`, read
with `useLive`; an imperative `fetchEndpoint` (a mutation, a handler) is a
write and is not flagged. Sanctioned: the substrate that defines or wraps these
hooks (`infra/endpoints`, `primitives/live-state`, `network/live`,
`primitives/cursor-pagination`). Every other current site is a file-level
`debt` entry (task-1791560308-woqgfi) in its plugin's `exempt/index.ts`
(`./singularity exempt list --rule live/no-endpoint-read --debt`): migrate,
never add one.

## Internals

- `core/` (browser-safe): `liveCollection(key, { row, id, filterable, sortable, default, maxLimit, preload? })`
  (or `{ row, id }` alone — lookup-only, minting `` `${key}:rows` `` only; or
  `{ row, id, all, preload? }` — the whole ordered set, minting `key` through
  the internal `allResourceDescriptor` (`core/internal/window-descriptor.ts`) and
  `` `${key}:rows` ``, no `:groups`)
  mints three resources from one declaration — `key` (window membership),
  `` `${key}:rows` `` (point membership) and `` `${key}:groups` `` (a plain push
  value; one wire schema for every column's values — any scalar or NULL — with
  the per-column check done by the server). `row` / `rowKeys` are the row
  schema and its keys. The window descriptor carries the
  query codec: `window.encode(query)` → wire params, `window.decode(params)` →
  `{ limit, where, orderBy }` (`where` a canonical `Filter` or `undefined`); the
  groups descriptor carries `groups.encode` / `groups.decode`
  (`{ groupBy, limit, where }`).
- **Filtering is the filter sub-plugin** (`plugins/filter`, see its CLAUDE.md):
  domains, the one op table (in-memory test + SQL template side by side), the
  `Filter` tree, its canonical form, strict codec, `matchesFilter` and the
  server's `filterSql`. Negative ops (`ne notIn neCi notContains hasNone
  isNotEmpty`) are complements — they KEEP NULL rows. Operands are checked
  against the DOMAIN, so a stale enum operand decodes and matches nothing. No
  clock ops. Its parity suite runs every op both ways against a real Postgres.
- `LiveWhere` is either the per-column object sugar — an AND of clauses, each a
  plain value (= `eq`) or exactly one `{ op: operand }`, a no-operand op spelled
  `{ isEmpty: true }` — or a `Filter` tree (`and(...)` / `or(...)` of
  `{ column, op, operand }` clauses). Both canonicalize through
  `canonicalizeFilter` / `encodeFilter` to the same tree and bytes; the sugar is
  reshaped in `core/internal/query-codec.ts`, every check is the language's.
  `useLive`'s query param is `NoInfer`, so a tree is checked against the
  collection's own declaration.
- String ordering is code-point order in memory; in SQL it is the cluster's
  collation, which is `C` (initdb `--no-locale`) — the language's parity suite
  pins it, and the groups' value tiebreak relies on it.

## Wire params

- Window: `{ limit: string; where?: string; order?: string; after?: string;
  until?: string }` — `where` is the filter language's `encodeFilter` output
  (e.g. `{"column":"enabled","op":"eq","operand":true}`), `order` canonical
  JSON, `after` / `until` a page's cuts (server-minted `$key`s,
  verbatim); each present only when it differs from the default, so the default
  window stays byte-identical `{ limit: "100" }`.
- Groups: `{ groupBy: string; limit: string; where?: string }` — `where` is the
  same encoding, present only when not the absent filter.
- `all`: `{}` — the set has no query, so it has one tuple; any param is a
  `contract-mismatch` (`ResourceContractError`). An `all` collection's `:rows`
  takes the point params like any other.
- Typed-query value: `{ q: string }` — the question's `canonicalJson`. Paged
  value: `{ q: string; n: string; c?: string }` — plus the page size and the
  server's cursor (absent on the first page).
- Decode is STRICT for all of them: the filter through `decodeFilter` (throws
  unless exactly canonical), the rest by re-encoding — so one logical query
  can never name two subscriptions.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Unified live-resource API, read half: useLive (a collection's bounded window — where/orderBy/limit with canGrow/growing/loadMore — a grouping of a filterable column's values with counts, paged the same way, a collection declared `all` whole — every row in its declared order, or a select-scoped slice of it — or an explicit id set), useLiveRow (one row: loading, failed, found, or determinately absent), with mapRow reducing a row read to a ResourceResult of what the row means; useLive also reads a typed-query liveValue (its question encoded to one canonical tuple) and a cursor-paged one (a live chain of pages — re-minted when a boundary moves, deduped by id, capped at MAX_LIVE_PAGES); and useLiveCollectionPages (a scroll collection read with no depth limit as key-range pages — bounded windows tiling the order by server-minted row-key cuts, split when full and merged when small, the pages near a measured viewport live and the rest held stale up to a per-reader budget, past which they are height-keeping placeholders drawn before and after the rows). Unified live-resource API, server half: serveValue (a liveValue's loader, from Postgres — change-feed driven, a collection-shaped payload must declare `unbounded: { reason }` — or from an external source with notify(); pushed by default, or refetched over HTTP when the liveValue declares `load: "on-demand"`; a typed-query value's hooks and notify take the decoded question, and a cursor-paged one — external only — is loaded one page at a time, notify(q) reaching every subscribed page) and serveCollection (binds a liveCollection's row fields to a table's columns — the projection is exactly the row schema — ANDs an optional base `where` into every read, and compiles its window + `:rows` point resources through windowQueryResource and its `:groups` GROUP BY push value — only `:rows` for a lookup-only collection, and the whole ordered set (`key`, a routed scopedMembership alias compiled by compileAllCollection) + `:rows` for one declared `all` — encoding a column type's declared wire form in JS per row; a `contributed` collection compiles at boot, folding every LiveColumns.Serve contribution naming it — serveColumns(handle, { join }) — into its rows' `$columns`); every filter compiles through the filter language's filterSql. Unified live-resource API, central half: serveValue for a liveValue declared `origin: "central"` — the external arm only (central has no change feed), registered through the central plugin's `resources: [served]`; its options compile through the same code as the worktree serveValue.
- Web:
  - Uses:
    - `primitives/live-state.PagedResourceResult`
    - `primitives/live-state.ResourceDerivation`
    - `primitives/live-state.ResourceDescriptor`
    - `primitives/live-state.ResourceError`
    - `primitives/live-state.ResourceResult`
    - `primitives/live-state.ResourceTupleResult`
    - `primitives/live-state.useResource`
    - `primitives/live-state.useResources`
    - `primitives/log-channels.clientLog`
  - Exports (types):
    - `LiveAllSelect`
    - `LiveCollectionPageError`
    - `LiveCollectionPagePlaceholder`
    - `LiveCollectionPagesOptions`
    - `LiveCollectionPagesQuery`
    - `LiveCollectionPagesResult`
    - `LiveIdsQuery`
    - `LiveListResult`
    - `LivePagesOptions`
    - `LivePagesResult`
    - `LiveRowResult`
    - `PagesTruncation`
    - `VisibleRange`
  - Exports (values):
    - `mapRow`
    - `MAX_LIVE_PAGES`
    - `mintVisibleRange`
    - `useLive`
    - `useLiveCollectionPages`
    - `useLiveRow`
- Server:
  - Uses: 25 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `infra/query-resource` ×22
    - `database/sql-column` ×2
    - `network/live/filter.filterSql`
  - Exports (types):
    - `AllCollectionSpecs`
    - `AllWhereColumns`
    - `CollectionSource`
    - `CollectionSpecs`
    - `ColumnOverride`
    - `CompiledValue`
    - `DefaultScope`
    - `LiveValueSource`
    - `LookupCollectionSpecs`
    - `ScopedMemberRead`
    - `ServeAllCollectionOptions`
    - `ServeCollectionOptions`
    - `ServedAllCollection`
    - `ServedCollection`
    - `ServedColumns`
    - `ServedExternalQueryValue`
    - `ServedExternalValue`
    - `ServedLookupCollection`
    - `ServedPagedValue`
    - `ServedScopedColumns`
    - `ServedValue`
    - `ServePagedValueOptions`
    - `ServeUnionOptions`
    - `ServeValueOptions`
    - `UnionArmBinding`
    - `UnionArmColumns`
    - `UnionArmRefs`
    - `UnionFieldBinding`
  - Exports (values):
    - `compileCollection`
    - `compilePagedValue`
    - `compileQueryValue`
    - `compileValue`
    - `LiveColumns`
    - `serveCollection`
    - `serveColumns`
    - `serveScopedColumns`
    - `serveUnionCollection`
    - `serveValue`
- Core:
  - Uses:
    - `infra/query-resource.KIND_RE`
    - `network/live/filter.decodeFilter`
    - `network/live/filter.encodeFilter`
    - `network/live/filter.Filter`
    - `network/live/filter.Filterable`
    - `network/live/filter.FilterScalar`
    - `network/live/filter.LIST_MAX`
    - `packages/canonical-params.canonicalJson`
    - `packages/resource-protocol.ResourceContractError`
    - `primitives/live-state.PointParams`
    - `primitives/live-state.registerResourceDescriptor`
    - `primitives/live-state.ResourceDescriptor`
    - `primitives/live-state.ResourcePreload`
    - `primitives/live-state.WindowParams`
    - `primitives/live-state.WindowSelector`
  - Exports (types):
    - `ContributedColumns`
    - `LiveAllCollection`
    - `LiveAllOrder`
    - `LiveAllSpec`
    - `LiveArmColumnsHandle`
    - `LiveArms`
    - `LiveArmsCollection`
    - `LiveArmsSpec`
    - `LiveCentralValueSpec`
    - `LiveCollection`
    - `LiveCollectionOf`
    - `LiveCollectionSpec`
    - `LiveColumnFilter`
    - `LiveColumnRef`
    - `LiveColumnRefOwner`
    - `LiveColumnsDeclaration`
    - `LiveColumnsHandle`
    - `LiveColumnsOwner`
    - `LiveContributedCollection`
    - `LiveCountCodec`
    - `LiveCountDescriptor`
    - `LiveCountedCollection`
    - `LiveCountParams`
    - `LiveCountQuery`
    - `LiveCutKey`
    - `LiveDecodedCountQuery`
    - `LiveDecodedGroupQuery`
    - `LiveDecodedQuery`
    - `LiveFilterable`
    - `LiveFilterableOf`
    - `LiveGroup`
    - `LiveGroupableColumn`
    - `LiveGroupableDomain`
    - `LiveGroupCodec`
    - `LiveGroupParams`
    - `LiveGroupQuery`
    - `LiveGroupsDescriptor`
    - `LiveGroupValue`
    - `LiveLookupCollection`
    - `LiveLookupSpec`
    - `LiveNoWindowCollection`
    - `LiveNoWindowSpec`
    - `LiveOrderBy`
    - `LivePage`
    - `LivePageCodec`
    - `LivePagedSpec`
    - `LivePagedValue`
    - `LivePagedValueSpec`
    - `LivePageParams`
    - `LivePageRequest`
    - `LiveParamValueSpec`
    - `LivePlainValue`
    - `LivePreload`
    - `LivePreloadedParamValue`
    - `LivePreloadedParamValueSpec`
    - `LiveQuery`
    - `LiveQueryCodec`
    - `LiveQueryParams`
    - `LiveQuerySchema`
    - `LiveQueryValue`
    - `LiveQueryValueSpec`
    - `LiveReservedColumn`
    - `LiveRowSchema`
    - `LiveRowsCollection`
    - `LiveScopedColumns`
    - `LiveScrollCollection`
    - `LiveSortDirection`
    - `LiveTypedParamValueSpec`
    - `LiveTypedValueParams`
    - `LiveValue`
    - `LiveValueOrigin`
    - `LiveValueParamParsers`
    - `LiveValueParams`
    - `LiveValueSpec`
    - `LiveWhere`
    - `LiveWhereObject`
    - `LiveWindowBounds`
    - `LiveWindowCodec`
    - `LiveWindowDescriptor`
    - `LiveWindowParams`
    - `ScopedColumnMember`
    - `WithContributedColumns`
  - Exports (values):
    - `isLivePageCursor`
    - `isPointId`
    - `LIVE_COLUMNS_KEY`
    - `LIVE_PAGE_CURSOR_MAX_BYTES`
    - `LIVE_QUERY_MAX_BYTES`
    - `LIVE_ROW_KEY`
    - `LIVE_ROW_KEY_MAX_BYTES`
    - `LIVE_SCOPED_KEY`
    - `liveArmColumns`
    - `liveCollection`
    - `liveColumns`
    - `liveValue`
    - `scopedLiveColumns`
- Cross-plugin:
  - Imported by: 181 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×51
    - `conversations` ×35
    - `tasks` ×24
    - `active-data` ×11
    - `infra` ×10
    - `page` ×10
    - `debug` ×8
    - `build` ×6
    - `primitives` ×5
    - `auth` ×3
    - `review` ×3
    - `config_v2` ×2
    - `release` ×2
    - `apps-core/app-usage`
    - `backup/runs-arm`
    - `database/query-deadline`
    - `fields/secret/config`
    - `integrations/google-maps`
    - `plugin-meta/plugin-health`
    - `reports`
    - `runs`
    - `shell/notifications`
    - `stats/responsiveness`
    - `ui/icons/sprites`
- Exemptions:
  - Exempts itself from:
    - `live/no-legacy-resource-spelling` — `.` (sanctioned)
    - `live/no-endpoint-read` — `web` (sanctioned)
  - Exempted by:
    - `active-data/plugin-link` (2 debt)
    - `apps-core/surface/floating/wallpaper` (1 debt)
    - `apps/deploy/analytics/dashboard` (1 debt)
    - `apps/events/events-core` (1 debt)
    - `apps/file-explorer/browser` (4 debt)
    - `apps/file-explorer/git` (1 debt)
    - `apps/file-explorer/places` (2 debt)
    - `apps/mail/reading-pane` (1 debt)
    - `apps/mail/search` (1 debt)
    - `apps/pages/history` (1 debt)
    - `apps/pages/page-tree` (1 debt)
    - `apps/studio/compositions/closure-tree` (1 debt)
    - `apps/studio/compositions/release/release-logs` (1 debt)
    - `apps/studio/contributions` (1 debt)
    - `apps/studio/contributions/tables/columns` (1 debt)
    - `apps/studio/contributions/tables/foreign-keys` (1 debt)
    - `apps/studio/contributions/tables/indexes` (1 debt)
    - `apps/studio/contributions/tables/row-count` (1 debt)
    - `apps/studio/contributions/tables/sample-rows` (1 debt)
    - `apps/studio/explorer` (1 debt)
    - `build/build-commits` (1 debt)
    - `build/build-fix` (1 debt)
    - `build/build-info` (1 debt)
    - `build/build-logs` (1 debt)
    - `build/build-profiling` (1 debt)
    - `build/deployment` (1 debt)
    - `build/serve-composition` (1 debt)
    - `code-explorer/commit-detail` (2 debt)
    - `code-explorer/file-resolve` (1 debt)
    - `config_v2/settings` (4 debt)
    - `debug/boot-profile` (2 debt)
    - `debug/broadcasts` (1 debt)
    - `debug/config-orphans` (2 debt)
    - `debug/health-monitor` (1 debt)
    - `debug/heap-snapshot` (1 debt)
    - `debug/live-state-churn/emit` (1 debt)
    - `debug/live-state-health` (1 debt)
    - `debug/memory` (1 debt)
    - `debug/profiling/boot` (1 debt)
    - `debug/profiling/build` (2 debt)
    - `debug/profiling/runtime` (1 debt)
    - `debug/profiling/stats` (1 debt)
    - `debug/read-set` (1 debt)
    - `debug/slow-ops/pane` (1 debt)
    - `debug/trace/pane` (2 debt)
    - `framework/central-core` (0 debt)
    - `framework/resource-runtime` (0 debt)
    - `framework/server-core` (0 debt)
    - `history/dialog` (1 debt)
    - `infra/claude-cli` (1 debt)
    - `infra/endpoints` (0 debt)
    - `infra/query-resource` (0 debt)
    - `network/live` (0 debt)
    - `page/place` (1 debt)
    - `plugin-meta/composition` (1 debt)
    - `plugin-meta/plugin-view` (1 debt)
    - `plugin-meta/plugin-view/file-tree` (1 debt)
    - `primitives/cursor-pagination` (0 debt)
    - `primitives/data-view` (0 debt)
    - `primitives/diff-view` (1 debt)
    - `primitives/file-viewer` (3 debt)
    - `primitives/file-viewer/image` (1 debt)
    - `primitives/folder-picker` (1 debt)
    - `primitives/live-state` (0 debt)
    - `primitives/optimistic-mutation` (0 debt)
    - `review/code-review` (1 debt)
    - `search/quick-find` (1 debt)
    - `stats/commits` (4 debt)
    - `stats/cost` (8 debt)
    - `stats/pushes` (3 debt)
    - `stats/tasks` (2 debt)
    - `tasks/reports-investigation` (1 debt)
    - `tasks/task-attachments` (1 debt)
    - `tasks/task-category` (1 debt)
    - `tasks/task-events` (1 debt)
    - `ui/theme-engine/saved-themes` (1 debt)
    - `ui/tweakcn/community-browser` (1 debt)
- Central:
  - Exports (types):
    - `CentralServedQueryValue`
    - `CentralServedValue`
  - Exports (values): `serveValue`
- Test helpers:
  - Server: `@plugins/network/plugins/live/server/testing`
    - `compileCollection` — Derive the specs for a collection — three, or just `rows` for a lookup-only one.
    - `compileUnion` — Derive a union collection's three server halves.
    - `subscribeAsOldDescriptor` — Subscribe `old.key` on the server runtime as an old bundle's tab would — its own socket, `params` (default `{}`: a legacy param-less descriptor sent nothing), its `build` graph when given — and answer what that tab gets: the first `sub-ack` or `sub-error` for the tuple, the ack's value parsed with the OLD schema.
    - Types: `OldDescriptor`, `OldSubscription`
- Sub-plugins:
  - **`filter`** — The filter language's SQL half: renderOpSql renders one op's dialect-free template over a rendered target (operands as params cast to the domain's SQL type, lists as ONE array param), and filterSql…

<!-- AUTOGENERATED:END -->
