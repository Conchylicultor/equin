# live

The unified live-resource API — design in
`research/2026-09-25-global-unified-live-resource-api.md` (grouping, preload and
the base `where`: `research/2026-09-25-global-live-bell-filter-groupby-preload.md`;
the filter language: `research/2026-09-25-global-unified-filter-language.md`).
**The default for a new DB-backed collection, and for a new value.**

## Design rule — grow `useLive`, don't add APIs

- A new way to read server data is an **option on `liveValue` /
  `liveCollection` that `useLive` reads** (overloaded by the descriptor's
  type) — never a new hook or a new read function.
- A new hook needs a recorded reason in the research doc that introduced it
  ("`useLive` cannot express X because …").
- Existing exceptions: `useLiveRow` is pending unification into `useLive`
  (follow-up `task-1791751944-3ej507`, after the endpoint-reads migration —
  `research/2026-10-11-global-endpoint-reads-onto-live.md`);
  `optimistic-mutation`'s `useOptimisticResource` is a read+write hook.

## Usage

```ts
// core/ (browser-safe) — declare once
export const orders = liveCollection("shop.orders", {        // an illustrative collection
  from: ordersEntityRef,                 // the entity the rows are (or an extension shape)
  pick: ["status", "paid", "total"],     // the fields a list shows — each labelled, each filterable in its domain
  carry: { pick: ["id", "createdAt"] },  // on the row, in no list (see *Fields*)
  id: "id",
  sortable: ["createdAt", "total"],
  default: { orderBy: [["createdAt", "desc"]], limit: 100 },
  maxLimit: 500,
  preload: "none",                       // or "boot" — see Declare
});

// server/ — serve it; spread all three Resource.Declare entries
export const ordersServed = serveCollection(orders, {
  from: _orders,
  // where: eq(t.dismissed, false)       — optional base membership (see Serve)
});
// contributions: [...ordersServed.declare]

// web/ — read it
useLive(orders);                                                      // default window
useLive(orders, { where: { paid: true }, orderBy: [["total", "asc"]], limit: 50 });
useLive(orders, { where: or({ column: "status", op: "eq", operand: "refunded" },
                            { column: "paid", op: "eq", operand: false }) }); // a Filter tree
useLive(orders, { groupBy: "status", where: { paid: true } });       // values + counts
useLive(orders, { count: true, where: { paid: true } });             // a total (declared `count: true`)
useLive(orders, { ids: visibleIds });                                 // point set
useLiveRow(orders, orderId);                                          // one row (a null id: not found)

// the whole ordered set, for a set its readers need entire (see `all` below)
export const graphNodes = liveCollection("graph.nodes", {
  carry: { fields: graphNodeFields },    // own fields no list shows
  id: "id",
  all: { orderBy: [["createdAt", "asc"]], unbounded: { reason: "the graph view lays out every node" } },
  preload: "boot",
});
useLive(graphNodes);                                                  // every row, in order
useLive(graphNodes, { select: countNodes });                          // a slice of it (a stable selector)

// one tuple per scope: the rows whose `by` fields equal the tuple's params
export const blocks = liveCollection("page.blocks", {       // an illustrative collection
  from: blocksEntityRef, pick: ["id", "pageId", "rank"], id: "id",
  all: { by: ["pageId"], orderBy: [["rank", "asc"]], unbounded: { reason: "one page's blocks" } },
});
useLive(blocks, { where: { pageId } });                               // one page's rows, in order
useLive(blocks, { where: { pageId }, select: headings });             // a slice of one page
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
  `unbounded: { reason }`. A collection declares its FIELDS (*Fields* below):
  its row schema — whose keys are exactly what the server projects — and the
  filter domains of its listed fields are derived from them. There is no
  other spelling: the `row` / `filterable` / `exposes` one is deleted (fields
  declared once, phase 2b), and an untyped caller still spelling it throws. As for a `liveValue`, a window, id set or
  grouping not loaded yet is `pending`, never `[]`.
- **Lookup-only.** Declared WITHOUT `default` — `liveCollection(key, { from:
  shape, id })`, `{ carry: { fields }, id }` — a collection mints `key:rows` alone: a table whose rows are only ever read by
  id (one row per mounted block: `todo-block-task`, `page-block-doc`). Every
  window field (`sortable`, `maxLimit`) and `preload` is `never`
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
  `liveCollection(key, { …fields, id, all, preload? })` — a collection holds EVERY
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
  - **Scoped — `all: { by }`.** `all: { by: ["pageId"], orderBy, unbounded }`
    holds every row OF ONE SCOPE per tuple: `key`'s params are exactly the
    `by` fields (`AllQueryResourceContract<Row, B>`, params
    `{ [K in B]: string }`), each a non-empty string — `{}`, a missing, extra
    or empty key is `contract-mismatch`. It is `LiveAllCollection<Row, B>`, a
    different type from the param-less set (neither is assignable to the
    other), read `useLive(c, { where: { pageId }[, select] })`. `by` names
    row fields (tsc), non-empty, each once, never the id (throws). `preload`
    is `never` beside it (and throws): a scope is named by a reader, so boot
    has no tuple and the set is never L2-persisted. `:rows` stays global (by
    id, whatever the scope). Served from Postgres only — the external arm
    refuses one (its scope compiles to SQL and route matches); a wire-encoded
    field is still refused as for the whole set. The compile (query-resource,
    *The `all` compiler*) checks each `by` field binds a base column of
    text, uuid or integer type, and the server gate admits only that type's
    canonical text, so the router's key match is the SQL's `col = $param`:
    a write to another scope's row reaches no tuple of this one before any
    load, a move between scopes is an exit in one and an entrant in the
    other. Tests: `core/internal/live-collection.test.ts` (the declaration),
    `server/internal/serve-collection-all.test.ts` (serve, the gate, the
    types), `server/internal/serve-collection-all-scoped-oracle.test.ts`
    (two scopes over the real feed: another scope's write costs 0 loads and
    0 frames, an insert one refill + `orderOf`, a move an exit and an
    entrant, a delete no load, an over-cap statement FULL for both),
    `web/__tests__/use-live-all.test.tsx` (the read and its types).
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
  cache resident. `:groups` is never preloaded — the server cannot know a
  tab's grouping queries at boot — and neither is `:rows`, with one exception:
  `serveCollection(c, { preloadRows: { idsOf: other } })` preloads it at ONE
  tuple, the id set of `other`'s boot value (`other` declared `all` and
  preloaded — a serve-time throw otherwise), for a reader whose id set IS that
  set (the queue reads the ranks of the live conversations). The tuple is
  derived server-side from `other` as the boot snapshot ships it (its kept
  in-memory snapshot in the same tick, else its loader) and encoded by the
  point codec, so the reader's tuple is canonically the preloaded one; an
  enumerated preload (`tuples[key]`), never L2-persisted. A declared `:count` preloads with the window, at
  its param-less `{}` tuple (the whole collection's total). Default `"none"`. The scanners read the flag through the resource
  vocabulary (`tooling/resource-vocabulary`: each factory names the field it
  spells its preload with, and each mint whether the flag reaches it).
- **Serve.** `serveCollection(c, { from, joins?, where?, columns? })` binds every ROW
  field to a column of `from` (an Entity's wire columns, or the table a
  `defineEntity` built) BY
  PROPERTY NAME — type-checked: a field that is not a column fails in `tsc` until
  it is given in `columns: { name: (j) => j.base.col }` (and throws at module eval
  if it still binds nowhere).
  - **A served collection reads the entity it is `from`.** `from` is
    `ServedSource` — an Entity, an extension handle, or the `EntityTable` a
    `defineEntity` built (a type-only brand): a raw `pgTable` is a tsc error,
    so the table behind a list always has an entity. At serve time
    `assertServesItsRows` (`server/internal/collection-source.ts`) throws
    unless the collection's `rowsFrom` (its declared `from`) names the table
    it reads — an entity ref by name, an extension shape by the served
    extension's wire schema — so a collection over a table never restates its
    entity's fields: it picks them (`from: ref, pick`), and its own `fields`
    are only what it computes or decodes (a stored rank key carried as the
    wire `Rank`). A collection declared by its own fields alone is served
    from outside Postgres (`source: "external"`) or is a union. A union arm
    is held to the same rule (`served.arm` takes an `EntityTable` and throws
    unless `liveArm({ from })` names it). `compileCollection` /
    `compileUnion` — test derivations — take any table.
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
    WHERE <base> AND <where> GROUP BY 1 ORDER BY count(*) DESC, 1 NULLS LAST
    LIMIT n` — the value named by its ordinal, so a column that is an
    expression with bound parameters (an exposed field's `COALESCE(col,
    $absent)`) renders once. A write to the table recomputes every subscribed grouping tuple
    (its `reach` plan: one `full` route on the table), a write to any other
    table reaches none, and push mode drops a byte-identical result. Each value
    is checked against the ROW schema's field (a group value is a stored value;
    an operand narrowed by an enum field is tsc-only), so a value the row
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
    `declare`) — `ServedAllCollection<Row, B>` for a scoped set, whose `all`
    takes its scope params and whose server gate replaces the descriptor's
    (it adds each value's canonical-text check). Bound eagerly, never deferred. Fields bind like a window's —
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
    Refused at module eval: a cast that makes it `columnScope`d or a union
    (and scoped sets handed to `compileCollection`),
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
  - **The external arm — `source: "external"`** (`core/internal/serve-on.ts`'s
    `serveCollectionOn`, which the Bun `serveCollection` delegates to and any
    other host — central, a browser server — calls on its own runtime). Rows
    that live OUTSIDE Postgres (an in-memory list, a demo pack, a provider)
    are served through the same minted descriptors, so `useLive` reads them
    unchanged. The source answers each minted resource by hand, over the
    DECODED question:

    ```ts
    export const ordersServed = serveCollection(orders, {
      source: "external",
      changes: "notified",                    // or { immutable | fixed: { reason } }
      window: (q) => store.window(q),         // { limit, where?, orderBy, after?, until? } → rows
      rows: (ids) => store.byIds(ids),        // any order; a missing id is absent
      groups: (q) => store.groups(q),         // optional — `:groups` is not served without it
      count: (q) => store.count(q.where),     // exactly when declared `count: true` (tsc)
      keyText: { total: (n) => pad(n) },      // a non-text sortable field's `$key` text (tsc: required)
    });
    ordersServed.notify({ ids: ["o1"] });     // or notify(): every subscribed tuple
    // contributions: [...ordersServed.declare]
    // an `all` collection: { source, changes, all: () => rows, rows }
    // a lookup-only one:   { source, changes, rows }
    ```

    - **What it compiles to** (all through `defineExternalResource`, never
      routed — D31): the window is the runtime's external keyed window
      (`limitOf` / `familyOf` off the collection's own codec, so a page is
      seeded like a table's); `:rows` the external point arm (`idsOf`
      the point codec's decode); an `all` set's `key` an external window as
      wide as the set (its contract is keyed, so it cannot be a plain value);
      `:groups` and `:count` plain external push values. Bound eagerly; the
      Bun arm adds one `Resource.Declare` per registered resource.
    - **Every answer is checked**, a violation a loud loader error naming
      the key and the field: each row against the row schema (and projected
      onto exactly its keys, as a table's), a string id, no id twice, at most
      `q.limit` rows; `rows(ids)` only ids asked; a group's value against its
      row field, a positive count, count descending, at most `q.limit`; a
      count a non-negative integer. Every window's rows are minted `$key`
      by the paged value's own check (`mintRowKeys`): each order field's
      TEXT (a text field is its own; any other sortable field needs
      `keyText.<field>`, a tsc requirement — its code-point order must be its
      order, as `key.of` for a paged value), then the id unless the order
      names it; the rows must be in strictly ascending key order and inside
      `(q.after, q.until]`. The source owns `where` and the order (it is
      handed both decoded), and the order is checked on every window.
    - **`notify(change?)`** (`"notified"` only — tsc, and absent at
      runtime on `{ immutable | fixed }`; never a snapshot): with no change,
      every subscribed tuple of every minted resource re-reads; with `{ ids
      }`, a `:rows` tuple re-reads only when its id set holds one of them,
      while every window, `all`, `:groups` and `:count` tuple still does — a
      changed row may enter or leave any of them, and only the source could
      say which. Each re-read is diffed by key (a keyed delta; an unchanged
      tuple ships an empty one). The subscribed tuples are tracked from the
      runtime's 0→1 / N→0 hooks, so nothing is re-read for a tuple nobody
      holds.
    - **An exposing collection** (`exposes`, from `from` / `related`) is
      served: its `$columns` is the fold of the exposures served on THIS
      host, as the SQL arm's is — and an external host serves none, so the
      arm adds `$columns: {}` to every row (each exposed field then reads
      its declared default). The source answers `ExternalSourceRow<Row>`,
      the row WITHOUT `$columns` (tsc; a row carrying one throws), so no
      source ever spells another plugin's slice. A native fold
      (`serveExposure` on a browser server, or the server halves on
      PGlite) is the track's later step.
    - **Refused** (tsc where a type tells it apart, and a throw): a union
      collection (its rows fold several tables), a `columnScope`
      collection (throw only), a stray answer for the form (`window` on a
      lookup, `count` without `count: true`), and an empty `changes`
      reason. Tests: `core/internal/serve-on.test.ts`.
- **Collection rows are marked.** Every row a collection read hands out
  (`useLive(c)` window / pages / `all` / `{ ids }`, `useLiveRow`) is typed
  `CollectionRow<Row>` (`core/internal/collection-row.ts`): an optional,
  type-only key, assignable wherever a `Row` is and kept by a spread. A
  DataView's hand-`fields` arm takes `NotCollectionRow` rows only, so a list
  over a collection's rows derives its fields (`collection=`) instead of
  restating them.
- **Read — `useLive(c, query?)`.** The query's SHAPE picks the resource; there is
  one hook for every list read, and a separate hook only where the result has
  different STATES (`useLiveRow`).
  - A window query returns `LiveListResult<Row>` — live-state's
    `PagedResourceResult<Row>`: `ResourceResult<Row[]>`
    (`status: "loading" | "error" | "ready"`, see `live-state/CLAUDE.md`) whose
    `ready` arm adds live-state's `ResourcePaging`: `canGrow`, `growing` and
    `loadMore()`, never past `maxLimit` rows. Every window is read as
    key-range pages, every one live (*Paged reads* below): page 0 is this
    same window tuple (the one boot hydrates), and `loadMore()` SPLITS the
    last page — one new page, seeded — never a reload of a larger window.
    While the new page loads the hook stays `ready` on the rows it has
    (`growing: true`), so a list that already rendered never flashes a
    spinner. What a reader sees of it (P5 of
    `research/2026-10-13-global-live-paging-followups-session2.md`, A.3):
    - **The cap stops one step short** when `maxLimit` is not a multiple of
      the step: a new page must fit under `maxLimit` rows whole, so a 200/500
      window (the notifications popover) stops at 400; a 100/500 one reaches
      500.
    - **Any page's failure is the `error` arm**, with the rows shown as
      `stale` — not only page 0's.
    - **A boot-hydrated page 0** cannot seed its first split (its value is
      the boot snapshot's, `appliedSeq` 0): the first `loadMore()` logs
      `seed refused` and loads `(a, k]` in full — latency only.
    - The readers whose `loadMore()` used to reload a larger window and now
      splits: the pages trash, the bookmarks bar and start page, the
      notifications popover and mail's "Load older". The API is unchanged.
  - A **grouping** — `{ groupBy, where?, limit? }` — returns the same
    `LiveListResult`, of `{ value: V | null; count: number }`. `groupBy` is any
    declared filterable column of a `text` / `number` / `boolean` domain, and
    `V` is the ROW field's type. Groups are ordered count descending, then value
    (code-point order); NULL is its own group, selected with
    `{ isEmpty: true }`. `orderBy` is a type error (the order is fixed). Default
    limit 50, max `LIST_MAX`. A grouping is the one list read that is ONE
    tuple whose `limit` grows: `canGrow` is `groups.length === limit && limit
    < max`, and `loadMore()` reloads it at one more default page of groups,
    clamped. While the grown tuple loads the hook stays `ready` on the
    previous groups (`growing: true`) — the previous tuple stays subscribed
    only until the grown one has a value — and a grow that FAILS before its
    first value is the `error` arm with the previous groups as `stale`.
    `where` applies as given — to keep every chip visible while one is
    picked, leave the grouped column out of it.
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
  - **A scoped set** (`all: { by }`) — `useLive(c, { where })` /
    `useLive(c, { where, select })`: the same read on the tuple the `where`
    record IS (`LiveScopedAllQuery<B>`: exactly the `by` fields, each a
    string — a tree, an op, a missing or extra field is a tsc error). A scope
    change is a new tuple, so it reads `loading`. `useLive(c)` without one,
    or a `where` on a param-less set, is a tsc error and throws.
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
  ranks) and `useOptimisticResource(c, { where }, options)` (one scope of an
  `all: { by }` set — the page editor's `pageBlocks`: its base the scope's
  rows in order, scoped deltas merged by key, an op confirmed by its exact ack
  or by content and denied only by a full frame's watermark, Rule B′). The
  lane-only writes (`enqueueResourceWrite` / `enqueueDetachedWrite`) take the
  same pairs, resolved by the one `resolveOptimisticSource`. `loading` until a real value lands, never on a placeholder, and
  `dispatch` only on the `ready` arm — named by `status` like every read, with
  live-state's one named exemption: once a value has landed, a failing read
  stays `ready` and carries the failure as `error` (see live-state CLAUDE.md). The hook asks the server for standalone
  ack frames on its tuple (client-requested, per subscription), so a write
  that changes nothing in the tuple still confirms — nothing is declared here.
- `useLive` is on `live-state/no-pending-data-collapse`'s watched list
  (`useLiveRow` has no `data` to collapse), and both on `no-ready-negation`'s:
  never `status !== "ready"` — name `"loading"` and `"error"`.

## Paged reads — key-range pages through `useLive`

A read of "more rows" than one bounded tuple holds is **key-range pages**:
each page is one bounded tuple `(after, until]` at a `limit`, the pages tile
the order by server-minted cuts, and the pages are planned by ONE pure planner
(`shared/page-plan.ts`) read by ONE hook (`web/internal/use-pages.ts`) behind
ONE entry point, `useLive`. Two kinds of source page this way — every
collection's window and a value declared `paged` (an external source's items)
— and they plug in through one seam
(`web/internal/page-source.ts`), never into the planner or the hook. Design:
research/2026-10-09-global-live-key-range-pages-v2.md (the plan, the
viewport, the stale budget and its placeholders, seeded derivation) and
research/2026-10-11-global-live-paging-unification.md (one mechanism for
collections and values — D1–D3 below).

- **D1 — a page is always a key range.** A cut is a POSITION in a total order
  (the order keys, then the id), owned by the rows, valid even after its row
  is deleted. So each page is independent of the others: it is released and
  subscribed again on its own (which is what lets liveness follow the
  viewport), and an insert near the head never re-mints the pages after it —
  the planner absorbs it with an overflow split. There is no cursor chain: a
  cursor belongs to the previous page's ANSWER, which would force every page
  live, a depth cap, and up to N−1 serial re-mints per change at the head. A
  source that can only hand out forward tokens (a provider's `pageToken` /
  `nextCursor`) therefore cannot be declared paged — it has no positions to
  cut at. Its forms are one bounded `liveValue` (its first N results), or a
  mirror into Postgres read as a collection (as `mail.threads` is).
- **D2 — one planner, one entry point; the viewport only decides liveness.**
  Whatever the source, the code path (`reconcile` / `split` / `assemble`) is
  the same; the optional `viewport` changes only which pages are live:

  | Read | Live pages | Depth | Result |
  |---|---|---|---|
  | `useLive(src, q, { viewport })` | The band around the viewport (±1, hysteresis at 2); farther pages stale, then placeholders | Unbounded | `LivePagesResult<Row>` |
  | `useLive(src, q)` (no viewport) | Every loaded page | `maxLimit` rows in all | `LiveListResult<Row>` |

  A reader that cannot say which rows are on screen must keep everything it
  loaded live — O(loaded) — so "bounded by construction" caps it, at the
  `maxLimit` such a reader always had. The cap is the boundedness rule, not
  a second mechanism. Only the viewport mode has placeholders and per-page
  notices — different STATES, hence its own result shape; the plain mode
  keeps the list result every window read hands out. No window read grows
  by reloading a larger window: only a grouping does (*Read* above).
- **D3 — one runtime path.** Every page is a keyed window membership entry
  whatever its source; the source decides only how a change ARRIVES —
  Postgres as a routed change carrying the affected ids (a collection's
  window), external as `notify(q)` re-running every live page of `q` and
  diffing it by key (a value's page: the runtime's external window,
  `ExternalWindowPolicy` — D31 there reads "an external resource is never
  ROUTED", not never keyed). Everything after it is shared: keyed `delta`
  frames, per-tuple snapshots, seeded split and merge (a value page's family
  is its question's `q`), one client cache path. So a value page's read sends
  `derive` like a collection's, and comes under the frame-vocabulary protocol
  as derived acks do (`PROTOCOL`, `packages/resource-protocol`: tabs share a
  socket only under the same one, and a derivation asked under another
  protocol loads in full — `protocol-skew`).

### Collections — every window

- **Declare.** There is nothing to declare: every window pages (P5 of
  `research/2026-10-13-global-live-paging-followups-session2.md` deleted the
  old `scroll: true` flag — a stray one is a tsc error). A window needs
  `maxLimit ≥ 2 · default.limit` (a declaration throw): a page that splits is
  read at `2 · default.limit`, a step of headroom over the rows it holds.
  `maxLimit` bounds one page's `limit`; it is no depth bound under a viewport.
  `LiveCollection` is what `useLive`'s paged read and `liveDataSource` take
  (a lookup-only or `all` collection has no window: a tsc error).
- **`$key` — the server-minted row key.** Every full and scoped row of every
  window carries `$key`: the canonical JSON array of the tuple's order keys as
  exact Postgres text (`col::text` — a µs `timestamptz`, a long `numeric`, a
  `float8` cross exactly), then the id (omitted when the order already names it).
  Over `LIVE_ROW_KEY_MAX_BYTES` (1 KiB, a long text sort key) it is `null`: no
  page can be cut there. It is declared on the window's wire schema only (never
  a row field, never on `:rows`), and every read hands rows out WITHOUT it
  (`useLive` splits it off, one copy per row object).
- **Cuts.** A window tuple may carry `after` (exclusive) and `until` (inclusive)
  — each a `$key` verbatim, never derived on the client (a decoded row lost the
  exact text). The codec decodes them strictly (exactly the order's arity, a
  non-NULL id, canonical JSON), on every window. `serveCollection` hands
  query-resource the key block for every window (the window spec's required
  `rowKey`: the cuts, the page family `familyOf`, the key field), so any
  window's page may be derived from pages of its query, and a point spec
  cannot spell one (tsc). The compiler renders them on the ORDER side over the tuple's own keys
  (keyset's `seekPredicate` / `atOrBeforePredicate`, each operand cast back to its
  column's type) — never through `where`, so a sortable-but-not-filterable order
  column takes cuts, and the routes and roles are those of the tuple without them.

### Values — `liveValue(key, { query, paged })`

A read paged over an EXTERNAL source (an archive, a provider, a list held in
memory) whose items have positions to cut at. A paged Postgres list is a
collection's window, never this.

```ts
// core/
export const metricDetails = liveValue("metrics.details", {
  query: DetailsSelectorSchema,          // the question (a typed query), without range or limit
  paged: {
    item: DrillItemSchema,               // a zod object; `$key` is reserved
    id: "id",                            // a string field (tsc), unique per question — the tiebreak
    key: { of: (i) => [i.at], order: ["desc"] },  // text (or null) parts, one per direction
    limit: 50,                           // H: page 0's limit and the step
    maxLimit: 500,                       // ≥ 2 · limit (a throw)
    meta: DrillMetaSchema,               // optional: → metricDetails.meta
  },                                     // no `load`: a page is a keyed window, always pushed
});
// server/ — every hook takes the DECODED question
serveValue(metricDetails, {
  source: "external",                    // the only arm (a "db" paged value is a tsc error)
  changes: "notified",                   // or { immutable | fixed } — never a snapshot
  loader: (q, range) => readItems(q, range),     // range: LiveKeyRange → readonly Item[]
  meta: (q) => ({ total: count(q) }),    // required exactly with `paged.meta`
  whileSubscribed: (q, notify) => watch(q, notify),  // once per QUESTION
});
// A declared `refusals` (e.g. `["invalid-query"]` beside `paged`) reaches the
// pages and the meta sibling alike: either loader may throw `v.refuse(code, msg)`,
// and a read of either types its `error.code` by the declaration.
// web/
useLive(metricDetails, selector, { limit: 5 });  // no viewport: LiveListResult<Item>, ≤ maxLimit items
useLive(metricDetails, selector, { viewport });  // under a viewport: LivePagesResult<Item>
useLive(metricDetails.meta, selector);           // the per-question sibling: ResourceResult<Meta>
```

- **The key contract.** `key.of(item)` reads the item's order key — one exact
  TEXT part per `order` direction, or `null` — whose text order IS the order:
  the source supplies the precision, as Postgres `::text` does for a
  collection (an instant at a fixed precision, `Date#toISOString`; a
  zero-padded number). A number or `Date` part is a tsc error (`LiveCutKey`,
  the type collections cut with). The framework appends the id. The order is
  `core/internal/key-order.ts`'s: parts by code point (the cluster's `C` collation),
  each in its direction, `null` LAST either way, then the id ascending.
- **One page, one tuple** `{ q, limit, after?, until? }` — the question's
  canonical `q`, the page's limit and its cuts (server-minted `$key`s,
  verbatim). Page 0 at the declared limit is `{ q, limit }`. The gate is the
  typed query's (strict, byte-identical re-encode) plus `limit` (canonical
  decimal, `1..maxLimit`) and each cut (`core/internal/row-key.ts`'s
  `parseRowKey`, shared with collections: canonical JSON, the order's arity
  plus a non-null id, ≤ `LIVE_ROW_KEY_MAX_BYTES`). The wire schema is
  derived (`item` plus `$key`), so a paged value declares no `schema`; no
  `params`, no preload, and no `load` (tsc and a throw): the descriptor is
  KEYED by the item's `id` (`keyed.keyOf`) — a page is a keyed window (D3),
  whose changes ship as deltas, so there is no `invalidate` of one to refetch
  over HTTP. The meta sibling is pushed too.
- **Served as a keyed external window** (`compilePagedValue`): no mode — its
  `membership` is the runtime's `ExternalWindowPolicy` window, `limitOf` the
  page codec's `limit` and `familyOf` the question's `q` (every page of one
  question cuts one order). A `notify(q)` re-reads each live page and ships
  its keyed delta; a page split or merged from pages of its question the
  server holds is seeded (no load), as a collection's is.
- **The loader answers one key range** (`LiveKeyRange`: `after` / `until`,
  each `{ key, id }` or `null` at the order's start / end, and `limit`): the
  items strictly after `after`, up to and including `until`, at most `limit`,
  in key order. A cut is a POSITION, not a row: the row it was minted from
  may be gone. The served half checks EVERY answer (`pageRowsOf`): key arity
  and part types, strictly ascending keys (so no id twice), inside the range,
  at most `limit` — a violation is a loud loader error, never a reader that
  pages wrong — and mints each item's `$key` (`null` over 1 KiB: no page is
  cut there). A source that holds its whole list in memory answers with
  `sliceRange(value, items, range)` (`server`); `checkPagedSource`
  (`server/testing`) holds a source to the contract over every range, the
  cuts of deleted items included.
- **Meta — a per-QUESTION fact** (a total) is the sibling typed-query value
  `value.meta` (`<key>:meta`, tuple `{ q }`), declared by `paged.meta` and
  served by `meta(q)` — never a page's: page 0 may be split or released.
  Pending until known, never a stand-in 0.
- **`notify(q)`** recomputes every subscribed page tuple of `q` and its meta
  tuple. **`whileSubscribed` runs once per question**, refcounted over every
  page tuple and the meta tuple of it, so a read that splits or releases its
  pages never restarts a source watch. Both are `compilePagedValue`'s
  (`core/internal/compile-value.ts`), which the worktree and central `serveValue`
  share (`ServedPagedValue` / `CentralServedPagedValue`).
- **Read options.** With no viewport, `limit` (in `1..maxLimit`, default
  `paged.limit`) is page 0's limit and the step `loadMore()` grows by — a
  preview. `limit` beside a viewport is a tsc error (`viewport?: never`).
  There is no `{ first }`, no cursor and no `nextCursor`.

### The read — `useLive(source, query, { viewport? })`

`source` is a collection (its window) or a paged value; the overloads are
appended after the window and grouping ones, so a window query's `where:
or(…)` keeps its contextual typing. Below, "`default.limit`" is the source's
step — a collection's `default.limit`, a value's `paged.limit` (or the read's
`limit`).

- **The seam** (`web/internal/page-source.ts`, `pageSourceOf(source)`,
  cached per declaration): the resource a page is one tuple of, the
  question's `base` (its identity without limit or cuts), the step and
  `maxLimit`, `params(query, page)` — INVARIANT: page 0 at the step is
  byte-identical to the source's plain default tuple, the one the boot
  snapshot hydrates, so a paged reader and a plain one share it (pinned on
  `conversationsGone` by tasks-core's `boot-pages.test.ts`) — and the id
  field. Every source's page is a keyed window on the server (D3), so any may
  be sent seeded. The planner and the hook know nothing else of the source.
- **With a viewport — `useLive(source, query | null, { viewport, resetKey? })`**
  → `LivePagesResult<Row>`: `{ status:
  "loading" } | { status: "error"; error; refetch }` (the first page failed with
  no rows; `error` is that read's `ResourceError`, unwidened) `| { status:
  "ready"; rows; exhausted; canGrow; growing; loadMore; truncated; pageErrors;
  placeholders }`. A collection's `query` has no `limit` (`LivePagesQuery`:
  the pages own the limits).
  The plan is pure data (`shared/page-plan.ts`, shared by the hook and the
  oracles); the hook reads one tuple per LIVE page through live-state's
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
    page by one. "Every page live" is not a `VisibleRange` variant: it is the
    absence of the option, so it cannot be smuggled through one. The
    viewport is checked before `null → count`: a `null` source (and query)
    under a viewport reads nothing, with the hook order of the paged read.
- **No viewport — `useLive(c, query?)` / `useLive(v, query | null, { limit? })`.**
  The same plan with every page live (the plan's `everyPageLive`): page 0
  is the plain tuple (a collection's `query.limit`, else the default — the
  boot snapshot's; a value's `limit`, else `paged.limit`), `loadMore()`
  SPLITS the last page (one new page — seeded for a collection — never a
  reload of a larger window), it never pages past `maxLimit` rows, and a
  page a live insert pushes past them is dropped (the one before it
  becomes the last). Its result is the plain `LiveListResult` (a page's
  failure under the rows shown is the `error` arm with them as `stale`).
  Every plain window read reads it this way (e.g.
  `use-conversations.ts`, `recovery-view.tsx`, `use-release-info.ts`,
  `song-library.tsx`, the notifications popover).
- **Both modes** — the plan's mechanics (*Liveness*, *The stale budget* and
  the placeholders apply under a viewport only; without one every page is live):
  - **One call site, one kind of read.** `useLive` holds the kind its first
    render read (a viewport or none, a count, an id set, …) and throws when a
    later render asks another — each kind is a different set of hooks.
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
    `rowKey.familyOf`) and quiescent at the version sliced — no load, a
    value-less `sub-ack` the client fills with its slice — and loads the tuple
    whole otherwise. The hook subscribes a seeded page before it releases the
    pages it replaces (`useResources` observes the new tuples first), so the
    server still holds the sources when the sub arrives. The unknown part — `loadMore`'s `(k, ∞)`, the half of an
    overflow past its cut (its page was full: it may hide rows) — is always
    read. A seed is read on the page's first subscribe only; a released page
    drops it. A paged value's page is seeded the same way (D3): its sources
    are pages of the same question.
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
    (`pages=N live=M` — only once it says something: under a viewport, or
    past one page; a plain window read that never paged writes none), a collapse, and a read that stops short — and three
    signals that decide follow-ups (research/2026-10-12-global-live-paging-followups.md):
    - `overflow-split gap Nms` — from the commit an overflow split mints its
      rest page (`(m, b]`, read whole: `reconcile`'s `overflowed`) to the
      commit that page's read first settles: how long rows past the old
      page's last were in no page (a hidden-rows marker is reopened only if
      this is common or over ~150 ms);
    - `cross-page gap: row X was in no live page for Nms` — a row that left
      one live page and reappeared in another within 1 s (the leaving frame
      first; the duplicate order is the dedup's, and a delete never comes
      back), from `web/internal/cross-page-gaps.ts`, which diffs only the
      pages whose rows array changed (a client-side departure hold is built
      only if it fires);
    - `seed refused: a source holds a boot-hydrated value` — written by
      live-state's `seedOf` when a split or merge would seed from a page
      whose value is still the boot-hydrated one (`appliedSeq` 0, a cached
      value, no derivation of its own in flight): the page loads in full
      instead. A source still loading (nothing cached, or its own derivation
      unanswered) is refused too, but not counted.
  - Pinned by `shared/page-plan.test.ts` (the plan against a simulated server:
    loadMore as a split, overflow, no cuttable key, the merge bound, the live
    band and its hysteresis, dedup on a backward move, contiguity, a stale last
    page's `canGrow`, the stale budget and its placeholders at the edges, a
    placeholder on screen subscribed again, random walks, an overflow split
    reporting its rest page), `web/internal/cross-page-gaps.test.ts` (the
    gap detector: a move with the leaving frame first is one gap; the
    duplicate order, a flip in place, a delete and a page handing its rows
    on are none), `web/internal/page-source.test.ts` (the seam: page 0 is the default /
    `{ q, limit }` tuple, cuts verbatim, one source per declaration),
    `web/__tests__/use-pages.test.tsx` (the hook over a fresh
    `createLiveStateHarness` per test, through `useLive`: placeholders past the budget, a
    `columns` change, a `loadMore` sent seeded, a merge seeded from both
    pages and an overflow split from its known half, each before the
    replaced pages' release; without a viewport, every page live and capped
    at `maxLimit`; a plain reader sharing page 0; one kind of read per call
    site), `web/__tests__/use-live-query.test.tsx` (a paged value, with and
    without a viewport, its meta sibling), `web/__tests__/use-live-types.test.ts`
    (what does not compile: `limit` beside a viewport, `{ first }`, a non-text
    key part, a cursor answer),
    data-view's `web/__tests__/page-placeholders.test.tsx` (the DOM: height,
    anchoring, bounded on a deep scroll), and
    `server/internal/serve-collection-pages-oracle.test.ts` (the real feed:
    random writes, paging and viewport moves — live pages converge, no row twice,
    refills O(changed), a gap-free prefix once all are in view, a head-burst
    splitting past any cap; seeded, `loadMore` loads exactly `step` rows and a
    merge loads none). For values: `core/internal/compile-value.test.ts` (each loader
    check, `$key` minted and `null` over 1 KiB, the meta sibling, one
    `whileSubscribed` per question, a page compiled to a keyed window — its
    size and family off the codec), `core/internal/row-key.test.ts`,
    `core/internal/key-order.test.ts` and
    `server/internal/serve-paged-value-oracle.test.ts` (an in-memory source
    mutated at random on a real runtime: live pages converge, nothing twice,
    `notify(q)` re-reads only the live pages and reaches each as a keyed
    delta, a deleted cut row stays a valid cut, `checkPagedSource` over every
    range; seeded, `loadMore` loads only the new page and a merge loads
    nothing).

## Fields — `from` / `pick` / `related` / `fields` / `carry`

The spelling every new collection uses (phase 2 of fields-declared-once,
`research/2026-10-13-global-fields-declared-once-phase2.md` §2): a collection
names the entity its rows are and the fields a list shows, and everything else
is DERIVED from the field declarations — the row schema, the filter domains,
each field's label, type, options and title flag. It is the only spelling:
`row` / `filterable` / `exposes` are deleted (fields declared once, phase 2b
— `research/2026-10-15-global-fields-declared-once-phase2b.md`).

```ts
// core/ — the entity's fields carry their labels and options once
export const conversationFields = {
  id: textField(),
  title: nullable(textField({ label: "Title", primary: true })),
  status: enumTextField(STATUSES, { label: "Status", options: { working: { label: "Working" }, … } }),
  …
};
export const conversationsEntityRef = entityRef("conversations", conversationFields);

// core/ — a list's collection
export const conversationHistory = liveCollection("conversations.history", {
  from: conversationsEntityRef,                 // the entity the rows are: `pick` reads it, its exposures fold
  pick: ["title", "status", "model", "createdAt"],  // the entity's fields a list shows, in list order
  fields: { taskTitle: textField({ label: "Task" }) },  // fields it computes (bound by `serveCollection`'s `columns`)
  carry: { pick: ["id"], fields: { taskId: textField() } },  // on the row, in no list, never filterable
  related: { task: tasksEntityRef },            // a lookup join's alias → the entity it reads
  id: "id",
  sortable: ["title", "createdAt"],             // index-backed, so explicit — any row field
  default: { orderBy: [["createdAt", "desc"]], limit: 100 },
  maxLimit: 500,
});
conversationHistory.fields.status;   // { id, key, label, typeId, options, primary, domain, sortable }
```

- **Derived.** The row schema is `fieldsToZodObject` of every row field (pick,
  own, carried — each field's wire schema with its default backfill), plus
  `$columns` when the rows reach an entity. Every LISTED field (picked and own)
  whose value has a filter domain is filterable in it — one derivation for every
  owner (`core/internal/field-domain.ts`): at the type level from the field's
  value type, at runtime from the schema that produces it (string / enum →
  text, number → number, boolean → boolean, `Date` → instant, string array →
  stringArray; a JSON value has none). `meta.filterable: false`
  (`textField({ filterable: false })`) opts a field out; a carried field is
  never filterable. `collection.fields` lists the listed fields' descriptors
  (`LiveField`) by id, in declaration order — what data-view derives a list's
  schema from, and what an MCP reads labels from; `collection.from` the entity.
- **tsc.** A picked or own field must carry a label (`RequireLabel`: the
  factories mark one — `FieldMarks` in `fields/core`), a picked key must be a
  field of `from`, the id must be a row field. The same checks throw for an
  untyped caller, beside a stray old-spelling key, a field named twice, `pick`
  without `from`, an own field named like an entity field.
- **`from` an extension shape.** `from: shape` (a `defineExtensionShape`
  result — a 1:1 side table's field record, in core) makes the rows the
  shape's whole WIRE row (`shape.schema`'s keys, its server-only fields and
  off-wire timestamps never); `pick` lists some of it (labelled). A shape
  reaches no exposure (`baseExposures`, `carry.pick` throw) and
  `collection.from` is `null` — only an entity's presentation applies by
  owner. Most lookups and `all` sets over one extension are this one line
  (`from: transposeShape`).
- **Exposures.** `from` folds the entity's exposures (`exposes.base`) unless
  `baseExposures: false` (a boot-preloaded set whose base exposure is
  write-hot: the Queue's `conversations-active` leaves usage off); `related`
  is the old `exposes`' other keys. A lookup-only collection reaches none.
- **Forms.** `default` → a window (`sortable`, `maxLimit`,
  `columnScope`, `count`, `preload`); `all` → the whole ordered set (its
  order any row field); neither → lookup-only. The server half is unchanged:
  `serveCollection` binds every row field by name, an own field through
  `columns`, and folds the exposures as below.
- **Overloads.** Three (no-window first, union, window LAST): a misdeclared
  spec — a stray `row` / `filterable` / `exposes` included — is reported
  against the window one (they are `never` there). The window one is last
  because the resource vocabulary infers a collection factory from the last
  overload's return type (a top-level conditional return would hide it).
- **Union arms — `liveArm(union, arm, { label, order, from?, pick?, fields?, carry?, sortable? })`.**
  An arm's own fields, declared the same way (each labelled, domains derived,
  `sortable` explicit; `carry` puts fields on the slice that no list shows —
  a jsonb blob a detail pane decodes — never listed, filtered or sorted; an
  arm whose rows are an entity's names it in `from` and lists some of its
  fields by name in `pick`, with the entity's labels — `picked` records them,
  and the server binds them by name): an
  arm column set (served by the union's binding, `served.arm(arm, { … })` of
  `serveUnionCollection` — `runsServed.arm`) plus `label` (the band its fields are listed under), `order`
  (its band's place among the union's arms, ascending — each arm states its
  own, so the order is the surface's choice, never plugin load order; the
  runs arms' rationale is in `runs` core) and `listed` (its descriptors, ids
  `<arm>.<field>`). See *Union collections*.
- **Presentation — `FieldPresentation.Register({ owner, reads?, fields })`**
  (web). What only the browser can say of a field — `cell(value, row)`,
  `width`, `align`, `visible: false`, `groupable: true` (a text dimension
  grouped by), `useOptions` (a `Hook` returning a
  `ResourceResult` of options — a live catalog; the field is `pending` until
  it lands — or, for a set that is always known such as a contribution
  registry or a display-name lookup, the plain option array) — registered once per OWNER: an
  entity (`EntityRef` — its fields in every list whose rows are it; `reads`
  names the other entity fields its cells read, and a list carrying fewer
  throws at mount), an exposure (`EntityExposure`), an arm (`LiveArm`) or a
  collection declared by fields (its listed fields, in every list of it — a
  union's base fields, an own field; a picked one's entity may present it
  too, never the same property). Several plugins may present one owner (two
  setting the same property of one field throws). `useFieldPresentations()`
  reads them; data-view folds them.
- **Options label every value, by its canonical spelling** (`fields/core`'s
  `optionKey` / `OptionKey<V>`): a string is itself, a boolean or number its
  `String` (`"true"`), and `"null"` is the no-value — an exposure's `options`
  are typed against its wire (`{ true, false, null }` for health's nullable
  `ok`, tsc), a live option read appends `{ value: "null", label: "By hand" }`.
  Data-view keeps the raw values: an enum over a boolean / number column
  carries `valueDomain`, the enum filter lowers a picked option back to the
  value it spells (`"null"` → `isEmpty`), and the "None" section takes the
  `"null"` option's label.
- **The `live:exposures-registered` / `live:arms-registered` checks**: every
  exposing shape and every `const x = liveArm(…)` is bound by its own plugin's
  `server/` and registered (`FieldPresentation.Register`) by its own `web/`;
  **`live:client-fields-resolved`**: every `const x = clientFields(…)` is
  resolved (`ClientFields.Resolve`) by its own plugin's `web/`.

## Rows that are not database data — `rowKind` / `clientFields`

Fields declared once reach lists whose rows or values are not database data
too (`core/internal/row-kind.ts`, `web/internal/client-fields.ts`; phase 2b
§B):

```ts
// core — a kind of in-memory row: a collection with no server
export const fileEntry = rowKind("file-explorer.entry", {
  fields: { name: textField({ label: "Name", primary: true }), size: nullable(intField({ label: "Size" })) },
  carry: { fields: { id: textField() } },
  id: "id",
});
// core — fields whose VALUES only the browser knows, declared once on an owner
export const gitFields = clientFields(fileEntry, "git", {
  section: "Git",
  fields: { git: enumTextField(GIT_BADGES, { label: "Git", options }) },
});
// web — the declaring plugin resolves them, once
ClientFields.Resolve({ fields: gitFields, component: GitResolver });
// GitResolver: ({ rows, render }) => render(read) — read: ResourceResult<{ git: (row) => value | null }>
<DataView rows={entries} collection={fileEntry} … />   // every list of the kind gets them
```

- **A row kind** has a collection's `key` / `fields` / `rowKeys` (no
  `from`, no exposures), so a DataView's in-memory origin takes it as its
  `collection` and derives its fields; `FieldPresentation.Register({ owner:
  kind })` presents them. A kind that comes to need server filtering becomes a
  `liveCollection` of the same fields plus a `serveCollection`, and no list
  changes.
- **Client fields** are declared on a row kind or a collection (the
  deployments list's release state is on `deploy.deployments`). They are not
  the owner's fields, so a server query cannot name one (tsc); a DataView
  filters, sorts and groups them in memory, and refuses (throws) to list
  them under a live `source`. Their values are a READ: `loading` → each
  cell pending, `error` → `readError` (stale readers keep painting), `ready`
  → the per-field readers (`null` where a row has none). The resolver is a
  component handed the list's rows, so it may read once per surface or per
  row (a probe per deployment). `FieldPresentation.Register({ owner:
  gitFields })` presents them.

## Other plugins' columns are exposures

There is no "contributed column" seam: a collection never names another
plugin's columns, and another plugin never declares columns on a collection.
A plugin with per-row data of an entity stores it in an entity EXTENSION and
EXPOSES its fields (below) — every collection whose rows reach the entity
sorts, filters and groups by them (Sonata's library by a song's play count:
`playback-history` exposes `playCount` on `sonata_songs`). The old
`contributed: true` / `liveColumns` / `serveColumns` / `LiveColumns.Serve`
are deleted (fields-declared-once phase 2): tsc rejects the names, and an
untyped `contributed` throws.

- **Defaults.** An exposed field with a declared default reads it where the
  side row is missing (query-resource's `ReadColumn`: `COALESCE`), so a
  never-played song has `playCount = 0` in SQL — in a filter, a sort and the
  projection (`serve-collection-exposed-sort.test.ts`).
- **Custom columns** (data-view's user-defined columns) are the open-vocabulary
  twin: a *scoped* column set, below.

## Exposed fields — `exposes` / `LiveColumns.Expose` / `exposedColumns`

An entity extension declares, once, the fields it EXPOSES
(`defineExtensionShape({ exposes: { parent, name, fields, presence? } })` —
entity-extensions; each field's `label`, `as` and `options`, a missing side
row reading the field's declared default, else NULL; `presence` a field read
off the side row's existence). A collection declares the ENTITIES its rows reach
— `from: conversationsEntityRef` (its own entity, the `base` relation) and
`related: { task: tasksEntityRef }` (each key the alias of a LOOKUP join its
server half declares) — and every exposure of those entities folds in
(`collection.exposes` lists them: `base`, then the aliases). Neither names the other (phase 1 of fields-declared-once,
`research/2026-10-12-global-fields-declared-once-phase1.md`).

- **Serve.** The extension's plugin contributes `LiveColumns.Expose(ext)`
  (its handle; one exposing nothing is a tsc error). A collection reaching an entity —
  window or `all` — is DEFERRED and folds every reached exposure at
  `bindDeferredResources` (`./server/internal/exposure-folds.ts`): `base` →
  `ext.join(slice)` (alias route), a lookup `R` → `ext.join(slice, { on: R.on
  })` (LEFT, `reverse` route probed through R's chain). Asserted at bind:
  `base` is the collection's table, `R` a lookup over the entity's table whose
  pk is the extension's parent key, no slice or field name collides (with a
  row field or another set). An exposure no collection reaches is not an
  error.
- **Rows.** `$columns[<slice>][<field>]`, wire names `<slice>.<field>`
  (`tasks_ext_track.track`); a missing side row reads the field's declared
  default (COALESCE), else NULL. A presence field binds to query-resource's
  `presenceExpr` over the join's key (`exposedBinding`,
  `server/internal/exposure-folds.ts`), in the window and the `all` form
  alike. A field's list id is its `as` (else its key): the collision check
  and data-view's `FieldDef.id` read it. An
  `all` set folds through `wire: { encodeRow, ids: { $columns:
  "exposed:<sorted wire names>" } }`, so its L2 definition moves with the fold.
- **Columns.** `exposedColumns(exposure)` (core, memoized per exposure) is the
  column set, owner `{ kind: "exposed", entity }`: every field filterable in
  the domain its VALUE reads in (`./core/internal/field-domain`, *Fields* —
  read off its wire schema), every one with a domain but a string array
  sortable; a field with none (a JSON value) is carried and shown, never
  filtered or sorted. `.column(f)` a ref, `.read(row)` the parsed slice. A
  codec takes it only on a collection whose `exposes` reaches its entity.
- **Groups and counts** read an exposed groupable column on the server:
  `c.groups.groups.encode({ groupBy: "<slice>.<field>", columns })`, `{ count:
  true, where, columns }`; the server decodes against the exposures it serves
  (its `validateParams` replaces the descriptor's, as the window's does).
- **Web.** `c.exposes` lists the reached entities. The extension's web barrel
  registers the exposure — `FieldPresentation.Register({ owner:
  shape.exposure, fields? })` (*Fields* above) — and data-view derives every
  registered exposure a list's collection reaches into its fields (id the
  field's id), bound to their exposed columns under a live source — groupable
  ones group as server sections — or read off `$columns` over in-memory rows
  (`collection` prop).
- **The `live:exposures-registered` check**: every exposing
  `defineExtensionShape` is folded by its own plugin's server
  (`LiveColumns.Expose(h)` of a `defineExtension` handle over it) and
  registered by its own plugin's web (`FieldPresentation.Register(…)` naming
  it).

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
  like an exposing one) folds every contribution as a query-resource join
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
  `useLive`'s pages). Values a list DISPLAYS still come from the custom-columns value
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

## Union collections — `arms` / `liveArm`

A collection declared with `arms: { discriminator }` lists rows of several
KINDS — each served from its own table — in one window (the runs of every run
kind): `liveCollection(key, { fields, carry, id, arms: { discriminator: "kind" },
sortable, default, maxLimit })`. Its id is the union row key
`kind:raw` (query-resource's `armKeyCodec`). It is what a **Meta-DataView** is
(fields declared once, phase 3 —
`research/2026-10-16-global-fields-declared-once-phase3-meta-dataview.md`;
data-view's CLAUDE.md, *Meta-DataView*): one list over sources of different
entities, its shared fields the union's, its per-source fields the arms', its
source field the discriminator.

- **The source field.** The discriminator is a LISTED base field (in
  `fields`, labelled — tsc: `D extends keyof fields`, and a runtime throw),
  declaring no options: its options are the union's arms (`liveArm`'s
  `label` and `order`), derived by every list (data-view's `deriveFields`).

- **The overload (T12).** A union is a window like any other (read as
  key-range pages, listed as a live DataView); `exposes` and `columnScope` are
  `never` — a union's
  column vocabulary is its arms' declarations (and the exposures its entity
  arms reach, below). Declared by fields, its
  base fields are its own (`fields` / `carry.fields` — no `from` / `pick` /
  `related`: a union's rows are no entity's), presented once by
  `FieldPresentation.Register({ owner: union })`, so a list of it derives
  every field (`runs`). The discriminator is a listed
  field (tsc) other than the id; the id's literal type is kept
  (`collection.id: I`), so an arm's binding can leave it out. An untyped caller's stray field throws. The
  collection is `LiveArmsCollection` (`arms` set); every single-table
  collection is `arms: null`, which is what `serveCollection` takes (a union
  is a tsc error there, and throws against a cast).
- **Rows** carry `$columns` like an exposing collection's: each arm's OWN
  fields under `$columns[<arm>]`.
- **`liveArm(collection, arm, { label, fields, carry?, sortable? })`**
  (*Fields*) declares one arm's own fields in the arm's core: wire names and
  field ids `<arm>.<field>`, the slice's row schema and filter domains derived
  from the labelled fields; `read(row)` is `null` for another arm's row,
  parses its own slice once per row object, and THROWS on its own arm's row
  with no slice (A16 — a server that did not fold the arm is a bug, never "no
  values"). A collection without `arms` is a tsc error, and throws.
- **Entity arms fold their entity's exposures** (fields declared once, phase
  4 — `research/2026-10-17-global-fields-declared-once-phase4-entity-meta-dataview.md`).
  An arm declared `from` an ENTITY (`liveArm({ from: entityRef })` — its
  `reaches`; an arm with no `from`, or `from` an extension shape, reaches
  none) folds every
  served exposure (`LiveColumns.Expose`) of that entity, as a direct
  `liveCollection({ from })` folds `exposes.base`: at the deferred bind
  `compileUnion` runs `exposureFolds({ base: reaches }, …)` per arm, appends
  each fold's `ext.join(slice)` to THAT arm's joins (an `alias` route,
  `<arm>.<slice>`), and binds its fields (`exposedBinding`: COALESCE to the
  declared default, presence as `presenceExpr`) under their wire names
  `<slice>.<field>`. Every other arm reads them as a typed NULL, so a filter
  on one prunes the arms that cannot hold it. Rows carry them under
  `$columns[<slice>]` beside `$columns[<arm>]` (on the folding arm's rows
  only). Refused at bind: two arms reaching ONE entity (one slice would bind
  two arms — a filter on "arm A's" track would filter arm B too), a slice
  named like an arm, an exposed field id equal to one of the arm's own
  fields. The codec of a union lets an exposed set through (its arms are
  declared after it, in other plugins), and the server's decode — over the
  sets it folds — is the authority. Data-view lists them in the arm's band,
  ids `<arm>.<id>` (two entities' `origin` fields do not collide). Test:
  `server/internal/serve-union-entity-arms.test.ts`. The reference is
  `runs`: its build, release and deploy arms are declared `from` their
  ledgers' entity refs (`buildRunsEntityRef`, `releaseRunsEntityRef`,
  `deployRunsEntityRef`) — each an `entityRef` beside a raw `pgTable`, as
  `pagesEntityRef` is beside `_blocks` — so an extension exposing a field on a
  ledger lands in that arm's band. An arm field is never the row's title
  (`primary: false`, even when picked from an entity whose title it is): the
  union's own base field is.
- **Groups by a column set.** A union's `:groups` decodes with its arms'
  and exposures' sets (its `validateParams` replaces the descriptor's, as the
  window's), so a list groups by an arm field (`build.status`) or an exposed
  one (a task's track) on the server; another arm's rows fall in the NULL
  group.
- **Owners (T11).** Every column set's declaration carries an `owner` —
  `scoped` (`scopedLiveColumns`), `arm` (`liveArm`) or `exposed`
  (`exposedColumns`) — and a column ref's owner adds `own`. The codec,
  data-view's field resolution and the server switch on it exhaustively, so a
  codec takes an arm set only on its own union, an exposed set only on a
  collection reaching its entity (or a union, decided by its server), a
  scoped set only in its scope.
- **Serve — `const served = serveUnionCollection(c, { derive? })`**
  (P6 of `research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md`), and
  **`served.arm(arm, { from, id, joins?, base(j), extra(j), where?(j) })`** —
  the one way an arm binds (`./server/internal/serve-arm.ts`), returning the
  `Registration` its own plugin puts in `register: [...]`; the union names no
  arm and an arm never edits the union. `arm` is its `liveArm` (its arm IS the
  kind); `from` / `id` its table and single-column primary key; `base(j)`
  binds every base field but the id, the discriminator and the derived ones —
  a column ref `j` offers whose column reads as the field's type (data type
  and nullability), or an `ExprField` of the field's value type, or `null`
  ("no such notion") for a nullable field (all tsc, T9); `extra(j)` binds the
  arm's own fields the same way — a field it `pick`s from its entity binds by
  name unless bound here, and must be bound here when `from` has no column of
  that name whose value is the field's type (tsc: an entity ref beside a raw
  table, a `text` column under an enum field — decode it with an `expr`);
  `where(j)` is its always-on scope.
  - **`derive`** — base fields the union computes for EVERY arm, so no arm
    supplies one and no two arms can disagree: `{ reads, bind(reads, { id }) }`
    — `reads` names the base fields it is computed from, each of which every
    arm must then bind to a COLUMN (tsc, and a throw); `bind` builds the field
    from those columns and the arm's own id (`runs`: the ledger `id`, and
    `duration` from `startedAt` / `finishedAt`). An arm binding a derived
    field is a tsc error and throws.
  - **Deferred.** The arms are read once at `bindDeferredResources` (they
    register in the register phase), and the three resources compile there —
    before anything serves and before the change feed rebuilds triggers from
    routes. `compileUnion(c, { arms: () => bindings, db? })` (`server/testing`)
    is the same compile over explicit bindings (`served.arm(…).binding`).
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
object). Anything row-shaped that grows is a collection — or, from an
external source whose items have positions to cut at, a key-range-paged value
(*Paged reads* above).

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
  source: "db",                          // or "external" + `changes` (below)
  reads: { tables: [notifications], reason: "the badge counts every unread row" },
  loader: countUnread,                   // (params: P) => Promise<T> | T
});
// contributions: [...unreadServed.declare]

// server/ — a param'd preload names its boot tuples
export const configValuesServed = serveValue(configValues, {
  source: "external",
  changes: "notified",                   // → configValuesServed.notify(params)
  loader: ({ path, scopeId }) => resolve(path, scopeId),
  preloadParams: () => [{ path: "a" }, { path: "a", scopeId: "app:x" }],
});

// a value re-measured only when a reader asks (a debug inspector, a heap stat)
export const heapStats = liveValue("heap.stats", { schema: HeapStatsSchema, load: "snapshot" });
serveValue(heapStats, {
  source: "external",
  changes: { snapshot: { reason: "a point-in-time measure of this process" } },
  loader: measureHeap,
});
useLive(heapStats).refresh();            // the Refresh button: re-measure now

// web/ — read
useLive(notificationsUnread);            // ResourceResult<T>
useLive(pluginChanges, { conversationId });  // params required iff declared
useLive(pluginChanges, id === null ? null : { conversationId: id });  // no subject yet: skipped, pending
useLive(folderListing, expanded.map((dir) => ({ dir })));  // MANY tuples → one result per entry
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
  `"snapshot"` is on-demand AND never told of a change: re-measured only when a
  reader asks. The descriptor is `load: "on-demand"` branded `snapshot: true`
  (`LiveSnapshotBrand` — every other declaration's type says `snapshot?:
  undefined`); its `serveValue` must declare `changes: { snapshot }` (tsc, and
  a throw), and its `useLive` result adds `refresh()`. A plain `useLive(value)`
  read re-measures on every mount, a remount over a still-cached read too
  (the cached read stays on screen meanwhile). Never beside `preload`
  or `paged` (tsc, and a throw).
- **Patches — `patches: true`.** A pushed value that grows (a message being
  written, an output tail): after the first frame of a subscription, each
  change ships as a `patch` — what changed (`packages/value-patch`: an
  appended string, pushed array elements, a replaced part) against the
  version every holder holds — never the whole value again. Declared on the
  `liveValue` because both halves act on it (the runtime diffs and answers a
  joining tab from the value the others hold; the client keeps the wire value
  it last applied and resubscribes when a patch's base is not it). A pushed
  value only: on-demand / snapshot `load`, `preload`, `paged` and `bytes` are
  refused (a throw), as is a served `revalidate` (the runtime). The reader is
  unchanged: unchanged parts keep their identity (`conversations.partial-message`,
  `research/2026-10-21-global-live-value-patches.md`).
- **Bytes — `bytes: true`.** A binary payload (a file's bytes, an image):
  `liveValue(key, { bytes: true, params | query, maxBytes?, refusals? })`
  takes no `schema` (the payload is an `ArrayBuffer`, checked as one on both
  ends) and is always `load: "on-demand"`. The descriptor carries `bytes:
  true` (`LiveBytesBrand`), read by the runtime and the client alike: the
  HTTP read answers `application/octet-stream` — the body IS the value, and
  the JSON envelope's `version` / `epoch` / `watermark` ride response headers
  (`resource-protocol`'s `resourceBytesHeaders` / `parseResourceBytesHeaders`),
  so the client's stale-drop and cross-boot guards work unchanged; the WS
  sub-ack carries no value and runs no loader (the client answers it with
  the HTTP read); `revalidate` / ETag / 304 work as for any value. tsc
  refuses `bytes` beside `load: "push"` / `"snapshot"`, `preload`, `paged`,
  `origin: "central"` and a `schema`, and its `serveValue` with `source:
  "db"` (`BytesPairing`) — each also a throw for an untyped caller. The
  loader answers an `ArrayBuffer` (a `Uint8Array` is refused by the schema:
  return `buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)`
  for a pooled Buffer). `maxBytes` bounds it server-side: a larger answer is
  refused `"too-large"`, a code declaring `maxBytes` adds to `refusals`, so
  the reader's error arm types it. `useLive` answers `ResourceResult<ArrayBuffer>`.
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
  - `"db"`: the value declares what its loader reads — **`reads: { tables,
    reason, outsideFeed? }`**, required (tsc, and a throw when it registers)
    — and a change to any declared table recomputes every subscribed tuple
    (full recompute, no scope policy — a keyed payload is a collection). No
    `notify`, at runtime too. Design:
    `research/2026-10-15-global-live-declared-reads-for-db-values-v2.md`.
    - **Whole tables only, with a reason.** The loader's SQL is hand-written,
      so nothing could keep a per-row filter in step with it: a wrong one
      would miss writes silently. Row-level narrowing exists only where the
      SQL is compiled from the same declaration — a collection. The `reason`
      says why a write to any row may change any tuple (a singleton, a total,
      "whole-table until it reads through a collection"); the read-set pane
      lists it under Routed FULL.
    - `tables` are drizzle tables, entities or views: every relation the
      loader can read on ANY path (helpers, branches, memo misses).
      Compiled by query-resource's `compiledValueReach` (in the Bun
      wrapper — core has no drizzle) into the value's `reach` plan: one
      `full` route per table, every column (no update is skipped); a view is
      a relation read (`RelationRead`), reached through its base tables.
      `tables: []` is allowed when everything the loader reads is
      `outsideFeed`.
    - `outsideFeed: { tables, reason }` — tables the loader reads that the
      change feed skips by declaration (`ExcludeFromChangeFeed`; a bulk cache
      read through a memo keyed on a routed table). Never routed; the drift
      guard accepts them; change-feed refuses at boot one it does cover.
    - **A thunk** — `reads: () => ({ tables, reason })` — when the tables come
      from a registry complete only once contributions are collected (one
      table per trigger event, per link owner, per saved-icon source): the
      value registers deferred and its plan compiles at
      `bindDeferredResources`, before the change feed builds its triggers.
      Such a value must be pushed (`load` not `"on-demand"`).
    - **The drift guard holds the loader to it** (resource-runtime's A8): a
      captured table outside `reads` fails the load under a test runner, and
      in a running server is reported once and routed FULL from then on (a
      view or rollup through its base tables) — a missing table is never
      staler than a whole-table read of it (a persisted value's drift is
      re-seeded from its `tables_read` at boot, D7). No change ever reaches a
      value through its captured read-set — only through what it declares.
  - `"external"`: truth outside Postgres. It must declare **`changes`** — how
    its answer changes (`LiveValueChanges`, tsc; a throw for an untyped
    caller), so a value nobody tells of a change cannot be written without
    saying why that is honest:
    - `"notified"` — something calls `served.notify(params?)`, or
      `whileSubscribed` / a `recomputeOn` upstream does. The ONLY arm with
      `notify`, `whileSubscribed`, `recomputeOn` and `throttleMs` — and with
      `reads`: a loader that ALSO reads Postgres (a lookup beside its files)
      declares those reads exactly as the db arm does (tables, views,
      `outsideFeed`, a thunk — bound through the runtime's deferred-external
      arm, so the value is external with its freshness from definition). A
      write to one recomputes every subscribed tuple, merged with its
      notifies. An undeclared read is caught by the runtime's D5 guard
      (reported and routed FULL from then on; thrown under a test runner). Never on a paged value (tsc,
      and a throw): its pages are keyed windows.
    - `{ immutable: { reason } }` — a tuple's answer can never change
      (sha-keyed, a terminal run's artifact).
    - `{ fixed: { reason } }` — constant for the process lifetime (a
      contribution registry, the OS account, a third-party answer with no
      change signal): `metrics.catalog`, `host-account`, `icons.resident-sprites`.
    - `{ snapshot: { reason } }` — the value is declared `load: "snapshot"`
      (paired both ways, tsc); no `revalidate`, so every HTTP read runs the
      loader (the runtime's HTTP path has no version short-circuit) and the
      read's `refresh()` re-measures. Never on a paged value.
    The three silent arms return a served value with no `notify` (tsc, and at
    runtime). The served value records `changes`; the runtime carries it as a
    `freshness` label the read-set debug pane lists per key.
  - **The bound rule is a type:** a `"db"` value whose type is an array or a
    string-indexed record must pass `unbounded: { reason }` (recorded on the
    served value and shown in the docs), and nothing else may. An external
    array is bounded by the process holding it.
  - Returns `ServedValue` = the runtime `Resource` + `source` + `changes?` +
    `unbounded?` + `keys` (`[key]`) + `declare` (a 1-tuple — spread it like a
    collection's); a `"notified"` external value adds `notify`. `compileValue` is the same derivation
    without registering, and `core/internal/compile-value.ts`'s `registerValue`
    registers it on any runtime (tests use their own).
  - **`throttleMs`** (db, and external `"notified"`): at most one flush per window — the first
    change arms a trailing timer later changes do not re-arm (the runtime's
    `debounceMs`, which was always a throttle). Only the window releases it:
    a flush another value triggers inside it, or a `recomputeOn` cascade,
    leaves it held — so the bound holds on a busy server.
  - **`recomputeOn: [served, { value: served, params: (up) => P }]`** (db, and
    external `"notified"`; an upstream is a `"notified"` value): upstream served values whose change recomputes this one. A bare
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
    Paired in `core/internal/compile-value.ts` over the runtime's 0→1 / N→0 hooks: an
    async start is awaited on the subscribe path, and a last unsubscribe that
    arrives first runs the stop after the start resolves. A failed start has
    nothing to stop (the runtime reports it). Nothing watches the source between
    a stop and the next start, and nothing needs to: the runtime opens every
    subscription span with a fresh version, so a tab reconnecting after the gap
    never gets `up-to-date` for a value it read before it (`resource-runtime/CLAUDE.md`).
  - **`revalidate`** (both arms, never a snapshot): the ETag signature, passed through
    (read path only; co-produce it with the loader, e.g. `createSignedMemo`).
  - **A refused question is a declared refusal.** A loader that cannot answer
    well-formed params as asked (a missing file, an unknown id, an empty
    range) throws a `ResourceRefusal` (`packages/resource-protocol`) whose
    `code` the `liveValue` declares — `refusals: z.enum(["missing", "denied"])`
    or the same as a const list (`["missing", "too-large"]`), on any form
    (params, typed params, typed-query, paged). The declaration then carries
    `refuse(code, message)`, the refusal to throw with its code typed
    (`throw fileText.refuse("missing", "no such file")`; a value that declares
    none has no `refuse` — tsc); a domain may subclass instead
    (`MetricQueryError`, code `invalid-query`). Wire: HTTP 422 `{ reason:
    "refused", code, detail }`, WS `sub-error { reason: "refused", code,
    message }`. The reader's error arm is `kind: "refused"` with `error.code`
    typed by the declaration (`useLive`'s result is `ResourceResult<T, C>`), so
    a surface branches on `refused`/`missing` apart from a real failure;
    `ResourceErrorInline` shows the message and offers no Retry; it is never
    retried, never counted as a failing read and never reported as a server
    failure. Both ends check the code: the runtime turns an undeclared one into
    `loader-failed` (reported), and the client reads an undeclared one — the
    server's declaration is not its bundle's — as a `contract-mismatch`
    (`client-outdated`, verdict `skew`). Anything else a loader throws is
    `loader-failed`, reported.
  - Not spelled: `ackChannel` (an optimistic reader asks for acks on its own
    subscription), a read-side `select`, row-scoped `recomputeOn` edges (an
    upstream's change recomputes whole tuples) — see
    `research/2026-09-26-global-live-values-migration-contract.md`.
- **Central.** `liveValue(key, { …, origin: "central" })` declares a value the
  machine-wide central runtime serves (`LiveValue<T, P, "central">`; the browser
  subscribes over the central socket; never preloaded). It is served by
  `network/live/central`'s `serveValue` — external arm only (central has no
  change feed), registered by the central plugin's `resources: [served]`, so no
  `declare`. Each `serveValue` rejects the other origin's value (tsc).
- **One serving code path — `serveValueOn(rt, value, opts, { sources })`**
  (`core/internal/serve-on.ts`, browser-safe). Every host's `serveValue` is a
  thin wrapper over it: it registers on the host's `LiveRuntime` (the
  `defineResource` / `defineExternalResource` pair of a `ResourceRuntime`),
  builds the served object, `notify` by params or by question, a paged
  value's meta sibling. `sources` is the arms the host serves —
  `"db+external"` (the Bun server, which adds `declare` and a param'd
  preload's boot tuples) or `"external"` (central, a browser server): it
  narrows `opts.source` in the types, and a cast past it throws. The hosts'
  public overloads are their own, so a call site never sees it. It and
  `serveCollectionOn` are exported from `network/live/core` for a host that
  is not a plugin runtime; the resource vocabulary classifies them as serving
  primitives, not factories (a test serving declarations on a bare runtime —
  `browser-server/core/testing`'s `inRealmServer` — calls them directly; a
  browser host boots a plugin graph and serves through the plugins' own
  `serveValue`). The external served shapes (`ExternalNotifiedValue`,
  `ExternalSilentValue`, …) stay exported; central's `Central*` types alias them.
- **Read.** `useLive(value, params?)` → `ResourceResult<T>` (it delegates to
  `useResource`, which canonicalizes the params); a `load: "snapshot"` value's
  is `LiveSnapshotResult<T>` — the same plus `refresh()` (its HTTP refetch:
  the re-measure), typed only there. A value with no
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
  - **Many tuples — `useLive(value, [p1, p2, …])`** (a param'd value; a
    typed-query value takes `[q1, q2, …]`, each encoded to its one tuple):
    `readonly ResourceResult<T, C>[]`, one result per entry IN ORDER, each
    exactly the single read's (a snapshot value's adds `refresh()`), for a
    dynamic set — a tree's expanded folders, a peek per row. A `null` entry is
    a skip (`loading`, nothing read). Read through live-state's `useResources`:
    the set moves by DIFF, so a tuple kept across a change (moved, or with
    others added or removed around it) stays subscribed, keeps its settled
    result and its `data` identity; the same tuple listed twice (an absent
    optional param spelled either way) is read once. An object is always the
    single-tuple form and an array the list form, so they never overlap: a
    param-less value has no list form (tsc), a paged value reads one question
    (tsc, and a throw), and a typed-query value's question schema may not be
    a list itself (`z.array` / `z.tuple`, through wrappers and unions — the
    declaration throws). Pinned by `web/__tests__/use-live-list.test.tsx`.

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
  changes: "notified",
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
  and the served half (`core/internal/compile-value.ts`) use.
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

## Desktop-only reads — `needsMachine`

A read only the desktop app's own server can answer (it reads the computer: a
checkout, a process, the host) is declared so — an OPTION on the declaration
that `useLive` reads (the design rule above), never a new hook. Design:
`research/2026-10-18-global-portable-server-machine-split.md` §1d.

```ts
// core/
export const checkoutStatus = liveValue("x.checkout-status", {
  schema: StatusSchema,
  needsMachine: { feature: "Reading the checkout" },   // also on liveCollection
});
// machine/ — never server/
import { serveValue } from "@plugins/network/plugins/live/machine";
export const checkoutStatusServed = serveValue(checkoutStatus, { source: "external", … });
// web/
const r = useLive(checkoutStatus);   // ResourceResult<T> | { status: "unavailable"; message }
```

- **Declare.** `needsMachine: { feature }` on every `liveValue` form and on a
  window, lookup-only or `all` `liveCollection` (not a union: its arms are
  served by their own plugins — a throw for an untyped caller). The
  declaration's type carries it per def, as `origin` does: `LiveMachineDecl`
  (`needsMachine: MachineFeature`) or `LivePortableDecl` (`needsMachine?:
  undefined`); a paged value carries it as `LivePagedValue`'s own `NM` type
  argument (so a serve or read still infers `Item` / `Meta` from the
  declaration), and its meta sibling inherits it (`host-fs.list`). A reader
  of a paged value that does not take `NM` (data-view's
  `useLivePagedValuePaging`) accepts only a portable one (tsc).
- **Serve.** `live/server`'s `serveValue` / `serveCollection` take only a
  portable declaration; `live/machine`'s — the SAME overload set
  (`ServeValueOverloads<H>` / `ServeCollectionOverloads<H>`, `H` intersected
  into each overload's declaration) and the same body (`serveAnyValue` /
  `serveAnyCollection`, over the untouched core `serveValueOn` /
  `serveCollectionOn`) — only a machine one. Each is a tsc error on the
  other's declaration. A central value is served by `live/central` as before.
- **Read.** `useLive` / `useLiveRow` wrap every overload's result as
  `WithMachine<NM, R>` — `R | LiveUnavailable` exactly when the declaration
  needs the computer, `R` otherwise (portable consumers are untouched). Under
  a transport with no computer behind it (`Transport.machine` false — the
  demo's browser server) the read is `{ status: "unavailable", message }`
  from the first render (`unavailableMessage(feature)`, endpoints core) and
  NOTHING is read: `useLive` holds it as its own read kind (`"unavailable"`,
  the kind latch — the transport and the declaration are both fixed for a
  call site), and `useLiveRow` reads with the substrate's skip (`null`
  params). A reader gating a control on it before reading uses endpoints'
  `useMachineAvailability(declaration)`.
- Pinned by `web/__tests__/use-live-machine.test.tsx` (the unavailable arm
  under `machine: false`, no subscription; the ordinary read under the
  page's server; the types) and `machine/internal/serve.test.ts` (each
  barrel refuses the other's declaration; a machine value serves).

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
`Suspense*` / `useQueries` siblings) — resolved like the rule above — a
`fetchEndpoint(...)` call inside a `queryFn` property, and three hidden reads
(research/2026-10-11-global-endpoint-reads-onto-live.md P0.2):

- a `fetchEndpoint` of a **GET** endpoint, or a `readNdjson` stream over a GET
  route, that runs as a read — in render, in a hook body, in
  `useEffect` / `useLayoutEffect` / `useMemo`, or in a named function one of
  those calls (a `useCallback` refresh an effect runs, a module helper). GET-ness
  is the endpoint's literal `route` type, read by the type checker; a route type
  that is not a literal counts as a GET. A call in an `on*` handler, a
  `mutationFn` or an event-registrar callback is an action and is not flagged;
  a function that escapes the file (stored in an object, passed as a non-`on*`
  prop, returned, exported) is unflagged — a one-file lint cannot see where it
  runs;
- `invalidateQueries` / `refetchQueries` over an endpoint read's query key
  (`endpointQueryKey(...)` or the raw `["endpoint", …]` spelling).

A server read is a `liveValue` (`params`, a typed `query`, or `paged`) or a
`liveCollection`, read with `useLive`; an imperative `fetchEndpoint` (a
mutation, a handler) is a write and is not flagged. Sanctioned: the substrate
that defines or wraps these hooks (`infra/endpoints`, `primitives/live-state`,
`network/live`). Every other current site is a file-level `debt` entry
(task-1791560308-woqgfi) in its plugin's `exempt/index.ts`
(`./singularity exempt list --rule live/no-endpoint-read --debt`): migrate,
never add one.

## Internals

- `core/` (browser-safe): `liveCollection(key, { …fields, id, sortable, default, maxLimit, preload? })`
  (or `{ …fields, id }` alone — lookup-only, minting `` `${key}:rows` `` only; or
  `{ …fields, id, all, preload? }` — the whole ordered set, minting `key` through
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
  `contract-mismatch` (`ResourceContractError`). A scoped set (`all: { by }`)
  is exactly its `by` fields (`{ pageId: string }`), each the canonical text
  of its column's type (the server gate). An `all` collection's `:rows`
  takes the point params like any other.
- Typed-query value: `{ q: string }` — the question's `canonicalJson` (a
  paged value's meta sibling too). Paged value: `{ q: string; limit: string;
  after?: string; until?: string }` — the question, the page's limit and its
  cuts, exactly a collection window's (server-minted `$key`s, verbatim; absent at
  the order's start / end), so page 0 at the declared limit is `{ q, limit }`.
- Decode is STRICT for all of them: the filter through `decodeFilter` (throws
  unless exactly canonical), the rest by re-encoding — so one logical query
  can never name two subscriptions.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Unified live-resource API, read half: useLive (a collection's window — where/orderBy/limit with canGrow/growing/loadMore — a grouping of a filterable column's values with counts, grown by its limit, a collection declared `all` whole — every row in its declared order, or a select-scoped slice of it — or an explicit id set), useLiveRow (one row: loading, failed, found, or determinately absent), with mapRow reducing a row read to a ResourceResult of what the row means; useLive also reads a typed-query liveValue (its question encoded to one canonical tuple); every collection's window — and a key-range-paged liveValue — is read as key-range pages — bounded windows tiling the order by server-minted row-key cuts, split when full and merged when small — given a measured viewport (useLive(c, q, { viewport })) with no depth limit, the pages near it live and the rest held stale up to a per-reader budget, past which they are height-keeping placeholders drawn before and after the rows, and without one every page live, capped at maxLimit rows; FieldPresentation.Register presents an owner's fields — an entity's own, an extension's exposed ones, a union arm's, a collection's own — with their cells, widths and live options in every list that reaches the owner, read by useFieldPresentations. Unified live-resource API, server half: serveValue (a liveValue's loader, from Postgres — change-feed driven, a collection-shaped payload must declare `unbounded: { reason }` — or from an external source with notify(); pushed by default, or refetched over HTTP when the liveValue declares `load: "on-demand"`; a typed-query value's hooks and notify take the decoded question, and a key-range-paged one — external only — is loaded one key range at a time, each answer checked against its range and minted its `$key`, notify(q) reaching every subscribed page and the per-question meta sibling, and sliceRange answers a range for a list held in memory) and serveCollection (binds a liveCollection's row fields to a table's columns — the projection is exactly the row schema — ANDs an optional base `where` into every read, and compiles its window + `:rows` point resources through windowQueryResource and its `:groups` GROUP BY push value — only `:rows` for a lookup-only collection, and the whole ordered set (`key`, a routed scopedMembership alias compiled by compileAllCollection) + `:rows` for one declared `all` — encoding a column type's declared wire form in JS per row; a collection reaching an entity compiles at boot, folding every LiveColumns.Expose contribution of an extension exposing fields of it — and a `columnScope` collection every LiveColumns.Scoped set — into its rows' `$columns`) — or, `source: "external"`, from a source outside Postgres that answers window / rows / groups / count / all by hand (core's serveCollectionOn: every answer checked against the row schema, every window row's `$key` minted, notify() re-reading the subscribed tuples); every filter compiles through the filter language's filterSql. Unified live-resource API, central half: serveValue for a liveValue declared `origin: "central"` — the external arm only (central has no change feed), registered through the central plugin's `resources: [served]`; its options compile through the same code as the worktree serveValue.
- Web:
  - Slots:
    - `FieldPresentation.Register`
    - `ClientFields.Resolve`
  - Slot contributors: 39 contributors — full list in [REFERENCE.md](./REFERENCE.md)
    - `FieldPresentation.Register` ×36
    - `ClientFields.Resolve` ×3
  - Uses:
    - `primitives/live-state.PagedResourceResult`
    - `primitives/live-state.ResourceDerivation`
    - `primitives/live-state.ResourceDescriptor`
    - `primitives/live-state.ResourceError`
    - `primitives/live-state.ResourceResult`
    - `primitives/live-state.ResourceTupleResult`
    - `primitives/live-state.ResourceUnavailable`
    - `primitives/live-state.useResource`
    - `primitives/live-state.useResources`
    - `primitives/log-channels.clientLog`
    - `primitives/networking.useTransport`
    - `primitives/slot-render.renderIsolated`
  - Exports (types):
    - `ClientFieldReaders`
    - `ClientFieldsResolution`
    - `ClientFieldsResolverProps`
    - `ClientFieldValues`
    - `FieldPresentationRegistration`
    - `FieldPresentationSpec`
    - `FieldsCollection`
    - `LiveAllSelect`
    - `LiveFieldOption`
    - `LiveFieldOptionsRead`
    - `LiveIdsQuery`
    - `LiveListResult`
    - `LivePageError`
    - `LivePagePlaceholder`
    - `LivePagesQuery`
    - `LivePagesResult`
    - `LiveRowResult`
    - `LiveSnapshotResult`
    - `LiveValuePagesOptions`
    - `PagesTruncation`
    - `PresentationOwner`
    - `StoredClientFieldsResolution`
    - `StoredFieldPresentation`
    - `VisibleRange`
  - Exports (values):
    - `ClientFields`
    - `clientFieldsKey`
    - `collectionPresentationKey`
    - `FieldPresentation`
    - `mapRow`
    - `mintVisibleRange`
    - `presentationOwnerKey`
    - `renderClientFieldsResolver`
    - `useClientFieldsResolvers`
    - `useFieldPresentations`
    - `useLive`
    - `useLiveRow`
- Server:
  - Uses: 29 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `infra/query-resource` ×26
    - `database/sql-column` ×2
    - `network/live/filter.filterSql`
  - Exports (types):
    - `AllCollectionSpecs`
    - `AllWhereColumns`
    - `CollectionSource`
    - `CollectionSpecs`
    - `ColumnOverride`
    - `CompiledPagedValue`
    - `CompiledValue`
    - `DeclaredCollection`
    - `DefaultScope`
    - `LiveValueSource`
    - `LookupCollectionSpecs`
    - `ScopedMemberRead`
    - `ServeAllCollectionOptions`
    - `ServeCollectionOptions`
    - `ServedAllCollection`
    - `ServedArm`
    - `ServedCollection`
    - `ServedExternalQueryValue`
    - `ServedExternalValue`
    - `ServedLookupCollection`
    - `ServedPagedValue`
    - `ServedScopedColumns`
    - `ServedSilentPagedValue`
    - `ServedSource`
    - `ServedUnion`
    - `ServedValue`
    - `ServePagedValueOptions`
    - `ServeUnionOptions`
    - `ServeValueOptions`
    - `UnionArmBinding`
    - `UnionArmColumns`
    - `UnionArmRefs`
    - `UnionDerived`
    - `UnionFieldBinding`
  - Exports (values):
    - `compileCollection`
    - `compilePagedValue`
    - `compileQueryValue`
    - `compileValue`
    - `LiveColumns`
    - `serveCollection`
    - `serveScopedColumns`
    - `serveUnionCollection`
    - `serveValue`
    - `sliceRange`
- Core:
  - Uses: 22 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `fields` ×6
    - `network/live/filter` ×6
    - `primitives/live-state` ×6
    - `packages/resource-protocol` ×2
    - `infra/query-resource.KIND_RE`
    - `packages/canonical-params.canonicalJson`
  - Exports (types):
    - `ClientFields`
    - `ClientFieldsOwner`
    - `ClientFieldsOwnerRow`
    - `ClientFieldValue`
    - `CollectionRow`
    - `ContributedColumns`
    - `DomainOfValue`
    - `ExternalAllCollection`
    - `ExternalLookupCollection`
    - `ExternalNotifiedPagedValue`
    - `ExternalNotifiedQueryValue`
    - `ExternalNotifiedValue`
    - `ExternalSilentPagedValue`
    - `ExternalSilentValue`
    - `ExternalSourceRow`
    - `ExternalWindowCollection`
    - `FieldsFilterable`
    - `FieldsRow`
    - `LabelledKeys`
    - `LiveAllCollection`
    - `LiveAllOrder`
    - `LiveArm`
    - `LiveArmColumnsHandle`
    - `LiveArms`
    - `LiveArmsCollection`
    - `LiveBytesBrand`
    - `LiveBytesParamValueSpec`
    - `LiveBytesQueryValueSpec`
    - `LiveBytesSpecBase`
    - `LiveBytesTypedParamValueSpec`
    - `LiveCentralValueSpec`
    - `LiveCollection`
    - `LiveCollectionChange`
    - `LiveCollectionChanges`
    - `LiveCollectionOf`
    - `LiveColumnFilter`
    - `LiveColumnRef`
    - `LiveColumnRefOwner`
    - `LiveColumnsDeclaration`
    - `LiveColumnsOwner`
    - `LiveCountCodec`
    - `LiveCountDescriptor`
    - `LiveCountedCollection`
    - `LiveCountParams`
    - `LiveCountQuery`
    - `LiveCutKey`
    - `LiveDecodedCountQuery`
    - `LiveDecodedGroupQuery`
    - `LiveDecodedQuery`
    - `LiveExposedColumns`
    - `LiveExposes`
    - `LiveField`
    - `LiveFieldIds`
    - `LiveFields`
    - `LiveFieldsDefault`
    - `LiveFieldsForm`
    - `LiveFieldsSpec`
    - `LiveFilterable`
    - `LiveFilterableOf`
    - `LiveFrom`
    - `LiveGroup`
    - `LiveGroupableColumn`
    - `LiveGroupableDomain`
    - `LiveGroupCodec`
    - `LiveGroupParams`
    - `LiveGroupQuery`
    - `LiveGroupsDescriptor`
    - `LiveGroupValue`
    - `LiveHost`
    - `LiveHostSource`
    - `LiveHostSources`
    - `LiveKeyCut`
    - `LiveKeyDirection`
    - `LiveKeyRange`
    - `LiveLookupCollection`
    - `LiveMachineDecl`
    - `LiveNoWindowCollection`
    - `LiveOrderBy`
    - `LivePageBounds`
    - `LivePagedCodec`
    - `LivePagedKey`
    - `LivePagedPages`
    - `LivePagedParams`
    - `LivePagedSpec`
    - `LivePagedValue`
    - `LivePagedValueSpec`
    - `LiveParamValueSpec`
    - `LivePlainValue`
    - `LivePortableDecl`
    - `LivePreload`
    - `LivePreloadedParamValue`
    - `LivePreloadedParamValueSpec`
    - `LiveQuery`
    - `LiveQueryCodec`
    - `LiveQueryParams`
    - `LiveQuerySchema`
    - `LiveQueryValue`
    - `LiveQueryValueSpec`
    - `LiveRefusals`
    - `LiveRefusalsBrand`
    - `LiveRelated`
    - `LiveReservedColumn`
    - `LiveRowSchema`
    - `LiveRowsCollection`
    - `LiveRuntime`
    - `LiveScopedColumns`
    - `LiveSnapshotBrand`
    - `LiveSortDirection`
    - `LiveTooLarge`
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
    - `NotCollectionRow`
    - `RequireLabel`
    - `RowKind`
    - `ScopedColumnMember`
    - `ServedExternalAll`
    - `ServedExternalLookup`
    - `ServedExternalResource`
    - `ServedExternalWindow`
    - `ServedPagedOn`
    - `ServedValueOn`
    - `ServeExternalAllOptions`
    - `ServeExternalLookupOptions`
    - `ServeExternalWindowOptions`
    - `ServeValueOnOptions`
    - `WithContributedColumns`
  - Exports (values):
    - `clientFields`
    - `exposedColumns`
    - `isPointId`
    - `LIVE_COLUMNS_KEY`
    - `LIVE_QUERY_MAX_BYTES`
    - `LIVE_ROW_KEY`
    - `LIVE_ROW_KEY_MAX_BYTES`
    - `LIVE_SCOPED_KEY`
    - `liveArm`
    - `liveCollection`
    - `liveValue`
    - `rowKind`
    - `scopedLiveColumns`
    - `serveCollectionOn`
    - `serveValueOn`
- Cross-plugin:
  - Imported by: 276 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×75
    - `conversations` ×50
    - `debug` ×27
    - `tasks` ×27
    - `infra` ×16
    - `active-data` ×12
    - `page` ×12
    - `primitives` ×10
    - `build` ×6
    - `stats` ×5
    - `code-explorer` ×4
    - `plugin-meta` ×4
    - `auth` ×3
    - `review` ×3
    - `ui` ×3
    - `apps-core` ×2
    - `config_v2` ×2
    - `history` ×2
    - `integrations` ×2
    - `release` ×2
    - `search` ×2
    - `backup/runs-arm`
    - `database/query-deadline`
    - `fields/secret/config`
    - `hints`
    - `reports`
    - `runs`
    - `shell/notifications`
- Exemptions:
  - Exempts itself from:
    - `live/no-legacy-resource-spelling` — `.` (sanctioned)
    - `live/no-endpoint-read` — `web` (sanctioned)
    - `no-raw-websocket` — `e2e/narrowing.ts` (sanctioned)
  - Exempted by:
    - `build/build-commits` (1 debt)
    - `build/build-fix` (1 debt)
    - `build/build-info` (1 debt)
    - `build/build-logs` (1 debt)
    - `build/build-profiling` (1 debt)
    - `build/serve-composition` (1 debt)
    - `debug/profiling/build` (1 debt)
    - `debug/slow-ops/cluster` (1 debt)
    - `debug/timeline` (1 debt)
    - `debug/worktree-cleanup` (1 debt)
    - `framework/central-core` (0 debt)
    - `framework/resource-runtime` (0 debt)
    - `framework/server-core` (0 debt)
    - `infra/endpoints` (0 debt)
    - `infra/events-test` (1 debt)
    - `infra/query-resource` (0 debt)
    - `network/live` (0 debt)
    - `plugin-meta/plugin-health` (1 debt)
    - `primitives/data-view` (0 debt)
    - `primitives/live-state` (0 debt)
    - `primitives/optimistic-mutation` (0 debt)
    - `screenshot` (1 debt)
    - `ui/icons/sprites` (1 debt)
- Machine:
  - Exports (values):
    - `serveCollection`
    - `serveValue`
- Central:
  - Exports (types):
    - `CentralServedPagedValue`
    - `CentralServedQueryValue`
    - `CentralServedValue`
  - Exports (values):
    - `serveValue`
    - `sliceRange`
- Test helpers:
  - Web: `@plugins/network/plugins/live/web/testing`
    - `pageZeroParams` — The tuple a paged read of `collection` subscribes for its first page, asked nothing (`{}`): the page plan's start page, encoded by the collection's page source.
  - Server: `@plugins/network/plugins/live/server/testing`
    - `checkPagedSource` — Ask `loader` every range over the items' and `cuts`' keys and throw — naming the range, the answer and the expected ids — on the first answer that differs from `sliceRange` or fails the served half's checks.
    - `compileCollection` — Derive the specs for a collection — three, or just `rows` for a lookup-only one.
    - `compileUnion` — Derive a union collection's three server halves.
    - `subscribeAsOldDescriptor` — Subscribe `old.key` on the server runtime as an old bundle's tab would — its own socket, `params` (default `{}`: a legacy param-less descriptor sent nothing), its `build` graph when given — and answer what that tab gets: the first `sub-ack` or `sub-error` for the tuple, the ack's value parsed with the OLD schema.
    - Types: `OldDescriptor`, `OldSubscription`, `PagedSourceCheck`
- Sub-plugins:
  - **`filter`** — The filter language's SQL half: renderOpSql renders one op's dialect-free template over a rendered target (operands as params cast to the domain's SQL type, lists as ONE array param), and filterSql…

<!-- AUTOGENERATED:END -->
