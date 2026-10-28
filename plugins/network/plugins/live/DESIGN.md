# live — design

Why the rules in [CLAUDE.md](CLAUDE.md) are what they are. Read before changing or removing one.

## Design rule — grow `useLive`, don't add APIs

- **Why `useLiveReader` exists beside `useLive`.** `useLive` cannot express
  an answer bound to the event that asked for it (validate then act, read
  then confirm then destroy) without rebuilding that `await` as pending state
  plus an effect that acts once the answer lands. So it adds no declaration
  surface: same declarations, tuple, refusals, machine arm and transport.
  Reference:
  [browser reads only through live](../../../../research/2026-10-26-global-browser-reads-only-through-live.md)
  §2.
- **Why one hook per list read.** The query's shape picks the resource; a
  separate hook exists only where the result has different STATES
  (`useLiveRow`'s found / not found, the viewport read's placeholders).

## Shape vs freshness

- **Why they are separate.** Coupling them made the source decide how much
  the browser holds: a table outside the change feed could not page, and an
  in-memory array was treated as bounded when it is no more bounded than a
  table. Reference:
  [bounds independent of freshness](../../../../research/2026-10-22-global-live-bounds-independent-of-freshness.md).
- **Why `wholeList` needs a reason.** It is the author's statement that
  loading the list entire is honest; the reason is what a reviewer checks.

## Usage

### Collection forms

- **Lookup-only over a param'd value.** `:rows` point routing reaches only
  the tuples whose id set holds the changed row. Rejected: a `oneRow`
  routing mode on values
  ([values migration contract](../../../../research/2026-09-26-global-live-values-migration-contract.md)
  §10).
- **`all: { max }` is a statement about the data, never a truncation.** The
  schema is `.max(max)` so every parse (server load, client hydration,
  updates) refuses one more row, and the SQL reads `LIMIT max + 1` so an
  over-cap load is a loud error naming the key. A silent cap would hand
  readers a set they believe is whole.
- **Scoped `all: { by }`.**
  - `by` fields must bind text / uuid / integer columns and the gate admits
    only their canonical text, so the router's key match IS the SQL's
    `col = $param`. That is what makes a write to another scope reach no
    tuple before any load.
  - No `preload`: a scope is named by a reader, so boot has no tuple, and
    the set is never L2-persisted.
  - Postgres only: the scope compiles to SQL and route matches, which an
    external source has neither of.
- **C39 — why the params gate is not enough.** An older bundle that
  subscribed a param-less key with `{}` passes the gate of a new `all` set
  under the same name, gets the new rows and parses them with ITS schema. The
  failure is a parse error in that tab, not a `skew` verdict — unless the
  two wire rows are identical. Hence: prove `parsed` with
  `subscribeAsOldDescriptor`, or rename the key (`unknown-key` → `skew`).
- **Preload.**
  - `:groups` is never preloaded: the server cannot know a tab's grouping
    queries at boot.
  - `preloadRows` derives its one tuple server-side from the other
    collection's boot value and encodes it with the point codec, so the
    reader's tuple is canonically the preloaded one (no near-miss tuple that
    loads again).
- **`maxIds` exists because id sets were the one unbounded tuple shape.** A
  reader whose id set is legitimately larger declares it (the queue ranks of
  every live conversation need 2000), rather than the cap being lifted.

### Serve — `serveCollection(c, { from, joins?, where?, defaults?, columns?, … })`

- **`from` is an entity, never a raw table or a view.**
  - A raw `pgTable` would let the table behind a list have no entity, and
    the collection restate its fields.
  - Never a view: routing needs the base table, and every read table must be
    triggered by the change feed.
- **`j` offers only wire columns.** So another relation, another table's
  column or a server-only column cannot be spelled in an override.
- **Projection = row schema keys.** A server-only column (a dedup key, a
  secret) can never reach the wire.
- **`defaults` vs `where`.** A default is a scope the user overrides by
  asking about the column, not membership: the events list hides a disabled
  source's events and soft-deleted ones, and a filter on `sourceId` /
  `disappearedAt` shows them.
- **`:groups` names its value by ordinal** (`GROUP BY 1`), so an expression
  with bound parameters (an exposed field's `COALESCE(col, $absent)`) renders
  once. Each group value is checked against the row field, so a stored value
  the row type cannot hold fails loudly.
- **Wire-encoded columns are encoded in JS.** SQL's `encode(…, 'base64')`
  folds lines at 76 chars. They cannot be filterable or the id because
  operands, group values and ids are compared as stored.
- **The `all` arm.**
  - It is checked before the lookup-only branch, which would otherwise serve
    an `all` set as `:rows` alone.
  - A wire-encoded value is refused: an `all` set is L2-persisted, and its
    persisted definition cannot read an encoder's code.
  - A `jsonAgg` may hold the field's JSON form because the driver hands it
    back already parsed — byte for byte what the wire makes of the decoded
    value.
- **The external arm.**
  - Never routed: only the source knows its data.
  - `notify({ ids })` narrows `:rows` only: a changed row may enter or leave
    any window, `all`, group or count tuple, and only the source could say
    which.
  - `whileSubscribed` is refcounted over every tuple of every minted
    resource, so a reader splitting its pages never restarts the watcher.
  - The source answers rows WITHOUT `$columns` (tsc), so no source ever
    spells another plugin's slice. Limit: an external host folds no
    exposures, so exposed fields read their defaults there.
  - An `all` set's `key` is an external window as wide as the set: its
    contract is keyed, so it cannot be a plain value.
  - A union is refused: its rows fold several tables.
- **The SQL arm off the feed.** Every table it reads is declared unfed, so
  the drift guard accepts the loader's reads; change-feed refuses at boot a
  table the feed still covers, and the converse (an opted-out table served
  routed) is refused too. Either mismatch would mean writes nobody announces.

### Read — `useLive(c, query?)` / `useLiveRow`

- **`loadMore()` splits, never reloads a larger window**, and stays `ready`
  with `growing: true`, so a list that already rendered never flashes a
  spinner.
- **The cap stops one step short** because a new page must fit under
  `maxLimit` rows whole.
- **A boot-hydrated page 0 cannot seed** its first split: its value is the
  boot snapshot's (`appliedSeq` 0), not one the server vouched for on this
  socket. Cost: latency only.
- **A grouping grows by reloading** one tuple at a larger limit; the previous
  tuple stays subscribed only until the grown one has a value, so the chips
  never blank.
- **An `all` read hands React Query no selector**, so `data` IS the cached
  array: every observer shares it and its row objects, and a per-snapshot
  memo (a `WeakMap` keyed on the array) hits across observers.
- **`useLiveRow` with an un-carriable id** (`""`, one holding `,`) is a
  determinate miss, not the render error `encode` would throw: no row is
  addressable by it, and such ids come from outside (a URL, a `[[page:…]]`
  token, an agent's tool input). `useLive(c, { ids })` still throws: an
  explicit set is the caller's to build.

## Paged reads — key-range pages through `useLive`

- **D1 — why a cut is a position, not a cursor.** A cursor belongs to the
  previous page's ANSWER. Chaining them forces every page live, a depth cap,
  and up to N−1 serial re-mints per change at the head. A position stays
  valid after its row is deleted, so pages release and re-subscribe alone
  (which is what lets liveness follow the viewport), and an insert near the
  head is absorbed by an overflow split.
  - Limit: a forward-token-only source (`pageToken` / `nextCursor`) has no
    positions and cannot be paged.
- **D2 — why the plain read is capped at `maxLimit`.** A reader that cannot
  say which rows are on screen must keep everything it loaded live —
  O(loaded). The cap is the boundedness rule, not a second mechanism. Only
  the viewport mode has placeholders and per-page notices — different STATES,
  hence its own result shape.
- **D3 — one runtime path.** Every page is a keyed window membership entry, so
  deltas, snapshots, seeded split/merge and the client cache are shared. "An
  external resource is never routed" does not mean never keyed. A value page
  sends `derive` like a collection's, so it is under the frame-vocabulary
  protocol: a derivation asked under another protocol loads in full
  (`protocol-skew`).
- References:
  [key-range pages v2](../../../../research/2026-10-09-global-live-key-range-pages-v2.md),
  [paging follow-ups](../../../../research/2026-10-12-global-live-paging-followups.md).

### Collections — every window

- **`maxLimit ≥ 2 · default.limit`.** A page that splits is read at
  `2 · default.limit`: a step of headroom over the rows it holds.
- **`$key` is exact Postgres `::text`.** A µs `timestamptz`, a long `numeric`
  or a `float8` crosses exactly; a decoded JS value would not. Hence cuts are
  never derived on the client: a decoded row lost the exact text.
  - Limit: a key over 1 KiB is `null`, so no page can cut there (`truncated:
    long-sort-key`).
- **Cuts render on the ORDER side, never through `where`.** So a
  sortable-but-not-filterable column takes cuts, and a tuple's routes and
  roles are those of the tuple without them.

### Values — `liveValue(key, { query, paged })`

- **No `load` option.** A page is a keyed window whose changes ship as
  deltas; there is no `invalidate` of one to refetch over HTTP.
- **Meta is a per-question sibling, never a page's**, because page 0 may be
  split or released. Pending until known, never a stand-in 0.
- **`whileSubscribed` runs once per question**, refcounted over every page
  and the meta, so a read that splits or releases pages never restarts a
  source watch.
- **Every loader answer is checked** (arity, part types, strictly ascending,
  inside the range, ≤ limit): a bad source is a loud loader error, never a
  reader that pages wrong.

### The read — `useLive(source, query, { viewport? })`

- **`viewport` is branded and minted only by data-view.** A reader with
  nothing measuring a viewport (a set reader, a count) cannot page by one.
  "Every page live" is the absence of the option, not a variant, so it
  cannot be smuggled through one.
- **One kind of read per call site** because each kind is a different set of
  hooks; switching would break hook order.
- **Split / merge.**
  - A full page that is not last may be hiding rows (inserts filled its
    headroom), so it splits at its median.
  - Every structural step applies at once, each new page showing its slice
    of the replaced rows, so the result never flips back from `ready`.
- **Seeds.** A seeded page is subscribed before the pages it replaces are
  released, so the server still holds the sources when the sub arrives. The
  unknown part (`loadMore`'s `(k, ∞)`, an overflow's rest) is always read:
  its page was full and may hide rows.
- **Liveness.**
  - The 2-away hysteresis band keeps a back-and-forth scroll from churning
    subscriptions.
  - A released page drops its cache (`release: "now"`): a stale cache never
    passes for a settled read.
  - A just-minted page stays live until it answers; a read with no row stays
    live (an empty list has no row to be seen by).
- **Placeholders only at the edges** — no view has an entry kind for a gap
  between two rows. A placeholder carries a key and a count, never a row
  value. This keeps what a read holds O(viewport + budget) at any depth.
- **Dedup by `appliedSeq`, never "the later page"**: a sort-key move can take
  a row backwards.
- **Collapse.** A full non-last page with no cuttable row drops the pages
  after it, so no row is ever hidden between pages.
- **`blocksPaging`.** A read with placeholders is held short by the
  viewport, not by a failure, so its other failures stay notices.
- **Keys.** A plan belongs to one collection key, so switching collection
  starts over even when the two queries encode alike.
- **A `columns`-only change keeps the plan**: column sets are not wire params
  and every row carries the whole projection, so no held row can lack a
  column the new query names.
  - Limit: a projection that varied per query would have to re-read the live
    pages and turn released ones into placeholders.
- **The log signals decide follow-ups.**
  - `overflow-split gap` — a hidden-rows marker is built only if this is
    common or over ~150 ms.
  - `cross-page gap` — a client-side departure hold is built only if it
    fires.

## Fields — `from` / `pick` / `related` / `fields` / `carry`

- **Window overload last.** The resource vocabulary infers a collection
  factory from the last overload's return type; a single top-level
  conditional return type would hide it.
- **`baseExposures: false`** exists for a boot-preloaded set whose base
  exposure is write-hot (the Queue's active conversations leave usage off):
  folding it would recompute the set on every write.
- **Arm `order` is stated by each arm** so the band order is the surface's
  choice, never plugin load order.

## Other plugins' columns are exposures

- **Why no contributed-column seam.** A collection naming another plugin's
  columns, or a plugin declaring columns on a collection, couples the two.
  An exposure is declared on the entity, so every collection reaching it
  gets it with neither naming the other.
- **Defaults via `COALESCE`** make a missing side row consistent in filter,
  sort and projection alike (a never-played song has `playCount = 0` in SQL,
  not NULL in one place and 0 in another).

## Exposed fields — `exposes` / `LiveColumns.Expose` / `exposedColumns`

- An `all` set folds exposures through its wire `ids` (`exposed:<sorted wire
  names>`), so its L2-persisted definition changes when the fold does.

## Scoped column sets — `columnScope` / `LiveColumns.Scoped` / `scopedLiveColumns`

- **Members' casts are read at load time**, so a retyped column reads its new
  type on the next load and a lost member fails loudly instead of reading a
  stale shape.
- **Only sort / filter joins a member**; displayed values come from
  `customColumnValues`. An unused custom column costs nothing.

## Union collections — `arms` / `liveArm`

- **`read(row)` throws on its own arm's row with no slice**: a server
  that did not fold the arm is a bug, never "no values".
- **Two arms may not reach one entity**: one slice would bind both, so a
  filter on arm A's exposed field would filter arm B too.
- **The union's codec lets exposed sets through** because arms are declared
  after the union, in other plugins; the server's decode, over the sets it
  folds, is the authority.
- **`derive`** computes shared base fields once for every arm, so no two arms
  can disagree on them (`duration`).
- **Arms compile at `bindDeferredResources`**, before anything serves and
  before the change feed rebuilds triggers from routes.
- **Arm pruning keeps negative ops and `isEmpty`**: NULL satisfies them, and
  another arm's field is a typed NULL there.

## Values — `liveValue` / `serveValue` / `useLive(value)`

### Declare

- **No `initial`.** A stand-in is a claim about the user's data that later
  reverses; not known yet is `loading`.
- **`canonicalParams` on both ends**, at every entry point (subscription,
  HTTP URL, prime, query key, hydration, notify, `recomputeOn`,
  `preloadParams`), so a notify can never miss the tuple a read holds.
- **Typed params may only narrow** so the loader receives the wire tuple
  itself, unchanged. Literal keys only: a `Record<string, …>` would make
  `useLive` read the value as param-less.
- **Bare lists throw at declaration, not tsc.** Rejected: a tsc brand — it
  would spread into domain types and risk tsc depth limits. The throw runs at
  module eval on every host and in every test that imports the declaration.
- **`load` lives on `liveValue`, not `serveValue`**, because both halves act
  on it: the server picks its mode, the client enables its HTTP read. As a
  serve option the halves could disagree, and the client would wait forever
  for a sub-ack value the server never sends.
- **`patches` likewise**: the runtime diffs and answers a joining tab from the
  value the others hold; the client keeps the wire value it last applied and
  resubscribes when a patch's base is not it.
- **`bytes`** carries `version` / `epoch` / `watermark` in response headers,
  so the client's stale-drop and cross-boot guards work unchanged.
- **A param'd preload is enumerated, never L2-persisted**: an L2 row is one
  param-less tuple per key. Every enumerated tuple loads on every page load,
  so enumerate exactly what first paint reads. Loaded without flight or
  watermark: nothing compares these values causally.

### Serve

- **`changes` is required on the external arm** so a value nobody tells of a
  change cannot be written without saying why that is honest.
- **Db values declare whole tables, with a reason.** The loader's SQL is
  hand-written, so nothing keeps a per-row filter in step with it — a wrong
  one silently misses writes. The reason states why any row's write may
  change any tuple (a singleton, a total). Reference:
  [declared reads for db values](../../../../research/2026-10-15-global-live-declared-reads-for-db-values-v2.md).
- **The drift guard routes an undeclared read FULL**, so a missing table is
  never staler than a whole-table read of it. No change ever reaches a value
  through its captured read-set — only through what it declares.
- **`reads.notified`** is for a hot relation read for a narrow fact a domain
  event announces: `automations.catalog` reads only `tasks_v`'s `status`;
  through the feed, every agent turn recomputed it.
- **`reads.lookups`** gate on the columns the lookup reads, per tuple: a
  conversation's turn re-reads no `edited-files` page.
- **A thunk `reads` must be pushed**: it compiles at `bindDeferredResources`,
  before the change feed builds triggers.
- **`throttleMs` is leading-edge**, so an isolated change is never held; and
  only the throttle releases a held one (not another value's flush, not a
  `recomputeOn` cascade), so the bound holds on a busy server.
- **`recomputeOn` mapped form** compiles to a value-aware map that computes
  the upstream on every notify even with nobody subscribed to it — prefer
  one notify fan-out for values that move together (config's documents,
  conflicts and tiers).
- **`whileSubscribed` is one function returning its stop**, so a start
  without its stop cannot be written. Nothing watches between a stop and the
  next start, and nothing needs to: the runtime opens every subscription span
  with a fresh version, so a reconnecting tab never gets `up-to-date` for a
  value it read before the gap.
- **Refusals.**
  - Never retried, never reported: a refused question is an answer, not a
    failure.
  - The client reads an undeclared code as `contract-mismatch` (`skew`):
    the server's declaration is not its bundle's.
- **Not spelled** (rejected): `ackChannel` (an optimistic reader asks for acks
  on its own subscription), a read-side `select`, row-scoped `recomputeOn`
  edges (an upstream's change recomputes whole tuples). Reference:
  [values migration contract](../../../../research/2026-09-26-global-live-values-migration-contract.md).

### Read

- **`useLive(value, null)` instead of a `""` stand-in.** The stand-in
  subscribed a real tuple the server loaded for nothing.
- **Object = one tuple, array = many**, so the two forms never overlap. That
  is why a param-less value has no list form and a typed-query schema may not
  itself be a list.

## Typed-query values — `liveValue(key, { query })`

- **The byte-identical re-encode gate** is what makes one question one tuple
  (`{}` and `{ x: <default> }` are one), and it refuses a non-idempotent
  parse (a transform that moves its own output — every read a mismatch)
  without walking the zod tree. A refinement passes.
- **2 KiB cap**: a bigger question is a request body, not a tuple.

## Desktop-only reads — `needsMachine`

- **Not on a union**: its arms are served by their own plugins.
- **`unavailable` is its own read kind** (the kind latch): the transport and
  the declaration are both fixed for a call site, so the hook order never
  changes.

## Event reads — `useLiveReader`

- **An unobserved tuple's answer is never cached**: the reader asked once, at
  an event; caching would leave an unwatched value for a later `useLive` to
  mistake for a live one.

## Old spellings — lint `no-legacy-resource-spelling`

- **Deleted spellings stay listed** so a stale import is told its
  replacement, not only tsc's "no exported member".
- **`no-endpoint-read`.**
  - Fire-and-forget writes in effects pass: effects run genuine writes
    (record a play, flush logs).
  - A function escaping the file is unflagged: a one-file lint cannot see
    where it runs.
  - Residual: nothing static tells "click → POST read → show" from "click →
    POST write → show its result"; review holds it.
  - The substrate is exempt because every live read is implemented over
    TanStack queries there.
  - `noDebt` rather than `closed`: `closed` would refuse the substrate's
    sanctioned entries too.

## Internals

- **String order is `C` collation** (initdb `--no-locale`) so SQL order
  equals in-memory code-point order; the group value tiebreak relies on it.

## Wire params

- **Each param present only when non-default**, so the default window stays
  byte-identical `{ limit: "100" }` — the tuple boot hydrates and every plain
  reader shares.
