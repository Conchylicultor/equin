# Unified, consumer-first live-resource API — design + proof on `events.sources`

## Context

Live resources have 12 ways to be declared and served today (8 descriptor factories + 4
server register calls). Each spelling is a fixed combination of independent choices: where
the value comes from, payload shape, bound, who writes the loader, and which process serves
it. Consumers pick the bound (window vs point) themselves, and the bounded-collection rule
lives only in docs.

The target model is drafted on the Resources page (`block-f64cfc08-…`) and in its agent
sub-page "Live resources — audit and target model" (`block-fbee0e5f-…`, §8–9). In short:

- declare a **collection** or a **value**;
- the consumer asks a **query**, and the bound is internal;
- filters are **data**;
- a one-row read has three states: loading, found, doesn't exist;
- the wire protocol stays internal;
- one umbrella, `network/live/`.

This doc settles the open decisions: the consumer API and its result states, the filter
language, paging, and the migration path. It proves the collection half end to end on one
real collection (`events.sources`) before anything else migrates.

Prior research this builds on:

- `research/2026-09-23-global-live-resources-open-questions.md` (audit §10);
- `research/2026-07-18-global-bounded-working-set-resource-contract.md` (window/point runtime);
- `research/2026-09-24-global-bound-five-whole-table-resources.md`.

## Decisions (user, 2026-09-25)

- **Proof target:** `events.sources`.
- **Filter language:** a new small language (option A below), not DataView's `FilterGroup`.
- **Old factories:** leave them untouched, migrate the call sites directly, and delete each
  factory once it has no callers. No wrapper layer. This answers the page's human card
  "Can they be deleted/replaced? Or is it required for the migration": wrappers are not
  required.

## The API

### Declare (core, browser-safe)

```ts
export const eventSources = liveCollection("events.sources", {
  row: EventSourceSchema,
  id: "id",
  filterable: { status: EventSourceStatusSchema, enabled: z.boolean() },
  sortable: ["createdAt", "name"],
  default: { orderBy: [["createdAt", "desc"]], limit: 100 },
  maxLimit: 500,
  // preload: "boot" (later: none | boot | boot-and-keep; the proof uses none)
});
```

- **Why the key is a positional string literal:** the build scanners
  (`parse-utils` `parseStaticCallId`, `plugin-meta/facets/plugins/resources/facet/parse-resources.ts`)
  need it to be a string literal and throw on anything else.
- **Two runtime resources, one declaration.** `liveCollection` mints `events.sources`
  (window membership) and `events.sources:rows` (point membership). The runtime's
  `KeyedMembership` is fixed per definition, so one resource cannot be both. This needs no
  runtime change, and consumers never see the second key.
- **Bounded by construction.** A collection always has a default limit and a `maxLimit`, and
  there is no unbounded spelling. This answers the human card "Why check? Can't this be
  enforced by the API": for collections, yes. A small domain-bounded array (for example a
  roster) is a *value*. When the value phase lands, `serveValue` with `source: "db"` and an
  array schema requires `unbounded: { reason }` at the type level, so the rule is a type
  error, not a check.

### Read (web)

```ts
useLive(eventSources)                                            // default window
useLive(eventSources, { where: { enabled: true, status: { in: ["running", "error"] } },
                        orderBy: [["name", "asc"]], limit: 50 }) // window
useLive(eventSources, { ids: visibleIds })                       // point set
useLiveRow(eventSources, sourceId)                               // one row
```

- **`useLive` result:** `ResourceResult<Row[]>` extended on the settled arm with `canGrow`,
  `growing` and `loadMore()`.
  - `canGrow = rows.length === limit && limit < maxLimit`.
  - While a grow loads, the hook stays **settled** on the previous rows (`growing: true`),
    so `if (pending) <Spinner/>` never flashes. Those rows are server-vouched and still
    subscribed through keep-alive.
  - A point query (`{ ids }`) has no paging fields. The union is discriminated by the query's
    shape.
- **`useLiveRow` result:**
  `{ pending: true; error; stale? } | { pending: false; found: true; row } | { pending: false; found: false }`.
  - It is built on the `:rows` point resource (today's `usePointResource` + `gate: true`).
  - A point read ignores the window's filter: it answers "does this row exist", nothing else.
  - A nullable id (audit finding G) is deferred. `useResource` has no skip option, and
    subscribing `{ids:""}` would report `found:false` for "no id", which is not "missing".
    It needs an `enabled` option on `useResource` first.
- **Filters are typed against the declaration.** An undeclared column, a wrong operand type,
  or a non-sortable `orderBy` fails in `tsc`.

### Serve (server)

```ts
export const eventSourcesServed = serveCollection(eventSources, { from: eventSourcesEntity });
// contributions: [...eventSourcesServed.declare]   // two Resource.Declare entries
```

- **Column binding.** Filterable and sortable names bind to the table's columns by property
  name, type-checked against `from` (a `PgTable` or an `Entity`). An optional `columns`
  override covers renamed columns.
- **What it compiles to.** `serveCollection` calls the existing `compileWindowQuery` twice,
  once for the window and once for the point sibling. `maxLimit` is read from the
  declaration, not restated.
- **Registration.** It returns `{ window, rows, declare: [Resource.Declare(window), Resource.Declare(rows)] }`,
  so there is no new Declare API. Folding `Resource.Declare` into serving is left for later.
- **Hand-written loaders** (aggregates, joins, git or file reads) are out of the proof. In the
  migration they either become values with fixed params, or collections with
  `serveCollection(c, { loader, scope })` and *required* filter columns. A required filter
  column is how "scoped by a parent-id param" (one thread's messages) is spelled:
  `useLive(messages, { where: { conversationId } })`.

## Filter language (`LiveWhere`)

> **Superseded** by `research/2026-09-25-global-unified-filter-language.md`: the
> filter is now the shared filter language (`network/live/plugins/filter`) —
> `filterable` declares domains, `where` may also be an and/or tree, negative ops
> keep NULL, `isNull` became `isEmpty` / `isNotEmpty`, and the wire `where` is
> `encodeFilter` output. This section is kept as the original design record.

```ts
where: { enabled: true, status: { in: ["running", "error"] }, createdAt: { gte: iso } }
```

- **Shape.** AND across declared columns. Each column takes a plain value (meaning equals) or
  exactly one operator: `eq`, `ne`, `in`, `notIn`, `gt`, `gte`, `lt`, `lte`, `isNull`.
  There is no OR across columns and no operator whose answer depends on the current time.
- **One op table in `core/`.** Each operator is one entry pairing
  `sql(target: SQL, operand) => SQL` with `test(value, operand) => boolean`. Both runtimes
  import the same table.
  - The SQL side takes a rendered `sql` target, never the drizzle column, so an operand never
    passes through the column's write encoder. This is the same rule as `server-query`'s
    `comparisonTarget`.
  - A parity test runs every operator both in memory and against real Postgres (a throwaway
    DB from `database/db-test-fixture`) and asserts the same answer. That keeps "can be
    evaluated in memory later" true.
- **Validation and security.** Operands are validated by the column's zod schema. `in` and
  `notIn` are capped (≤ 100) to keep the HTTP fallback URL bounded. The server's decode
  rejects unknown columns, unknown operators and bad operands by throwing, never by
  defaulting. The filterable whitelist is a security property.
- **Canonical encoding.** Keys are sorted, `in` lists are sorted and deduped, and `{eq: x}`
  becomes `x`. Encode fills in the defaults and then drops every part equal to the default.
  Decode is strict and re-encodes to compare, so a non-canonical spelling can never create a
  second subscription for the same query.
- **In-memory routing is not in v1.** The change feed carries ids only, and bounded snapshots
  keep hashes, not rows. Routing by filter needs a runtime hook `routeTuples(changedIds, tuples)`
  that does one shared row read per change, then tests each tuple's `where` in memory. It
  can skip a tuple only when the id was not a member, the row fails `where`, and it is not a
  delete. That hook is a later runtime change, done when a collection has many filter tuples.
  v1 keeps today's cost: one scoped refill per subscribed tuple per change, plus one ids query
  on a membership change.
- **DataView bridge (later, with the revision-tick lists).**
  `filterGroupToLiveWhere(group, fieldMap)` returns `{ ok: true, where }` or
  `{ ok: false, reason }`. Filters that don't fit stay client-side. Not in the proof:
  `sources-list.tsx` filters a derived `extraction` field that has no column.

## Wire params (internal)

The window resource's params stay additive string keys, as `live-state/core/window.ts:14`
already planned for `cursor`:

- `limit`, always present;
- `where`, canonical JSON, present only when non-empty;
- `order`, canonical JSON, present only when it differs from the default.

The default window is therefore still `{ limit: "100" }`, byte-identical to today. The boot
snapshot tuple, the paramsKey and every existing tuple are unchanged. Verified safe: paramsKey
is sorted-key JSON of opaque strings (`runtime.ts:1580`), and the HTTP fallback round-trips
through `URLSearchParams`.

## Paging

- **v1: grow the limit.** `loadMore()` raises the limit by one page (the default limit),
  clamped to `maxLimit`. Each step is a new tuple and a full windowed load, and the old tuple
  lingers through keep-alive. That is fine up to `maxLimit` 500, and documented as such.
  The encoder throws above `maxLimit`, so there is no silent clamp that creates a separate
  tuple holding the capped rows.
- **Later: cursor.** Deep paging past `maxLimit` uses a `cursor` param built on
  `primitives/keyset`. It lands with the revision-tick list migration, which is the only
  consumer that scrolls that deep.

## Proof slice: `events.sources`

### Runtime and compiler changes (`plugins/infra/plugins/query-resource`)

- `server/internal/spec.ts`: `orderBy` may be `(params) => WindowOrderKey[]`, as `where`
  already may be.
- `server/internal/compile-window.ts`:
  - compute `orderSql` per params, memoized per canonical order (today it is computed once at
    `:187-236`);
  - derive `orderSignatureOf` from the **union of all sortable columns**. That needs no runtime
    change; the cost is one extra bounded ids query when a sortable column that is not being
    sorted on changes;
  - read `maxLimit` from the collection.

### New plugin: `plugins/network/plugins/live/`

The umbrella starts here, with the new API's own code (`core/`, `server/`, `web/`). The nine
existing plugins move under it later with `./equin plugin move`.

- `core/`: `liveCollection`, the op table, the query codec (encode/decode/canonicalize) and
  the `LiveWhere` / `LiveQuery` types.
- `server/`: `serveCollection`, which builds the window and point specs and calls
  `windowQueryResource` from `query-resource/server`.
- `web/`: `useLive` and `useLiveRow`, built on `useResource` / `usePointResource` from
  `live-state/web`.

### Scanner updates

- `framework/tooling/resource-vocabulary/core/vocabulary.ts`: add the new core barrel to the
  derived factory set. `liveCollection` returns a pair, so widen `DescriptorFactory` with the
  minted key suffixes (`["", ":rows"]`). Without this it is invisible to the docs facet and
  eager-tier codegen, with no error.
- `resource-vocabulary/check/index.ts`: add `serveCollection` to the register markers.
- `plugin-meta/facets/plugins/resources/facet/parse-resources.ts`: `buildDescriptorIndex`
  emits one `DescriptorInfo` per minted key.

### Migrating `events.sources`

- `events-core/core/internal/resources.ts`: `windowQueryResourceDescriptor` → `liveCollection`.
- `events-core/server/internal/resources.ts` + `server/index.ts:104`: `windowQueryResource` →
  `serveCollection`, and spread `.declare` into the contributions.
- `events-core/web/internal/hooks.ts`: `useEventSources` becomes `useLive(eventSources)`.
  Also export a `useEventSource(id)` built on `useLiveRow`.
- `sources/web/internal/use-source.ts`: replace the `.find` over the window with `useLiveRow`.
  This fixes the documented bug: a source outside the newest-100 window showed as `missing`.
- `sources/plugins/source-field/web/components/source-field.tsx`: the Source filter options
  become `useLive(eventSources, { orderBy: [["name", "asc"]], limit: 500 })`. This gives a
  real client-chosen sort, plus every source, not just the newest 100.
- `events-core/web/internal/source-origin.ts`: same window bug. Out of the proof; note it in
  the follow-up.
- `sources-list.tsx`: stays on the default window (`useLive(eventSources)`), filtering on the
  client.

### Tests

- **Parity** (`network/live/core`, Postgres): every operator, in memory vs real Postgres
  (`createTestDb`).
- **Codec** (`network/live/core`, bun:test):
  - default → `{limit:"100"}`;
  - explicit defaults encode to the same bytes;
  - permuted keys and `in` lists canonicalize;
  - unknown column, unknown op, bad operand, or limit above max each throw on decode;
  - decode(encode(q)) = q.
- **Compiled runtime** (extend `query-resource/server/internal/compile-window-runtime.test.ts`):
  - filtering `enabled` in a `where:{enabled:true}` tuple removes the row and backfills the
    tail;
  - a `name` update reorders a name-sorted tuple;
  - an entrant enters only the tuples whose filter it matches;
  - grow 20 → 40 creates a new tuple, and `canGrow` goes false at the end;
  - a point read reports found and missing.
- **Hooks** (jsdom, `network/live/web/__tests__`):
  - `useLiveRow` goes pending → found / not found;
  - `useLive` grow keeps `pending:false` with `growing:true`, then settles on the larger set.

## Phases after the proof

1. **Filter at scale: the notifications bell.** ✅ **Done (2026-09-25)** — see
   `research/2026-09-25-global-live-bell-filter-groupby-preload.md` (server-filtered window,
   `groupBy` query shape for the chips, `preload: "boot"`, base `where`, derived projection).
   Its type filter ran over only the newest 200
   rows, so older notifications of that type never showed. The fix is
   `useLive(notifications, { where: { type } })`. This also proves `preload: "boot"`
   on the default window before bulk migration.
2. **Values.** ✅ **Done (2026-09-25)** — see `research/2026-09-25-global-live-values.md`
   (`liveValue` / `serveValue` / `useLive(value)`, `preload` replacing `bootCritical`, proven on
   the bell's whole-table unread badge `notifications.unread`; `resident` retires with item 3).
   - `liveValue` / `serveValue`, with a `source: "db" | "external"` arm; only `external`
     returns `notify()`.
   - Push is the default. `load: "on-demand"` replaces `mode: "invalidate"`.
   - A db value with an array schema requires `unbounded: { reason }` in the type.
   - Replace `bootCritical` / `resident` with `preload: none | boot | boot-and-keep`.
3. **Bulk migration, plugin by plugin.** ✅ **Done (2026-09-27)** — see
   `research/2026-09-27-global-live-resources-phase3-bulk-migration.md` (75 resources; the old
   spellings remain only for the tree / revision-tick / config resources, enforced by the
   `live/no-legacy-resource-spelling` lint; `mode` is required, so the invalidate default is gone;
   the window/point descriptor factories are internal to `network/live`).
   The 11 bounded resources and the unbounded
   `queryResource` collections go to `liveCollection`. The ~80 `resourceDescriptor` values go
   to `liveValue`, mechanically. Hand-written keyed collections get required filter columns.
   Delete each old factory once it has no callers. `resource-vocabulary` shrinks with it.
4. **Tree resources** (`tasks`, `attempts`, `agent-launches`, `pages`, `page-links`) wait for
   the design for loading part of a tree.
5. **Revision-tick paged lists** fold in once cursor paging, the `FilterGroup` bridge, and
   joined sort columns contributed by a side table (the open question in §9) exist.
6. **Consolidation:** move the nine plugins under `network/live/`.

## Verification

- `./equin test plugins/network/plugins/live plugins/infra/plugins/query-resource plugins/framework/plugins/resource-runtime`,
  including the unchanged `runtime-window-membership` suite.
- `./equin check`: type-check, plugin-boundaries, resource-vocabulary,
  keyed-resource-scope, plugins-doc-in-sync (the docs show both minted keys).
- `./equin build`, then an E2E script `plugins/apps/plugins/events/plugins/sources/e2e/live-sources.ts`:
  - open a source detail pane by id and see it found;
  - open an unknown id and see the explicit "missing" state, not a spinner;
  - toggle a source's `enabled` and see the list and detail update live;
  - on the events list, open the Source filter and see the options sorted by name.
- Slow-ops: confirm `loader` spans for both `events.sources` and `events.sources:rows`, with
  no new flush stalls.
