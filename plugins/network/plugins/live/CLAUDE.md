# live

Rationale (why each rule is so, rejected alternatives): [DESIGN.md](DESIGN.md) — read before changing or removing a rule.

The unified live-resource API: **the default for every new DB-backed collection
and every new value.** Declare in `core/` (`liveCollection` / `liveValue`),
serve in `server/` (`serveCollection` / `serveValue`, spread `.declare` into
`contributions`), read in `web/` (`useLive`, `useLiveRow`). Design:
`research/2026-09-25-global-unified-live-resource-api.md`.

## Design rule — grow `useLive`, don't add APIs

- A new way to read server data is an **option on `liveValue` /
  `liveCollection` that `useLive` reads** (overloaded by the descriptor's type)
  — never a new hook or read function. A new hook needs a recorded reason in
  a research doc ("`useLive` cannot express X because …").
- **The one read function beside it: `useLiveReader`** — for a question an
  event asks and its own `await` consumes (validate then act). Same
  declarations, tuple, refusals and transport; banned wherever `useLive` fits
  (render, hook body, effect). Reason:
  `research/2026-10-26-global-browser-reads-only-through-live.md` §2.
- Existing exceptions: `useLiveRow` (pending unification into `useLive`) and
  `optimistic-mutation`'s `useOptimisticResource` (read+write).

## Shape vs freshness

Two independent questions, declared in two places:

- **Shape** (how much of a list the browser holds) — on the DECLARATION
  (`core/`), whatever the source: a window's `maxLimit`, `all: { max }` or
  `all: { unbounded: { reason } }`, `:rows`' `maxIds`, a value `paged` by key
  ranges, and every other list in a payload/row marked in its zod schema with
  `packages/list-bound` — capped (`cappedList` / `cappedRecord`, `.max(n)`) or
  whole (`wholeList` / `wholeRecord` + reason). A bare list throws at
  declaration (`BareListError`).
- **Freshness** (how the server learns the answer changed) — on the SERVE
  call: the change feed (SQL arm default), or `changes: "notified"` /
  `{ fixed }` / `{ immutable }` / `{ snapshot }`.

The source never decides the shape: a table outside the feed still pages
through compiled SQL, and an in-memory array is no more bounded than a table.

## Usage

```ts
// core/ — declare once
export const orders = liveCollection("shop.orders", {
  // the entity the rows are (or an extension shape)
  from: ordersEntityRef,
  // listed fields (labelled, filterable in their domain)
  pick: ["status", "paid", "total"],
  carry: { pick: ["id", "createdAt"] }, // on the row, in no list
  id: "id",
  sortable: ["createdAt", "total"],
  default: { orderBy: [["createdAt", "desc"]], limit: 100 },
  maxLimit: 500,
  preload: "none", // or "boot" / "boot-and-keep"
});

// server/
export const ordersServed = serveCollection(orders, {
  from: _orders,
  // where, joins, columns, …
});
// contributions: [...ordersServed.declare]

// web/
useLive(orders); // default window
useLive(orders, {
  where: { paid: true },
  orderBy: [["total", "asc"]],
  limit: 50,
});
useLive(orders, {
  where: or(
    { column: "status", op: "eq", operand: "refunded" },
    { column: "paid", op: "eq", operand: false },
  ),
});
// values + counts
useLive(orders, { groupBy: "status", where: { paid: true } });
// needs `count: true`
useLive(orders, { count: true, where: { paid: true } });
useLive(orders, { ids: visibleIds }); // point set
useLiveRow(orders, orderId); // one row

// whole ordered set
export const graphNodes = liveCollection("graph.nodes", {
  carry: { fields: graphNodeFields },
  id: "id",
  all: {
    orderBy: [["createdAt", "asc"]],
    unbounded: { reason: "the graph view lays out every node" },
  },
  preload: "boot",
});
useLive(graphNodes);
useLive(graphNodes, { select: countNodes }); // stable selector

// one tuple per scope
export const blocks = liveCollection("page.blocks", {
  from: blocksEntityRef,
  pick: ["id", "pageId", "rank"],
  id: "id",
  all: {
    by: ["pageId"],
    orderBy: [["rank", "asc"]],
    unbounded: { reason: "one page's blocks" },
  },
});
useLive(blocks, { where: { pageId } });
```

### Collection forms

| Form | Declared with | Mints | Reader type |
|---|---|---|---|
| Window | `default` + `maxLimit` (+ `sortable`, `count?`, `columnScope?`) | `key`, `key:rows`, `key:groups` (+ `key:count`) | `LiveCollection` |
| Lookup-only | neither `default` nor `all` | `key:rows` | `LiveLookupCollection` |
| Whole set | `all: { orderBy, max \| unbounded }` | `key` (param-less), `key:rows` | `LiveAllCollection<Row>` |
| Scoped set | `all: { by, orderBy, … }` | `key` (params = `by` fields), `key:rows` | `LiveAllCollection<Row, B>` |
| Union | `arms: { discriminator }` | as window | `LiveArmsCollection` (see *Union collections*) |

- **Key** is a positional string literal (build scanners read it). Not loaded
  yet is `pending`, never `[]`.
- **Window bounds.** `default.limit` and `maxLimit` required, `maxLimit ≥ 2 ·
  default.limit` (throws). A grouping returns at most `LIST_MAX` (100) groups.
- **Totals — `count: true`.** The author's statement that a COUNT is cheap
  enough to keep live (recomputed on every write to a read table — leave it
  off large/write-hot tables). Mints `key:count`; a DataView over it shows
  exact section counts instead of "N+". Not on a union yet.
- **Id sets are capped — `maxIds`.** Every `:rows` tuple (`{ ids }`,
  `useLiveRow`, `useOptimisticResource(c, { ids })`, `preloadRows`) holds at
  most `maxIds` ids: `encode` throws past it, decode refuses
  (`contract-mismatch`). Default `maxLimit`, an `all` set's `max`, else
  `LIVE_DEFAULT_MAX_IDS` (500). Read back as `c.rows.point.maxIds`.
- **Lookup-only.** For tables only ever read by id (one row per mounted
  block). Window fields and `preload` are `never`; a list read is a tsc error.
  `:rows` routing is what "subscribe to one row" means — prefer it to a
  param'd value over a one-row table.
- **`all`.** Every row in `orderBy` (row fields; id breaks ties), for a set
  small enough to hold whole whose readers need all of it. Exactly one of
  `max` (a positive integer) or `unbounded: { reason }`. `max` is never a
  silent truncation: the schema is `.max(max)` and a load past it is a loud
  loader error. No `:groups`; window/union fields are `never`.
  - **Scoped — `all: { by }`.** Params are exactly the `by` fields, each a
    non-empty string (canonical text of a text/uuid/integer column). `by` never
    names the id; `preload` is `never` (boot has no tuple). `:rows` stays
    global. Postgres only (the external arm refuses it). A write to another
    scope reaches no tuple; a move between scopes is an exit + an entrant.
  - **C39 — converting a key under the same name.** The params gate is no skew
    signal for a param-less predecessor: an old bundle subscribing the same key
    with `{}` passes and parses the new rows with ITS schema. A converting step
    must prove `parsed` with `server/testing`'s `subscribeAsOldDescriptor({ key,
    schema })` (→ `refused` / `parsed` / `parse-failed`), or rename the key.
- **Preload.** `"boot"` / `"boot-and-keep"` pins the owning plugin eager and
  hydrates ONE tuple before first paint: a window's default window, an `all`
  set's `{}`, a declared `:count`'s `{}`. `"boot-and-keep"` also keeps it
  resident. `:groups` is never preloaded; `:rows` only via
  `serveCollection(c, { preloadRows: { idsOf: other } })` — the id set of
  another preloaded `all` collection's boot value (the queue's ranks). Default
  `"none"`. Scanners read the flag through `tooling/resource-vocabulary`.
- **A row's own lists carry their bound.** `liveCollection` walks its row
  schema with `packages/list-bound` and freezes `c.shape`; a bare
  `jsonField` array/record throws at declaration (`stringListField` /
  `tagsField` are marked whole by their factories).
- **Collection rows are marked** `CollectionRow<Row>` (type-only key). A
  DataView's hand-`fields` arm takes `NotCollectionRow` rows only, so a list
  over a collection derives its fields (`collection=`) instead of restating
  them.

### Serve — `serveCollection(c, { from, joins?, where?, defaults?, columns?, … })`

Binds every ROW field to a column of `from` BY PROPERTY NAME (tsc); a field
with no same-named column is bound in `columns: { name: (j) => j.base.col }`
(throws at module eval if still unbound).

- **`from` is the entity the rows are.** `ServedSource` = an Entity, an
  extension handle, or a `defineEntity` `EntityTable` — a raw `pgTable` is a
  tsc error, never a view. `assertServesItsRows`
  (`server/internal/collection-source.ts`) throws unless the declared `from`
  names the served table. So a collection never restates its entity's fields
  — it `pick`s them; its own `fields` are only what it computes/decodes. A
  collection declared by own fields alone is `source: "external"` or a union.
- **Projection = the row schema's keys exactly**, so a server-only column
  never reaches the wire.
- **Joins.** `joins: [songPlayback.join("playback"), …]` (vocabulary:
  `plugins/infra/plugins/query-resource/CLAUDE.md`, *Joins*). A joined column
  binds via `columns: { x: (j) => j.playback.x }` — `j` offers only base and
  declared-join WIRE columns (tsc). A LEFT-joined field's schema must accept
  null (throws otherwise). A write to a joined table refills only the host
  rows it keys, in tuples whose SQL reads that join.
- **Expression fields.** `columns: { label: (j) => expr(sql\`…\`, { decoder,
  sqlType, notNull }) }` — filters/sorts/groups like a column; never the id.
- **`where`** — base membership, ANDed into window, `:rows` and groupings. A
  mutable column is fine (a flip is an exit). Over joins: `(j) => gt(j.x.y, 0)`.
- **`membership`** (declared on the `liveCollection`, core) — the base
  membership AS DATA: a `Filter` over listed fields (`as const`). Rendered by
  `filterSql` and ANDed with `where` on window, `:rows` and `all`; carried as
  `c.membership` (`{ filter, filterable }`) so a browser re-checks a row with
  `matchesFilter` (what a predicted write's overlay does). Each column binds
  to the base column of its name; a negative op KEEPS NULL (equal to SQL `<>`
  only on a NOT NULL column). Refused beside `arms` and on the external arm.
  Adopters: `conversations-active` / `-system`.
- **`defaults`** — `[{ unless: "sourceId", where: (j) => … }]`: ANDed into a
  window/grouping tuple UNLESS its filter names the `unless` column (a default
  the user overrides by asking about the column). Never on `:rows`.
- **Routing.** Each compiler emits the routes its SQL reads; the runtime's
  `routeTableChange` reaches exactly the tuples whose query reads the changed
  table (never via the loader read-set). Every table read must be triggered
  (change-feed boot assertion). Groupings and `:count` recompute on any write
  to their table (one `full` route); a byte-identical result is dropped.
- **Wire-encoded columns** (sql-column `withWire`, e.g. `bytea` → base64) are
  encoded in JS (`encodeRow`), never SQL. The row field must be the codec's
  wire type (tsc). Never filterable or the id (throws).
- Returns `window`, `rows`, `groups`, `keys`, `declare`. `compileCollection`
  is the same derivation without registering (tests).
- **The `all` arm** (`server/internal/serve-all.ts`): compiled by
  query-resource's `compileAllCollection` (*The `all` compiler*).
  - Routed `scopedMembership`: an insert is one refill + one `orderOf`, a
    delete/flip an exit.
  - Fields bind like a window's, or to an AGGREGATE of a children / closure
    join. A `jsonAgg` may hold the field's JSON form (a `Date` as ISO string);
    a scalar `aggregate` must hold exactly the field's type (its `timestamptz`
    text is Postgres's, not ISO — tsc).
  - `where` is static, never an aggregate; `throttleMs` is the flush throttle.
  - Refused: a wire-encoded value (an `all` set is L2-persisted and its
    definition cannot read encoder code), a NULL-able read on a non-null
    field.
- **The external arm — `source: "external"`** (`core/internal/serve-on.ts`'s
  `serveCollectionOn`; any host — central, a browser server — calls it on its
  own runtime). Rows outside Postgres, served through the same descriptors:

  ```ts
  export const ordersServed = serveCollection(orders, {
    source: "external",
    changes: "notified", // or { immutable | fixed: { reason } }
    // { limit, where?, orderBy, after?, until? } → rows
    window: (q) => store.window(q),
    rows: (ids) => store.byIds(ids),
    groups: (q) => store.groups(q), // optional
    count: (q) => store.count(q.where), // exactly when `count: true` (tsc)
    keyText: { total: (n) => pad(n) }, // every non-text sortable field (tsc)
    // "notified" only
    whileSubscribed: (notify) => store.watch(() => notify()),
    throttleMs: 1000, // "notified" only
  });
  ordersServed.notify({ ids: ["o1"] }); // or notify(): every subscribed tuple

  // `all`:  { source, changes, all: () => rows, rows }
  // lookup: { source, changes, rows }
  ```

  - **Every answer is checked** (loud loader error): rows against the schema,
    string ids, no duplicates, ≤ `q.limit`, strictly ascending `$key` order
    within `(after, until]`; `keyText.<field>` must give text whose code-point
    order is the field's order.
  - `notify({ ids })` narrows only `:rows` tuples; every window/`all`/groups/
    count tuple still re-reads (only the source knows membership). Re-reads are
    diffed by key.
  - `whileSubscribed` starts ONE watcher for the whole collection (refcounted
    over every tuple of every minted resource). Reference: `infra/jobs`.
  - Exposed fields read their defaults (`$columns: {}`); a source row carrying
    `$columns` throws. Refused: union, `columnScope`, a stray answer for the
    form, an empty `changes` reason.
- **The SQL arm off the change feed — `changes`** (`server/internal/serve-off-feed.ts`).
  A table its owner `ExcludeFromChangeFeed`s still pages through the same
  compiled SQL (filters, cuts, joins, groups, count); only freshness changes:

  ```ts
  serveCollection(archive, {
    from: _archive,
    changes: "notified", // or { fixed | immutable: { reason } }
    whileSubscribed: (notify) => onArchiveWrite(() => notify()),
    throttleMs: 1000,
  });
  ```

  Every table the SQL reads (base and joins) is declared unfed; change-feed's
  boot check refuses one the feed covers — so the owner must opt every read
  table out. No exposure folds (`$columns: {}`). Refused: `all`,
  `columnScope`, union.

### Read — `useLive(c, query?)` / `useLiveRow`

The query's SHAPE picks the resource. Queries are identified by canonical
encoding, so inline literals are fine; results keep identity until rows,
state or limit change.

- **Window** → `LiveListResult<Row>`: `ResourceResult<Row[]>` whose `ready`
  arm adds `canGrow`, `growing`, `loadMore()`. Every window is read as
  key-range pages (*Paged reads*): `loadMore()` SPLITS the last page, never
  reloads a larger window, and stays `ready` (`growing: true`) meanwhile.
  Caveats:
  - the cap stops one step short when `maxLimit` is not a multiple of the
    step (200/500 stops at 400);
  - any page's failure is the `error` arm with rows as `stale`;
  - a boot-hydrated page 0 can't seed its first split (logs `seed refused`,
    loads in full).
- **Grouping** `{ groupBy, where?, limit? }` → `LiveListResult<{ value: V |
  null; count }>`. `groupBy` is a filterable `text` / `number` / `boolean`
  column. Ordered count desc then value; NULL is its own group (`{ isEmpty:
  true }`). `orderBy` is a tsc error. Default limit 50, max `LIST_MAX`; the one
  read whose `loadMore()` reloads one tuple at a larger limit. To keep every
  chip visible while one is picked, leave the grouped column out of `where`.
- **Total** `{ count: true, where? }` → `ResourceResult<number>`; `null` reads
  nothing.
- **`{ ids }`** → `ResourceResult<Row[]>`, no paging. Throws on an id the
  point codec can't carry.
- **`all`** → `useLive(all)` / `useLive(all, { select })`: param-less tuple,
  no row map; `data` IS the shared cached array (structural sharing keeps
  unchanged rows' identity). Gated — a push that changes nothing selected
  re-renders nothing. Pass a stable selector (live-state CLAUDE.md, *Slice
  selectors*). **Scoped**: `useLive(c, { where: { pageId }[, select] })` —
  exactly the `by` fields as strings (tsc); a scope change reads `loading`.
- **`useLiveRow(c, id: string | null)`** → `loading | error (stale?) |
  ready+found+row | ready+!found`, with `refetch`. A point read ignores client
  filters and window bounds (the base `where` still applies): `found: false`
  means not in the collection. A `null` id, `""`, or an id containing `,`
  (`isPointId`) is `found: false` from the first render and reads nothing — a
  URL/agent-supplied id renders its not-found state.
  Ready arms carry `pending`: a predicted write still applies to the row here.
- **Optimistic reads** are `optimistic-mutation`'s `useOptimisticResource`
  over the same argument shapes (`(value, params?, opts)`, `(c, { ids },
  opts)`, `(c, { where }, opts)` for a scoped `all` set); `loading` until a
  real value lands, `dispatch` only on `ready`.
- `useLive` is watched by `live-state/no-pending-data-collapse`; both by
  `no-ready-negation` — never `status !== "ready"`.

## Predicted writes — `effect`, `useLiveMutation`, no pending state

Design: `research/2026-10-27-global-predicted-endpoint-effects.md`, gaps closed
in `research/2026-10-28-global-endpoint-prediction-decision.md` §3. A write
endpoint declares what it does to live data, so every surface reading it shows
the change at once; it has exactly one browser client, which cannot be awaited.

```ts
// core/ — on the endpoint (infra/endpoints' `effect`)
effect: (on) => patchRow(on, conversationsEntityRef, ({ params }) => params.id, () => ({
  set: { status: "done", workingOn: null },  // shown AND compared
  approx: { endedAt: new Date() },           // shown, never compared
})),
// web/
const close = useLiveMutation(exitConversation, { onSuccess?, onError?, label? });
if (close.kind === "available") close.mutate({ params: { id } });   // void
close.mutate(req, { onSuccess: () => onDone() });                   // this call's own callbacks
```

- **Builders** (`core/internal/predict.ts`), each taking `on` first so its
  callbacks are typed by the route:

  | Builder | Targets | Confirmed by |
  |---|---|---|
  | `patchRow(on, target, idOf, (req) => ({ set, approx? }))` | one row, in place | a row holding `set` |
  | `removeRow(on, target, idOf)` | one row, gone from every read | the row's absence |
  | `upsertRow(on, target, idOf, (row \| undefined, req) => row, { set? })` | one row that may be absent: it ENTERS a by-id read of its id and an `all` set it belongs to (its `by` scope; its `membership` when declared) | `set` when given, else commit |
  | `upsertRows(on, target, idsOf, (row \| undefined, req, id) => row, { set?: (req, id) => … })` | `upsertRow` per id (a decision for every task of a list) | per row, as `upsertRow` |
  | `applyRows(on, target, idsOf, (rows, req) => rows)` | held rows by id (an increment, ranks); a held row the reducer OMITS is removed (`() => []` removes them all) | commit |
  | `patchWhere(on, target, (req) => Filter, (row, req) => patch)` / `removeWhere(on, target, (req) => Filter)` | every HELD row matching the filter (over the target's filterable fields) | commit |
  | `patchValue(on, value, (req) => params, (value, req) => value)` | one value tuple (canonical params) | commit |
  | `choose(on, (req) => key, { [key]: effect })` | the branch the request picks (each built on `on`; a key with no branch throws) | the branch's |
  | `effects(...)` | several, in order (tightest `confirmWithinMs`) | each its own |

  `upsertRow(…, { set: (req) => fields })`; every builder takes
  `{ confirmWithinMs?, lane? }`. A `patchWhere` / `removeWhere` filter names
  the target's filterable fields — an entity's with a domain, or a `from:
  null` collection's listed ones plus its KEY columns (its id and `all.by`).
- **The target** (`PredictTarget`) is an ENTITY ref (every collection `from`
  it shows the prediction) or, for rows no entity names (an extension shape's
  side table, a collection of its own fields), ONE collection declared `from:
  null` — its own reads alone show it. Patches are typed by `TargetRow`: the
  entity's fields, or the collection's row. A collection `from` an entity is
  refused (tsc, and throws): target the entity.
- **Exposed fields** (an extension's `exposes`, riding the entity's rows under
  `$columns[<slice>]`) cannot be typed by the entity (it names none of its
  extensions), so the EXPOSURE is the target (`PredictPatchTarget`):
  `patchRow` / `applyRows` over `shape.exposure` patch the slice of every held
  row of the parent entity, typed by the slice (`TargetRow`); a row without
  the slice is left as it is, and an exposure reducer returns one slice per
  slice, in order (it cannot remove the entity's row). Reference:
  `playback-history`'s `recordPlay`.
- **One overlay per transport, keyed by SUBJECT** (`predictSubject`: an
  entity name, `collection:<key>`, `value:<key>`) and row id —
  `web/internal/predict-overlay.ts`, `use-predicted.ts`. `useLiveRow`,
  `{ ids }`, `all` and window reads of the subject fold the ops over their own
  server rows; `useLive(value, params)` folds `patchValue` (and
  `useLiveReader` answering an OBSERVED tuple does too). A row leaving the
  collection's `membership` is dropped.
  - **Entrants** — only an upsert, only into a read that admits it (a by-id
    read of its id: `found: false` → `found: true`; an `all` set, in its order,
    when the row's `by` fields spell the tuple's scope and it matches the
    collection's `membership` if one is declared — a collection with none
    holds every row of its `from`), shaped as its
    rows (`$columns` defaulted). A window never gains one (row key and counts
    are the server's), nor a read whose rows carry a field the prediction
    lacks.
  - **Ranks** — a read ordered by row fields re-sorts the rows a prediction
    moved in the order (`all` sets by `all.orderBy`, windows by their query's);
    one sorted past the last held row of a window with more rows leaves until
    the server's frame brings it where it lands. An order naming an exposed /
    scoped column moves nothing. Order fields are compared by `orderScalar`
    (`core/internal/order-value.ts`): a scalar, an instant, or a value object
    whose `toJSON()` is its wire scalar (a `Rank`) — and `sortable`,
    `default.orderBy` and `all.orderBy` are typed to exactly those fields
    (`OrderableKeys`), so an order the browser cannot re-sort is a tsc error.
  - A `where` target skips a read whose rows lack a column the filter names.
  - Never a grouping or a count; the window's own `where` is not re-checked. A
    read no op touches keeps its server data's identity.
- **Retirement is per tuple.** Each mounted read holds its tuple's data; on
  each data change, ack, ack frame and holder leaving, an op is `confirmed`
  (retired there for good), `needs` or `irrelevant`. DONE once acked and no
  holder needs it, so a stale list never re-shows a closed row. Push-based,
  never a timer.
- **Commit confirmation** — a target with nothing to compare. The server's
  `implement` runs every predicted handler under the database's commit
  capture (`infra/endpoints` `commit-capture.ts`, `database/server`
  `commit-capture.ts`) and names the transactions it committed in the ack
  (`x-equin-commits`) — the handler remembers nothing. A tuple confirms once
  its own frames have SEEN them: an `ackTx` naming one (Rule A — scoped deltas
  and standalone ack frames carry it), or a full frame's watermark past all
  of them (Rule B′). While such an op applies, the read asks for its tuples'
  ack frames (`requestAcks`), so a recompute that changed nothing visible
  still confirms. So an increment's +1 holds through an ack that lands before
  its frame. An ack naming no commit (a host with no async context — PGlite —
  or a write outside `db`) confirms at the ack, as before.
- **`useLiveMutation`** is the only client (`useEndpointMutation` /
  `FetchEndpoint` refuse a predicted def — tsc): `{ kind: "available",
  mutate(req): void } | { kind: "unavailable", message }`. No `isPending`, no
  promise, so no spinner. `onSuccess(response, req)` for what depends on the
  answer; `mutate(req, { onSuccess?, onError? })` adds callbacks of THIS
  call (run after the hook's), so nothing keys side state on the request
  object. A discriminated-union body is one request (`LiveMutationRequest` is
  non-distributive). The op's lifecycle belongs to the transport's writer: a control
  that unmounts on click still has its write sent, confirmed and timed.
- **Lanes.** Sent through `endpointContractOf(def)` on the send lane of EVERY
  target (`enqueueOnSendLanes` — each row, a filter part's subject lane, a
  value's tuple lane, which `useOptimisticResource` shares) so a later write
  to any of them departs after it; `lane: (req) => name` replaces a part's
  lanes with one named lane (per-parent order: every fader of a song). One
  lane registry with `optimistic-mutation`.
- **Failure — never-revert.** A permanent 4xx removes the op and emits
  `optimisticRejectionSink` (its collector toasts and reports — `onError` must
  not toast again); a transient failure keeps it (sync cloud: error + Retry);
  a network failure keeps it `syncing`, re-sent on reconnect.
- **Timing.** DONE emits the complete `confirm` sample (`predict/<route>`); an
  op not done by `confirmWithinMs ?? 10 s` emits a CENSORED one
  (`…/unconfirmed/awaiting-send | -ack | -confirm-frame`) — both reach
  `debug/slow-ops`.
- **Don't declare an effect** when the server mints an id the caller needs,
  the flow is driven by the response, or the server checks a precondition that
  can fail (409/400). Predict only what the REQUEST decides.
- Tests: `core/internal/predict.test.ts`, `web/internal/predict-overlay.test.ts`,
  `web/internal/send-lane.test.ts`, `web/__tests__/predicted-writes.test.tsx`,
  `web/__tests__/predicted-gaps.test.tsx`; server: `infra/endpoints`
  `core/commit-capture.test.ts`, `database/server/internal/commit-capture.test.ts`.
  Adopters: `exitConversation`, `dropAndExit`, `closeConversation`.

## Paged reads — key-range pages through `useLive`

Each page is one bounded tuple `(after, until]` at a `limit`; pages tile the
order by server-minted cuts. ONE planner (`shared/page-plan.ts`), ONE hook
(`web/internal/use-pages.ts`), ONE entry point (`useLive`). Two kinds of
source plug in through one seam (`web/internal/page-source.ts`): every
collection's window, and a value declared `paged`. Design:
`research/2026-10-09-global-live-key-range-pages-v2.md`,
`research/2026-10-11-global-live-paging-unification.md`.

- **D1 — a page is always a key range.** A cut is a POSITION (order keys then
  id), valid after its row is deleted, so pages are independent (released and
  re-subscribed alone) and an insert near the head never re-mints later pages.
  No cursor chains. A source with only forward tokens (`pageToken` /
  `nextCursor`) cannot be paged: use one bounded `liveValue`, or mirror into
  Postgres as a collection (as `mail.threads`).
- **D2 — the viewport only decides liveness.**

  | Read | Live pages | Depth | Result |
  |---|---|---|---|
  | `useLive(src, q, { viewport })` | band around the viewport (±1, hysteresis at 2); farther stale, then placeholders | Unbounded | `LivePagesResult<Row>` |
  | `useLive(src, q)` | every loaded page | `maxLimit` rows | `LiveListResult<Row>` |

- **D3 — one runtime path.** Every page is a keyed window membership entry;
  the source decides only how a change arrives (routed change for Postgres,
  `notify(q)` for an external value). Seeded split/merge and keyed deltas are
  shared.

### Collections — every window

- Nothing to declare: every window pages. `maxLimit` bounds one page's
  `limit`, not depth under a viewport.
- **`$key`** — every window row carries a server-minted key: canonical JSON of
  the order keys as exact Postgres `::text`, then the id (omitted if the order
  names it); `null` over `LIVE_ROW_KEY_MAX_BYTES` (1 KiB) — no cut there. On the
  window wire schema only; every read strips it.
- **Cuts** `after` (exclusive) / `until` (inclusive) are `$key`s verbatim —
  never derived on the client (a decoded row lost the exact text). Rendered on
  the ORDER side (keyset `seekPredicate`), never through `where`.

### Values — `liveValue(key, { query, paged })`

For an EXTERNAL source whose items have positions to cut at (a paged Postgres
list is a collection's window, never this).

```ts
// core/
export const metricDetails = liveValue("metrics.details", {
  query: DetailsSelectorSchema, // the question, without range or limit
  paged: {
    item: DrillItemSchema, // `$key` is reserved
    id: "id", // string field, unique per question
    // TEXT (or null) parts, one per direction
    key: { of: (i) => [i.at], order: ["desc"] },
    limit: 50,
    maxLimit: 500, // maxLimit ≥ 2 · limit
    meta: DrillMetaSchema, // optional → metricDetails.meta
  },
});

// server/ — external only; hooks take the DECODED question
serveValue(metricDetails, {
  source: "external",
  changes: "notified", // or { immutable | fixed }, never snapshot
  loader: (q, range) => readItems(q, range), // LiveKeyRange → readonly Item[]
  meta: (q) => ({ total: count(q) }), // exactly with `paged.meta`
  whileSubscribed: (q, notify) => watch(q, notify), // once per QUESTION
});

// web/
useLive(metricDetails, selector, { limit: 5 }); // LiveListResult<Item>
useLive(metricDetails, selector, { viewport }); // LivePagesResult<Item>
useLive(metricDetails.meta, selector); // ResourceResult<Meta>
```

- **Key contract.** `key.of(item)` returns one TEXT part per `order` direction
  (or `null`) whose code-point order IS the order — the source supplies
  precision (`toISOString`, zero-padded numbers); a number/`Date` part is a
  tsc error. Order (`core/internal/key-order.ts`): parts by code point,
  `null` LAST, then id ascending.
- **Loader answers one key range** (`LiveKeyRange`: `after` / `until` each
  `{ key, id } | null`, `limit`): items strictly after `after`, up to and
  including `until`, ≤ `limit`, in key order. A cut's row may be gone. Every
  answer is checked (`pageRowsOf`). In-memory sources: `sliceRange(value,
  items, range)` (`server`); verify a source with `checkPagedSource`
  (`server/testing`).
- No `schema`, `params`, `preload` or `load` (tsc + throw); pages are pushed
  keyed windows. Meta is a per-QUESTION sibling (`<key>:meta`, tuple `{ q }`),
  pending until known, never a page's.
- `notify(q)` re-reads every subscribed page of `q` and its meta;
  `whileSubscribed` is refcounted per question across pages + meta.
- Read options: no viewport → `limit` (`1..maxLimit`) is page 0's limit and
  the step; `limit` beside a viewport is a tsc error. No `{ first }`, no cursor.

### The read — `useLive(source, query, { viewport? })`

- **The seam** (`pageSourceOf`): INVARIANT — page 0 at the step is
  byte-identical to the source's plain default tuple (the one boot
  hydrates), so a paged and a plain reader share it.
- **With a viewport** → `LivePagesResult<Row>`: `loading | error | ready {
  rows; exhausted; canGrow; growing; loadMore; truncated; pageErrors;
  placeholders }`. A collection's query has no `limit` here.
  - **`viewport: VisibleRange` is branded** (`measuring` | `none` | first/last
    row on screen). Only data-view mints one (`mintVisibleRange`, enforced by
    the `live/visible-range-minter` lint); surfaces read pages through
    data-view's `useLivePagesPaging`. "Every page live" is the absence of the
    option.
- **Without** — every page live, capped at `maxLimit` rows; a page pushed past
  it by inserts is dropped.
- **Both modes:**
  - **One call site, one kind of read** — `useLive` throws if a later render
    asks a different kind (viewport vs none, count, ids, …).
  - **Split / merge.** `loadMore` splits the full last page at its last
    cuttable row: `(a, k]` at `2·step` and the new `(k, ∞)` at `step`. A full
    non-last page splits at its median. Adjacent pages holding ≤ `step` rows
    merge. New pages show their slice of the replaced rows (stale) until they
    land — never a flip back from `ready`.
  - **Seeded pages.** The known part of a split and a merge carry a `seed`
    (`derive`): the server answers from the snapshots it holds (same
    `familyOf`, quiescent) with no load; the unknown part is always read.
  - **Liveness.** Within one page of the screen: live; ≥3 away: released (rows
    kept stale, cache dropped via `release: "now"`); 2 away: unchanged. Live
    cost ≤ visible pages + 4.
  - **Stale budget → placeholders.** Released pages keep ≤ `8 · step` rows
    (`STALE_STEPS`); beyond that a page becomes a placeholder (`key` +
    `size`, never a row), only at the edges (`placeholders: { before, after
    }`). On screen again, it re-subscribes. `exhausted` is false while any
    placeholder exists.
  - **Dedup** across pages: live beats stale; otherwise the most recently
    APPLIED (`appliedSeq`) wins — never "the later page".
  - **`truncated: { reason: "long-sort-key" }`** when the full last page has no
    cuttable row; a full middle page without one collapses later pages.
  - **Failures** add `pageErrors` (`retry` re-reads that page); `blocksPaging`
    marks the failure paging stopped on.
  - **Keys.** A plan belongs to one collection key + query encoding. A
    `columns`-only change keeps the plan (column sets aren't wire params).
    `resetKey`: a query change under the same key keeps previous rows until the
    new head settles; any other change starts over. A `null` source/query
    reads nothing (hook order stays fixed).
  - **Logs** — channel `live-pages`: plan shape, collapses, and the follow-up
    signals `overflow-split gap Nms`, `cross-page gap: row X …`
    (`web/internal/cross-page-gaps.ts`), `seed refused: …`.
- Tests: `shared/page-plan.test.ts`, `web/__tests__/use-pages.test.tsx`,
  `server/internal/serve-collection-pages-oracle.test.ts`,
  `server/internal/serve-paged-value-oracle.test.ts`.

## Fields — `from` / `pick` / `related` / `fields` / `carry`

A collection names the entity its rows are and the fields a list shows;
everything else — row schema, filter domains, labels, options, title flag —
is DERIVED from field declarations. The only spelling (`row` / `filterable` /
`exposes` are deleted; tsc rejects, untyped callers throw).

```ts
export const conversationHistory = liveCollection("conversations.history", {
  from: conversationsEntityRef, // `pick` reads it; its exposures fold
  pick: ["title", "status", "model", "createdAt"], // listed, in list order
  // computed (bound in `columns`)
  fields: { taskTitle: textField({ label: "Task" }) },
  // on the row, never listed/filterable
  carry: { pick: ["id"], fields: { taskId: textField() } },
  related: { task: tasksEntityRef }, // lookup-join alias → entity
  id: "id",
  sortable: ["title", "createdAt"], // explicit (index-backed)
  default: { orderBy: [["createdAt", "desc"]], limit: 100 },
  maxLimit: 500,
});

// LiveField:
// { id, key, label, typeId, options, primary, domain, sortable }
conversationHistory.fields.status;
```

- **Derived.** Row schema = every row field, plus the `from` ref's
  `presentationReads` when it `pick`s a field (carried whether or not `carry`
  names them; a carry-only collection — a follow target — presents nothing and
  carries exactly what it names), plus
  `$columns` when rows reach an entity. Every LISTED field with a domain is
  filterable (string/enum → text, number, boolean, `Date` → instant, string
  array → stringArray; JSON none) — `core/internal/field-domain.ts`. Opt out with `filterable: false`;
  carried fields never filter. `collection.fields` is what data-view and MCPs
  read.
- **tsc.** Picked/own fields need a label (`RequireLabel`); picked keys must
  be fields of `from`; the id must be a row field. Untyped callers get the
  same checks as throws (duplicates, `pick` without `from`, own field named
  like an entity field).
- **`from` an extension shape** (`defineExtensionShape`): rows are the shape's
  wire row; no exposures; `collection.from` is `null`.
- **Exposures** fold from `from` (`exposes.base`) unless `baseExposures: false`
  (for a boot-preloaded set whose base exposure is write-hot); `related` adds
  the lookup aliases. Lookup-only collections reach none.
- **Overloads.** Three, window LAST: the resource vocabulary infers a
  collection factory from the last overload's return type — keep it last.
- **Presentation — `FieldPresentation.Register({ owner, fields })`**
  (web): browser-only facets of a field — `cell`, `token`, `extent: true`
  (`context.extent` = min/max over the view), `width`, `align`, `visible:
  false`, `groupable: true`, `useOptions` (a `Hook` returning a
  `ResourceResult` of options, or a plain array for an always-known set).
  Owner: an entity (the other fields its cells read are the ref's
  `presentationReads`, `entityRef(name, fields, { presentationReads })`,
  carried by every `liveCollection({ from: ref })`), an exposure, an arm, a
  row kind, client fields, or a field-declared collection. Two plugins
  setting the same property of one field throws.
- **Options label every value by canonical spelling** (`optionKey`): a string
  is itself, boolean/number its `String`, `"null"` is no-value (→ `isEmpty`
  filter, "None" section label).
- **Checks:** `live:exposures-registered` / `live:arms-registered` (every
  exposing shape / `liveArm` is bound by its plugin's `server/` and
  registered by its `web/`); `live:client-fields-resolved` (every
  `clientFields` resolved by its plugin's `web/`).

## Rows that are not database data — `rowKind` / `clientFields`

```tsx
// core — in-memory rows: a collection with no server
export const fileEntry = rowKind("file-explorer.entry", {
  fields: {
    name: textField({ label: "Name", primary: true }),
    size: nullable(intField({ label: "Size" })),
  },
  carry: { fields: { id: textField() } },
  id: "id",
});

// core — fields whose VALUES only the browser knows
export const gitFields = clientFields(fileEntry, "git", {
  section: "Git",
  fields: { git: enumTextField(GIT_BADGES, { label: "Git", options }) },
});

// web — resolved once by the declaring plugin
ClientFields.Resolve({ fields: gitFields, component: GitResolver });
// GitResolver: ({ rows, render }) => render(read)
//   read: ResourceResult<{ git: (row) => value | null }>
<DataView rows={entries} collection={fileEntry} … />;
```

- A **row kind** has a collection's `key` / `fields` / `rowKeys`; a DataView's
  in-memory origin takes it as `collection`. Needing server filtering later, it
  becomes a `liveCollection` of the same fields — no list changes.
- **Client fields** (on a row kind or a collection) can't be named by a server
  query (tsc); DataView filters/sorts/groups them in memory and throws if
  listed under a live `source`. Their values are a READ (loading → pending
  cells, error → `readError`).

## Other plugins' columns are exposures

There is no "contributed column" seam (`contributed` / `liveColumns` /
`serveColumns` / `LiveColumns.Serve` are deleted). A plugin with per-row data
of an entity stores it in an entity EXTENSION and EXPOSES its fields; every
collection reaching the entity sorts/filters/groups by them (`playback-history`
exposes `playCount` on `sonata_songs`). A missing side row reads the field's
declared default (`COALESCE`), else NULL. User-defined custom columns are
*Scoped column sets*.

## Exposed fields — `exposes` / `LiveColumns.Expose` / `exposedColumns`

- **Declare** on the extension: `defineExtensionShape({ exposes: { parent,
  name, fields, presence? } })` (each field's `label`, `as`, `options`;
  `presence` = side row exists). The collection declares only the entities it
  reaches (`from`, `related`); neither names the other.
- **Serve.** The extension's plugin contributes `LiveColumns.Expose(ext)`. A
  collection reaching an entity is DEFERRED and folds every reached exposure at
  `bindDeferredResources` (`server/internal/exposure-folds.ts`): `base` →
  `ext.join(slice)`, lookup `R` → `ext.join(slice, { on: R.on })`. Name
  collisions throw at bind. An exposure nobody reaches is fine.
- **Rows.** `$columns[<slice>][<field>]`, wire names `<slice>.<field>`. A
  field's list id is its `as` (else key).
- **Columns.** `exposedColumns(exposure)` (core): every field with a domain
  filterable, and sortable unless a string array. `.column(f)`, `.read(row)`.
- **Groups/counts** by an exposed column: `encode({ groupBy:
  "<slice>.<field>", columns })`; the server's decode is the authority.
- **Web.** `FieldPresentation.Register({ owner: shape.exposure })`; data-view
  derives every registered exposure a list's collection reaches.

## Scoped column sets — `columnScope` / `LiveColumns.Scoped` / `scopedLiveColumns`

`columnScope: "<DataView id>"` lets a collection sort/filter by columns whose
SET is data — one DataView's custom columns.

- **Server** (data-view's custom-columns owns it):
  `LiveColumns.Scoped(serveScopedColumns({ name, table, scope, hostKey,
  member, value, members, recomputeOn }))`; folded as a query-resource join
  FAMILY per scope (`query-resource/CLAUDE.md`, *Join families*).
- **Wire names** `<name>.<member>` (`custom.cc-1`); a member's cast is read at
  load time (retyping works; a lost member fails loudly).
- **One route per set**; a write to a member a tuple doesn't read reaches no
  tuple.
- **A member a tuple ORDERS BY** rides the row under `$scoped`
  (`LIVE_SCOPED_KEY`), stripped by reads. Displayed values still come from
  `customColumnValues` — only sort/filter joins a member.
- **`recomputeOn(scope)`**: adding/dropping/retyping a column FULLs every
  subscribed tuple once.
- **Browser**: `scopedLiveColumns(scope, name, members)`. A DataView listing a
  scoped collection must BE its scope (`storageKey`, asserted at mount).

## Union collections — `arms` / `liveArm`

`liveCollection(key, { fields, carry, id, arms: { discriminator: "kind" },
sortable, default, maxLimit })` lists rows of several KINDS, each from its own
table, in one window (the `runs` of every run kind) — a **Meta-DataView**
(data-view CLAUDE.md, *Meta-DataView*). Id is `kind:raw` (`armKeyCodec`).

- **Declaration.** Base fields are its own (`fields` / `carry.fields`; no
  `from` / `pick` / `related` / `exposes` / `columnScope`), presented once by
  `FieldPresentation.Register({ owner: union })`. The discriminator is a
  listed, labelled field (not the id) with NO options — its options are the
  arms' `label` / `order`. `serveCollection` takes only `arms: null` (a union
  is a tsc error there).
- **`liveArm(union, arm, { label, order, from?, pick?, fields?, carry?,
  sortable? })`** — in the arm's own plugin.
  - Field ids/wire names `<arm>.<field>`; rows carry them under
    `$columns[<arm>]`.
  - `order` is the band's place (never plugin load order).
  - `read(row)` is `null` for another arm's row and THROWS on its own arm's
    row with no slice (an unfolded arm is a bug, never "no values").
  - An arm field is never the row's title.
- **Entity arms** (`from: entityRef`) fold that entity's exposures into the
  arm (`$columns[<slice>]`, other arms read typed NULL). Refused at bind: two
  arms reaching one entity, a slice named like an arm, an exposed id equal to
  an arm field. Reference: `runs` (build/release/deploy arms `from` their
  ledgers' entity refs).
- **Serve — `const served = serveUnionCollection(c, { derive? })`**, and each
  arm's plugin registers **`served.arm(arm, { from, id, joins?, base(j),
  extra(j), where?(j) })`** (`server/internal/serve-arm.ts`) in `register:
  [...]`; the union names no arm. `base(j)` binds every base field but the id,
  discriminator and derived ones (a column ref of the field's type, an
  `ExprField`, or `null` for a nullable field — tsc); `extra(j)` binds the
  arm's own fields (picked ones by name unless `from` lacks a matching column).
  - **`derive: { reads, bind(reads, { id }) }`** — base fields computed for
    every arm so no two arms disagree (`runs`: `duration` from
    `startedAt`/`finishedAt`). Arms must bind `reads` to columns; binding a
    derived field is an error.
  - Compiled deferred at `bindDeferredResources` by query-resource's
    `compileUnionCollection` (its CLAUDE.md, *Union collections*).
    `compileUnion(c, { arms })` (`server/testing`) for tests.
  - **Arm pruning:** an AND-reachable clause over an arm constant that is
    false prunes the arm (no SQL, no routes); negative ops and `isEmpty` keep
    it (NULL satisfies them).
  - Groupings decode with the arms' and exposures' sets; other arms fall in
    the NULL group.
  - **Golden:** `server/internal/compile-union-golden.test.ts` pins SQL,
    routes and rows against `server/testing/compile-union-golden.json`.
    Regenerate before a refactor with
    `./equin run plugins/network/plugins/live/server/testing/gen-compile-union-golden.ts`.
    DB oracle: `server/internal/serve-union-oracle.test.ts`.
- **Owners.** Every column set carries an `owner` (`scoped` | `arm` |
  `exposed`, plus `own` on refs); the codec, data-view and the server switch on
  it exhaustively (an arm set only on its union, an exposed set only where its
  entity is reached, a scoped set only in its scope).

## Values — `liveValue` / `serveValue` / `useLive(value)`

ONE payload per params tuple, pushed whole on change (a count, a status, a
detail object). Anything row-shaped that grows is a collection (or a paged
value). Design: `research/2026-09-25-global-live-values.md`.

```ts
// core/
export const notificationsUnread = liveValue("notifications.unread", {
  schema: NotificationsUnreadSchema,
  preload: "boot", // "none" | "boot" | "boot-and-keep"
});
export const configValues = liveValue("config-v2.values", {
  schema: ConfigValuesSchema,
  params: ["path", "scopeId?"], // → { path: string; scopeId?: string }
  preload: "boot-and-keep",
});

// server/
export const unreadServed = serveValue(notificationsUnread, {
  source: "db",
  reads: {
    tables: [notifications],
    reason: "the badge counts every unread row",
  },
  loader: countUnread,
});
export const configValuesServed = serveValue(configValues, {
  source: "external",
  changes: "notified", // → .notify(params)
  loader: ({ path, scopeId }) => resolve(path, scopeId),
  preloadParams: () => [{ path: "a" }, { path: "a", scopeId: "app:x" }],
});

// web/
useLive(notificationsUnread); // ResourceResult<T>
// null: skipped, pending
useLive(pluginChanges, id === null ? null : { conversationId: id });
// many tuples → one result each
useLive(folderListing, expanded.map((dir) => ({ dir })));
```

### Declare

- `params` is a const tuple of names (`P` derived). **No `initial`**: not
  known yet is `loading`, never a stand-in.
- **Optional param** `"x?"`: present iff a non-empty string. `canonicalParams`
  (`packages/canonical-params`) drops `undefined`/`""` everywhere params enter
  (client and server), so `{ path }`, `{ path, scopeId: undefined }` and
  `{ path, scopeId: "" }` are ONE tuple.
- **Typed params** — `params: { window: z.enum(...) }`: every name required; a
  parser may only NARROW the wire string (output `string`; no transforms or
  codecs, defaults / prefaults, catch, rewriting checks — `.trim()`, case,
  `.overwrite()`, `z.url()` — or `undefined` — throws; a `.refine()` is
  accepted). Literal keys only.
- **The params gate** (`validateParams`) refuses unknown names, non-strings,
  missing required names → `contract-mismatch`.
- A param'd preloaded value has no default tuple: its `serveValue` must pass
  `preloadParams` (tsc + throw).
- **Shape** (see *Shape vs freshness*): every array/record/map/set the schema
  reaches must be capped or whole; checked by `declaredShape`
  (`core/internal/live-value.ts`) at module eval on every host.
  `core/internal/list-bounds-report.test.ts` sweeps every declaration.
- **`load`** (declared on the `liveValue` because BOTH halves act on it):
  `"push"` (default); `"on-demand"` — never shipped over the socket, tabs read
  over HTTP after each invalidate; `"snapshot"` — on-demand and never told of a
  change: re-measured on mount and by the read's `refresh()`; its serve must
  declare `changes: { snapshot }`. Snapshot never with `preload` / `paged`.
- **`patches: true`** — a growing pushed value (a message being written):
  after the first frame each change ships as a `patch`
  (`packages/value-patch`); readers unchanged. Push only — not with
  on-demand/snapshot, `preload`, `paged`, `bytes`, or `revalidate`.
- **`bytes: true`** — an `ArrayBuffer` payload, no `schema`, always on-demand
  over HTTP (`application/octet-stream`; envelope in headers). Not with
  push/snapshot, `preload`, `paged`, central, or `source: "db"`. Return
  `buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)` for a
  pooled Buffer (a `Uint8Array` is refused). `maxBytes` → `"too-large"`
  refusal.
- **Preload.** `"boot"`: hydrated before first paint, owning plugin eager, a
  DB-backed param-less one L2-persisted. A param'd one is ENUMERATED by
  `preloadParams` (every tuple loaded on every page load — enumerate exactly
  what first paint reads; never L2-persisted). Central values never preload.
  `"boot-and-keep"`: also never GC'd — for small values read by late mounts.

### Serve

`source` is required:

- **`"db"`** — declare **`reads: { tables, reason, outsideFeed? }`** (tsc +
  throw; optional beside `follows`, then only what the loader reads besides);
  a change to any declared table recomputes every subscribed tuple. No
  `notify`.
  - Whole tables only — the loader's SQL is hand-written, so a per-row filter
    could silently miss writes (row-level narrowing exists only for compiled
    collections).
  - `tables` = every relation read on ANY path (views reached through their
    bases). `outsideFeed: { tables, reason }` for tables
    `ExcludeFromChangeFeed`ed.
  - `reads: () => ({ … })` (a thunk) when tables come from a registry; the
    value then registers deferred and must be pushed.
  - **Drift guard** (resource-runtime A8): an undeclared read fails under a
    test runner; in production it's reported once and routed FULL.
- **`"external"`** — must declare **`changes`**:
  - `"notified"` — `served.notify(params?)`, `whileSubscribed` or
    `recomputeOn` drive it. The only arm with `notify`, `whileSubscribed`,
    `recomputeOn`, `throttleMs`, and `reads` (a loader that also reads
    Postgres declares them like the db arm; a paged value takes a static list).
    - `reads.notified: { relations, reason }` — relations whose changes
      arrive through the value's OWN notify wired to a domain event (e.g.
      `automations.catalog` on `tasks.statusChanged`), never the feed.
    - `reads.lookups` — a by-key read compiled from one declaration
      (query-resource's `compileLookup`), routed per tuple and per column read
      (`tasks-core`'s `runtimeOfConversationLookup`). A table is in `tables`
      or a lookup, never both. Rows a served collection holds are FOLLOWED
      instead: a lookup is for a read no collection serves, or one too hot for
      a follow's per-call query (`partial-message`).
  - `{ immutable: { reason } }` — a tuple's answer never changes (sha-keyed).
  - `{ fixed: { reason } }` — constant for the process lifetime.
  - `{ snapshot: { reason } }` — paired with `load: "snapshot"`.
  Silent arms have no `notify`.
- **`follows` — a value computed from a few rows reads them through
  collection TUPLES** (db, and external `"notified"`, paged included). A value
  never filters rows by hand: the collection's own plan is copied into its
  reach.

  ```ts
  serveValue(attemptWork, {
    source: "db",
    follows: (follow) => ({ // BEFORE the hooks: types `followed`
      attempt: follow(attemptWorkspacesServed, ({ attemptId }) => ({ ids: [attemptId] })),
      convIds: follow(attemptConversationIdsServed, ({ attemptId }) => ({ where: { attemptId } })),
    }),
    loader: (p, { followed }) => workOf(p, followed.attempt, followed.convIds),
    revalidate: (p, { followed }) => signatureOf(p, followed),
    whileSubscribed: ({ attemptId }) => () => evict(attemptId), // needs no row
    whileFollowing: {
      over: (followed) => followed.attempt[0]?.worktreePath ?? null, // sync, JSON
      start: (p, { over: path }) => watch(path), // external: { over, notify }
    },
  });
  ```

  - **Targets** are SERVED handles (`serveCollection`'s return,
    `FOLLOW_SOURCE`), one form each: a lookup-only, window or unscoped `all`
    collection by `{ ids }` (its `:rows`); a scoped `all` set by `{ where }`,
    exactly its `by` fields. A value, a descriptor, an off-feed / external
    collection, a union, the other form or a wrong scope is a tsc error (and a
    throw). The tuple function takes the SUBJECT (params, or the decoded
    question).
  - **`followed[name]`** — the tuple's rows (`readonly Row[]`), read FRESH in
    each hook's call through the collection's own read (resource-runtime's
    `loadResourceFresh`). Handed to the loader, `revalidate` (its own read: a
    revalidate-then-load reads twice), `whileFollowing.over`, a paged value's
    `loader(q, range, { followed })` and `meta(q, { followed })`. An empty id
    set reads nothing.
  - **The reach** (`server/internal/serve-value.ts`): query-resource's
    `followRead` copies the collection's plan (gates kept, `full`, tagged `via`
    the follow, matched on the tuple's ids / scope — a re-pointed row reaches
    its old and new tuple), folded with `reads` by `compiledValueReach`.
    - Refused: a table read through a follow AND whole / through a lookup (a
      view read whole over a followed table too, once bases are known).
    - A follow of a deferred collection defers the value to
      `bindDeferredResources` (refused for a paged value).
  - **Drift guard**: the value's OWN capture never covers a followed table — a
    hand-written query on one in the loader is drift (thrown under a test
    runner).
  - **`whileFollowing: { over, start }`** (`followLifecycle`,
    `core/internal/compile-value.ts`).
    - `over(followed)` reads, sync, what the start runs over (a JSON value);
      `start` gets `{ over[, notify] }`, never the rows (tsc).
    - On a follow route reaching a tracked tuple, the runtime's
      `onFollowReached` re-reads; only if `over` moved (as JSON) and the tuple
      is still in its span, the old start stops and a new one starts
      (`_debug.followRepoints`).
    - Re-points of one tuple run in order; a reach landing while one is queued
      joins it.
    - A FAILED start forgets what it was handed, so the next reach restarts it.
    - A (re)started watch must notify once open. Untracked reads start nothing.
    - A start that needs no row stays `whileSubscribed` (never re-started).
      Both may be declared (`bothLifecycles`; a throwing stop never leaks the
      other's). `whileFollowing` without `follows` is a tsc error and a throw.
  - Central: `follows` is a tsc error and a throw (no change feed).
  - Tests: `core/internal/compile-value-follows.test.ts`,
    `server/internal/serve-value-follows-oracle.test.ts`.
- **The bound is the declaration's**: `serveValue` takes no `unbounded`.
- Returns `ServedValue` (`keys`, `declare` — spread it); `"notified"` adds
  `notify`. `compileValue` derives without registering.
- **`throttleMs`** — leading-edge throttle: an isolated change flushes at
  once; only the throttle releases a held one.
- **`recomputeOn: [served, { value: served, params: (up) => P }]`** — a bare
  upstream recomputes every subscribed tuple; the mapped form is per-tuple but
  computes the upstream even with nobody subscribed — prefer one notify
  fan-out for values that move together.
- **`whileSubscribed(params, notify?) → stop | Promise<stop>`** — start/stop
  as one function, refcounted per tuple; db arm gets `params` only.
- **`revalidate`** — ETag signature (not on snapshot), e.g. `createSignedMemo`.
- **Refusals.** A loader that can't answer well-formed params (missing file,
  unknown id) throws `v.refuse(code, msg)` (`ResourceRefusal`) with a code the
  `liveValue` declares in `refusals: [...]` (any form).
  - The reader's error arm is `kind: "refused"` with typed `error.code` — no
    Retry, never reported.
  - An undeclared code becomes `loader-failed` (server) / `contract-mismatch`
    (client).
  - Anything else thrown is `loader-failed`, reported.
- **Central.** `liveValue(key, { …, origin: "central" })`, served by
  `network/live/central`'s `serveValue` (external arm only, registered via
  `resources: [served]`, no `declare`, never preloaded).
- **One serving path — `serveValueOn(rt, value, opts, { sources })`**
  (`core/internal/serve-on.ts`): every host's `serveValue` wraps it
  (`"db+external"` on Bun, `"external"` on central / a browser server).
  Exported from `core` with `serveCollectionOn` for hosts that are not plugin
  runtimes (tests' `inRealmServer`); browser hosts serve through plugins' own
  `serveValue`.

### Read

- `useLive(value, params?)` → `ResourceResult<T>`; a snapshot value's adds
  `refresh()`. No HTTP fetch on mount — the WS sub-ack fills it.
- **`useLive(value, null)`** (param'd only): pending, reads NOTHING. A subject
  that will NEVER arrive is a settled answer — render it or throw. Never a
  `""` stand-in (`live/no-sentinel-param` lint).
- **Many tuples — `useLive(value, [p1, p2, …])`** → one result per entry in
  order (via `useResources`, diffed: a kept tuple keeps its subscription and
  data identity). `null` entries skip. Not for param-less or paged values.

## Typed-query values — `liveValue(key, { query })`

A value whose question is STRUCTURED declares a zod `query` instead of
`params`:

```ts
export const metricQuery = liveValue("metrics.query", {
  schema: MetricResultSchema,
  query: MetricQuerySchema,
  load: "on-demand",
});
export const metricQueryServed = serveValue(metricQuery, {
  source: "external",
  changes: "notified",
  loader: (q) => runQuery(q), // decoded question
  whileSubscribed: (q, notify) => watch(q.metric, notify),
});
useLive(metricQuery, query); // schema INPUT; null reads nothing
```

- **Wire** `{ q }` = `canonicalJson` of the PARSED value (so `{}` and `{ x:
  default }` are one tuple). The gate is strict: parse, then re-encode
  byte-identically, else `contract-mismatch` — this also rejects
  non-idempotent transforms.
- **Size** ≤ `LIVE_QUERY_MAX_BYTES` (2 KiB); bigger is a request body, not a
  tuple.
- Excludes `params` and `preload`; central allowed. A changed question is a new
  tuple (reads loading); the query schema may not itself be a list.

## Desktop-only reads — `needsMachine`

A read only the desktop app's server can answer (a checkout, a process):
an option on the declaration, never a new hook.

```ts
export const checkoutStatus = liveValue("x.checkout-status", {
  schema: StatusSchema,
  // also on liveCollection
  needsMachine: { feature: "Reading the checkout" },
});

// machine/ — never server/
import { serveValue } from "@plugins/network/plugins/live/machine";

// web/ — ResourceResult<T> | { status: "unavailable"; message }
const r = useLive(checkoutStatus);
```

- On every `liveValue` form and window / lookup / `all` collections (not
  unions). A paged value's meta sibling inherits it.
- `live/server`'s `serveValue` / `serveCollection` take only portable
  declarations; `live/machine`'s only machine ones (tsc).
- `useLive` / `useLiveRow` return `WithMachine<NM, R>`; under a transport
  with `machine: false` (the demo's browser server) the read is `unavailable`
  from the first render and nothing is read. Gate a control before reading with
  endpoints' `useMachineAvailability(declaration)`. Paged readers pass `NM`
  through (data-view's `useLivePagedValuePaging`).

## Event reads — `useLiveReader`

```tsx
const read = useLiveReader();

<button
  onClick={async () => {
    // or read(v) / read(queryValue, query)
    const a = await read(hostFsPathStat, { path });
    if (a.status === "refused") return showError(a.message);
    if (a.status === "unavailable") return; // only with `needsMachine`
    act(a.data);
  }}
/>;
```

- `LiveAnswer<T, C, NM>`: `ready` | `refused` | `unavailable`. Other failures
  REJECT with the `ResourceError`.
- One tuple only (paged, collection, `null`, list → tsc error). An observed
  tuple answers from its pushed value; otherwise one deduped HTTP read, never
  cached. Snapshot values are always read.

## Old spellings — lint `no-legacy-resource-spelling`

Flags any import/read of the old spellings (`resourceDescriptor`,
`keyedResourceDescriptor`, `queryResourceDescriptor`,
`windowQueryResourceDescriptor`, `pointQueryResourceDescriptor`,
`defineResource`, `defineExternalResource`, `queryResource`,
`windowQueryResource`, `useResource`, `usePointResource(s)`,
`useWindowResource`) — deleted ones stay listed so a stale import is told its
replacement. Exemptions are the substrate only (`./equin exempt list --rule
live/no-legacy-resource-spelling`). **Never add an entry for new code.**

**Request/response reads — lint `live/no-endpoint-read`.** There is no
request/response server read in the browser (a GET `fetchEndpoint` /
`useEndpointMutation` / `readNdjson` does not compile). In `web/` it flags:

- TanStack read hooks (`useQuery`, `useInfiniteQuery`, `useSuspenseQuery`,
  `useQueries` …) and `fetchEndpoint` inside a `queryFn`.
- A write's answer used as a read — `fetchEndpoint` / `mutateAsync` in render,
  a hook body, an effect, module top level (or a function they call) whose
  answer is USED. Fire-and-forget writes (`void`-ed) pass.
- A `LiveReader` call in read context.

`on*` handlers, `mutationFn`s and event-registrar callbacks are actions;
functions escaping the file are unflagged (`lint/no-endpoint-read.ts` header
states the walks). **Residual, held by review:** a POST read from an event
handler — declare it live and use `useLiveReader`. The rule is `noDebt`
(`lint/index.ts`): only the substrate's sanctioned entries (`network/live`,
`primitives/live-state` `web/`). **Never add an entry, debt or sanctioned.**

## Internals

- **Filtering is the filter sub-plugin** (`plugins/filter`, its CLAUDE.md):
  domains, the op table (in-memory + SQL), the `Filter` tree, strict codec,
  `matchesFilter`, `filterSql`. Negative ops (`ne notIn neCi notContains
  hasNone isNotEmpty`) KEEP NULL rows. Operands are checked against the domain
  (a stale enum operand matches nothing). No clock ops.
- `LiveWhere` is object sugar (AND of `col: value` = `eq`, or `{ op: operand
  }`, `{ isEmpty: true }`) or a `Filter` tree (`and` / `or` of `{ column, op,
  operand }`); both canonicalize to the same bytes
  (`core/internal/query-codec.ts`). `useLive`'s query is `NoInfer`.
- String order is code-point in memory and the cluster's `C` collation in SQL
  (pinned by the parity suite; group tiebreaks rely on it).

## Wire params

- Window: `{ limit; where?; order?; after?; until? }` — `where` the filter's
  `encodeFilter`, `order` canonical JSON, cuts verbatim `$key`s; each present
  only when non-default (default window stays `{ limit: "100" }`).
- Groups: `{ groupBy; limit; where? }`.
- `all`: `{}` (any param is `contract-mismatch`); scoped: exactly the `by`
  fields.
- Typed-query value (and a paged value's meta): `{ q }`. Paged value: `{ q;
  limit; after?; until? }`.
- Decode is STRICT everywhere (re-encode must match), so one logical query
  never names two subscriptions.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Unified live-resource API, read half: useLive (a collection's window — where/orderBy/limit with canGrow/growing/loadMore — a grouping of a filterable column's values with counts, grown by its limit, a collection declared `all` whole — every row in its declared order, or a select-scoped slice of it — or an explicit id set), useLiveRow (one row: loading, failed, found, or determinately absent), useLiveReader (the one read function beside useLive: one answer to one tuple of a liveValue, for a question an event asks and its own await consumes — its pushed value when observed, else one deduped HTTP read never written to the cache; refused / unavailable typed by the declaration), with mapRow reducing a row read to a ResourceResult of what the row means; useLive also reads a typed-query liveValue (its question encoded to one canonical tuple); every collection's window — and a key-range-paged liveValue — is read as key-range pages — bounded windows tiling the order by server-minted row-key cuts, split when full and merged when small — given a measured viewport (useLive(c, q, { viewport })) with no depth limit, the pages near it live and the rest held stale up to a per-reader budget, past which they are height-keeping placeholders drawn before and after the rows, and without one every page live, capped at maxLimit rows; FieldPresentation.Register presents an owner's fields — an entity's own, an extension's exposed ones, a union arm's, a collection's own — with their cells, widths and live options in every list that reaches the owner, read by useFieldPresentations. Unified live-resource API, server half: serveValue (a liveValue's loader, from Postgres — change-feed driven — or from an external source with notify(); the serve call decides only the freshness, never the shape: every list's bound is the liveValue's own (its schema's list-bound markers), so a serve call takes no `unbounded`; pushed by default, or refetched over HTTP when the liveValue declares `load: "on-demand"`; a typed-query value's hooks and notify take the decoded question, and a key-range-paged one — external only — is loaded one key range at a time, each answer checked against its range and minted its `$key`, notify(q) reaching every subscribed page and the per-question meta sibling, and sliceRange answers a range for a list held in memory) and serveCollection (binds a liveCollection's row fields to a table's columns — the projection is exactly the row schema — ANDs an optional base `where` into every read, and compiles its window + `:rows` point resources through windowQueryResource and its `:groups` GROUP BY push value — only `:rows` for a lookup-only collection, and the whole ordered set (`key`, a routed scopedMembership alias compiled by compileAllCollection) + `:rows` for one declared `all` — encoding a column type's declared wire form in JS per row; a collection reaching an entity compiles at boot, folding every LiveColumns.Expose contribution of an extension exposing fields of it — and a `columnScope` collection every LiveColumns.Scoped set — into its rows' `$columns`; routed through the change feed, or — with `changes` — the same compiled SQL served off it, for a table its owner opted out) — or, `source: "external"`, from a source outside Postgres that answers window / rows / groups / count / all by hand (core's serveCollectionOn: every answer checked against the row schema, every window row's `$key` minted, notify() re-reading the subscribed tuples); every filter compiles through the filter language's filterSql. Unified live-resource API, central half: serveValue for a liveValue declared `origin: "central"` — the external arm only (central has no change feed), registered through the central plugin's `resources: [served]`; its options compile through the same code as the worktree serveValue.
- Web:
  - Slots:
    - `FieldPresentation.Register`
    - `ClientFields.Resolve`
  - Slot contributors: 41 contributors — full list in [REFERENCE.md](./REFERENCE.md)
    - `FieldPresentation.Register` ×38
    - `ClientFields.Resolve` ×3
  - Uses: 23 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/live-state` ×12
    - `primitives/networking` ×4
    - `infra/endpoints` ×3
    - `primitives/latest-ref.useLatestRef`
    - `primitives/log-channels.clientLog`
    - `primitives/slot-render.renderIsolated`
    - `primitives/sync-status.useReportSync`
  - Exports (types):
    - `ClientFieldReaders`
    - `ClientFieldsResolution`
    - `ClientFieldsResolverProps`
    - `ClientFieldValues`
    - `FieldPresentationRegistration`
    - `FieldPresentationSpec`
    - `FieldsCollection`
    - `LiveAllSelect`
    - `LiveAnswer`
    - `LiveFieldOption`
    - `LiveFieldOptionsRead`
    - `LiveIdsQuery`
    - `LiveListResult`
    - `LiveMutation`
    - `LiveMutationCallbacks`
    - `LiveMutationOptions`
    - `LiveMutationRequest`
    - `LivePageError`
    - `LivePagePlaceholder`
    - `LivePagesQuery`
    - `LivePagesResult`
    - `LiveReader`
    - `LiveRowResult`
    - `LiveSnapshotResult`
    - `LiveUnavailable`
    - `LiveValuePagesOptions`
    - `PagesTruncation`
    - `PresentationOwner`
    - `SendLaneKey`
    - `StoredClientFieldsResolution`
    - `StoredFieldPresentation`
    - `UnconfirmedDeadline`
    - `UnconfirmedDeadlineOptions`
    - `UnconfirmedSample`
    - `VisibleRange`
    - `WithMachine`
  - Exports (values):
    - `armUnconfirmedDeadline`
    - `classifyRejection`
    - `ClientFields`
    - `clientFieldsKey`
    - `collectionPresentationKey`
    - `enqueueOnSendLane`
    - `entitySendLaneKey`
    - `FieldPresentation`
    - `hiddenSince`
    - `mapRow`
    - `mintVisibleRange`
    - `optimisticDivergenceReportSink`
    - `optimisticRejectionSink`
    - `presentationOwnerKey`
    - `REJECTION_MESSAGE_MAX`
    - `renderClientFieldsResolver`
    - `resourceSendLaneKey`
    - `useClientFieldsResolvers`
    - `useFieldPresentations`
    - `useLive`
    - `useLiveMutation`
    - `useLiveReader`
    - `useLiveRow`
- Server:
  - Uses: 38 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `infra/query-resource` ×35
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
    - `FollowBuilder`
    - `LiveValueSource`
    - `LookupCollectionSpecs`
    - `ScopedMemberRead`
    - `ServeAllCollectionOptions`
    - `ServeCollectionOptions`
    - `ServedAllCollection`
    - `ServedAllResources`
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
    - `ServedWindowCollection`
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
  - Uses: 39 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `network/live/filter` ×8
    - `fields` ×6
    - `packages/zod-introspect` ×6
    - `primitives/live-state` ×6
    - `infra/endpoints` ×5
    - `packages/list-bound` ×3
    - `packages/canonical-params` ×2
    - `packages/resource-protocol` ×2
    - `infra/query-resource.KIND_RE`
  - Exports (types):
    - `AnyCollection`
    - `AnyExternalCollectionOptions`
    - `AnyServedExternal`
    - `AnyServeOptions`
    - `BytesPairing`
    - `ChangeHooks`
    - `ClientFields`
    - `ClientFieldsOwner`
    - `ClientFieldsOwnerRow`
    - `ClientFieldValue`
    - `CollectionRow`
    - `CompiledPagedValue`
    - `CompiledValue`
    - `ContributedColumns`
    - `DomainOfValue`
    - `ExternalAllCollection`
    - `ExternalCollectionChangeOptions`
    - `ExternalLookupCollection`
    - `ExternalNotifiedPagedValue`
    - `ExternalNotifiedQueryValue`
    - `ExternalNotifiedValue`
    - `ExternalServed`
    - `ExternalSilentPagedValue`
    - `ExternalSilentValue`
    - `ExternalSourceRow`
    - `ExternalWindowCollection`
    - `FieldCellContext`
    - `FieldExtent`
    - `FieldsFilterable`
    - `FieldsRow`
    - `FollowBuilder`
    - `FollowIds`
    - `FollowIdsSource`
    - `FollowIdsTarget`
    - `FollowMap`
    - `FollowsFn`
    - `FollowWhere`
    - `FollowWhereSource`
    - `FollowWhereTarget`
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
    - `LiveEffect`
    - `LiveEffectPart`
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
    - `LiveLane`
    - `LiveLookupCollection`
    - `LiveMachineDecl`
    - `LiveMembership`
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
    - `LiveValueChanges`
    - `LiveValueOrigin`
    - `LiveValueParamParsers`
    - `LiveValueParams`
    - `LiveValueSource`
    - `LiveValueSpec`
    - `LiveWhere`
    - `LiveWhereObject`
    - `LiveWindowBounds`
    - `LiveWindowCodec`
    - `LiveWindowDescriptor`
    - `LiveWindowParams`
    - `NoFollows`
    - `NotCollectionRow`
    - `OrderableKeys`
    - `OrderableValue`
    - `PagedChanges`
    - `PredictOptions`
    - `PredictPatchTarget`
    - `PredictTarget`
    - `RequireLabel`
    - `ResolvedLiveEffect`
    - `ResolvedLiveTarget`
    - `RowKind`
    - `RowPatch`
    - `ScopedColumnMember`
    - `ServedExternalAll`
    - `ServedExternalLookup`
    - `ServedExternalResource`
    - `ServedExternalWindow`
    - `ServedFor`
    - `ServedPagedOn`
    - `ServedValueBase`
    - `ServedValueOn`
    - `ServeExternalAllOptions`
    - `ServeExternalLookupOptions`
    - `ServeExternalWindowOptions`
    - `ServePagedValueOptions`
    - `ServeValueOnOptions`
    - `ServeValueOptions`
    - `SnapshotPairing`
    - `TargetRow`
    - `UpsertOptions`
    - `WithContributedColumns`
  - Exports (values):
    - `applyRows`
    - `choose`
    - `clientFields`
    - `compileExternalCollection`
    - `compilePagedValue`
    - `compileQueryValue`
    - `compileValue`
    - `effects`
    - `exposedColumns`
    - `extentOf`
    - `externalCollectionRegistrar`
    - `FOLLOW_SOURCE`
    - `followReaches`
    - `followsDeferred`
    - `followsOf`
    - `followSubjectOf`
    - `isPointId`
    - `LIVE_COLUMNS_KEY`
    - `LIVE_QUERY_MAX_BYTES`
    - `LIVE_ROW_KEY`
    - `LIVE_ROW_KEY_MAX_BYTES`
    - `LIVE_SCOPED_KEY`
    - `liveArm`
    - `liveCollection`
    - `liveValue`
    - `orderScalar`
    - `patchRow`
    - `patchValue`
    - `patchWhere`
    - `readLiveEffect`
    - `readSubject`
    - `removeRow`
    - `removeWhere`
    - `rowKind`
    - `scopedLiveColumns`
    - `serveCollectionOn`
    - `serveValueOn`
    - `sliceRange`
    - `upsertRow`
    - `upsertRows`
    - `valueSubject`
- Cross-plugin:
  - Imported by: 315 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×83
    - `conversations` ×55
    - `debug` ×32
    - `tasks` ×30
    - `infra` ×21
    - `page` ×14
    - `active-data` ×12
    - `primitives` ×11
    - `build` ×10
    - `stats` ×5
    - `code-explorer` ×4
    - `plugin-meta` ×4
    - `ui` ×4
    - `auth` ×3
    - `reports` ×3
    - `review` ×3
    - `apps-core` ×2
    - `config_v2` ×2
    - `hints` ×2
    - `history` ×2
    - `integrations` ×2
    - `release` ×2
    - `search` ×2
    - `backup/runs-arm`
    - `database/query-deadline`
    - `fields/secret/config`
    - `runs`
    - `screenshot`
    - `shell/notifications`
    - `tag-tree/engine`
- Exemptions:
  - Exempts itself from:
    - `live/no-legacy-resource-spelling` — `.` (sanctioned)
    - `live/no-endpoint-read` — `web` (sanctioned)
    - `no-db-backed-notify` — `server/internal/serve-off-feed.ts` (sanctioned)
    - `no-raw-websocket` — `e2e/narrowing.ts` (sanctioned)
    - `endpoints/no-endpoint-effect-internals` — `core/internal/predict.ts`, `web` (sanctioned)
  - Exempted by:
    - `framework/central-core` (0 debt)
    - `framework/resource-runtime` (0 debt)
    - `framework/server-core` (0 debt)
    - `infra/query-resource` (0 debt)
    - `network/live` (0 debt)
    - `primitives/data-view` (0 debt)
    - `primitives/live-state` (0 debt)
    - `primitives/optimistic-mutation` (0 debt)
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
    - `activeSendLaneCount` — Occupied lanes.
    - `pageZeroParams` — The tuple a paged read of `collection` subscribes for its first page, asked nothing (`{}`): the page plan's start page, encoded by the collection's page source.
    - `UNCONFIRMED_MS` — How long a predicted write may stay unconfirmed before it is reported.
    - Types: `OptimisticDivergenceReport`, `OptimisticRejectionReport`
  - Server: `@plugins/network/plugins/live/server/testing`
    - `checkPagedSource` — Ask `loader` every range over the items' and `cuts`' keys and throw — naming the range, the answer and the expected ids — on the first answer that differs from `sliceRange` or fails the served half's checks.
    - `compileCollection` — Derive the specs for a collection — three, or just `rows` for a lookup-only one.
    - `compileUnion` — Derive a union collection's three server halves.
    - `subscribeAsOldDescriptor` — Subscribe `old.key` on the server runtime as an old bundle's tab would — its own socket, `params` (default `{}`: a legacy param-less descriptor sent nothing), its `build` graph when given — and answer what that tab gets: the first `sub-ack` or `sub-error` for the tuple, the ack's value parsed with the OLD schema.
    - Types: `OldDescriptor`, `OldSubscription`, `PagedSourceCheck`
- Sub-plugins:
  - **`filter`** — The filter language's SQL half: renderOpSql renders one op's dialect-free template over a rendered target (operands as params cast to the domain's SQL type, lists as ONE array param), and filterSql…

<!-- AUTOGENERATED:END -->
