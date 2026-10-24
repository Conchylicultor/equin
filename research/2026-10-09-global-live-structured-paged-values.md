# Live values with a typed query, cursor-paged external values, and the end of the endpoint read path

Task: `task-1790898513975-hnlevo`. Follow-up (main, chained): `task-1791560308-woqgfi`.

## Context

`network/live` is meant to be the one way the web reads server data: a live read refreshes itself, because the server pushes the new value or tells the tab to refetch. Three kinds of read cannot be written with it, so they use a second path. That path is `useEndpoint` / `useEndpointResource` / `useQueryResource` over `fetchEndpoint`, plus a hand-made revision tick for freshness:

1. **Structured params.** A value's params are `Record<name, string>`. Typed params (`params: { window: z.enum(...) }`) can only *narrow a string* (`live-value.ts` `paramsGate`). So a typed request such as metrics' `MetricQuery` (a range union, tz, split or compare, typed metric params) is sent as a POST body.
2. **External paged reads.** Paging exists only for Postgres collections: windows grow by limit, and `scroll: true` uses keyset cuts compiled to SQL. A cursor-paged read over git or a file archive has no live form.
3. **Request/response reads in general.** About 115 `useEndpoint` / `useEndpointResource` sites in web code have never been audited, and no lint stops new ones.

The first consumer is the metrics primitive (P1). `useMetric` and `useMetricDetails` read POST endpoints through `useQueryResource` / `useInfiniteQueryResource`, keyed on `metrics.revision`. That is the last revision tick on main (Resources page, item 7, "Gap found by the metrics primitive").

**Decisions (user, 2026-10-09)**
- Paging over an external source is a **cursor chain**: each page is its own live tuple, and every loaded page stays live.
- **Scope = mechanism + metrics + ratchet lint.** The ~115 existing endpoint reads become `debt` exemptions of a new lint. Their migration is the chained main task `task-1791560308-woqgfi`.

**Done means:**
- `network/live` can spell all three reads.
- Metrics reads only through `useLive`.
- `metrics.revision`, the metrics endpoints, `useInfiniteQueryResource` and `useQueryResource`'s dependency-keyed form are deleted.
- `live/no-endpoint-read` stops new endpoint reads in web code.

## What already exists and is reused

- **The structured-in-a-string precedent.** A collection window sends its `where` filter tree and its `order` as one canonical JSON string param each, through a strict codec. Decode throws unless the input re-encodes byte-identically (`core/internal/query-codec.ts`, `plugins/filter/core/internal/codec.ts`). So the runtime, WS frames, the HTTP fallback (`URLSearchParams`), tuple keys, ETags and the query cache all keep `Record<string, string>`, and none of them change.
- **`load: "on-demand"`** (the runtime's `invalidate`). It is declared on the `liveValue`. The server keeps the loader out of the shared flush and sends `invalidate`, and each tab re-reads over HTTP. The cache keeps the previous answer on screen while the refetch runs.
- **`whileSubscribed(params, notify)`** gives each tuple a 0→1 / N→0 lifecycle (`shared/compile-value.ts`). The runtime opens every subscription span with a fresh version, which replaces metrics' "bump the rev at span start" trick.
- **`useLive(value, null)`** is the skip: pending, nothing read.
- **`useLiveScroll` + `shared/scroll-plan.ts`** show how to chain several tuples through `useResources`. Replaced tuples stay subscribed and rendered until their replacements settle, and the plan is pure data that tests check.
- **`PagedResourceResult` / `ResourcePaging`** (`canGrow`, `growing`, `loadMore`; error arm with `stale`) is the paged result shape. The drill drawer already renders it.
- **`canonicalParams`** (`packages/canonical-params`) is the one-spelling-per-tuple package that both ends share. The deep canonical JSON helper goes there.

## 1. Structured params: `liveValue(key, { query })`

```ts
// core/
export const metricQuery = liveValue("metrics.query", {
  schema: MetricResultSchema,
  query: MetricQuerySchema,      // any JSON-safe zod schema; mutually exclusive with `params`
  load: "on-demand",
});
// web/
useLive(metricQuery, query);     // query: z.input<typeof MetricQuerySchema> | null
// server/
serveValue(metricQuery, { source: "external", loader: (q) => runQuery(registry, q, new Date()), whileSubscribed });
```

- **Wire.** One param, `{ q: canonicalJson(schema.parse(query)) }`.
  - `canonicalJson` (new, in `packages/canonical-params/core`) sorts object keys at every depth, keeps array order, and refuses anything that is not plain JSON: `undefined` inside arrays, non-finite numbers, Dates, class instances, and so on.
  - Parsing before encoding folds defaults, so `{}` and `{ x: <default> }` are one tuple.
  - The descriptor's wire `P` stays `{ q: string }`. The typed `Q` rides on a new `LiveQueryValue<T, Q>` (`live: "value"`, `query: QueryCodec<Q>`).
  - `useLive`, `serveValue`, `notify` and `whileSubscribed` take `Q` and encode or decode at the boundary.
- **The gate (`validateParams`)** does five things:
  1. checks that `q` is the only key;
  2. runs `JSON.parse`;
  3. runs `schema.safeParse`;
  4. requires `canonicalJson(parsed) === q`;
  5. hands the decoded value to the loader.

  A failure is `contract-mismatch` (`ResourceContractError`), the same as a non-canonical window.
  - The equality check is what makes "one logical query, one tuple" true at runtime. It refuses a schema whose parse is not idempotent, such as a transform, without the declaration-time zod walk that typed string params need. Refinements (metrics' `tz` refine) are allowed.
- **Size.** `LIVE_QUERY_MAX_BYTES` = 2 KiB on the encoded `q`. Encoding past it throws in the browser, because the HTTP fallback puts it in a URL. `MetricQuery` is about 150–300 B.
- **Typing rules (tsc):**
  - `query` and `params` cannot both be set.
  - A query value cannot be preloaded (it has no default tuple; the same rule as params).
  - `origin: "central"` is allowed, as it is for params.
  - The `useLive(v, query | null)` overload is chosen by `query` on the descriptor.
- **Encoding and decoding happen in one place:** a `queryCodec(key, schema)` in `core/internal/query-value.ts`, shared by `liveValue`, the web read and `shared/compile-value.ts`.

## 2. Cursor-paged external values: `liveValue(key, { query, paged })`

```ts
export const metricDetails = liveValue("metrics.details", {
  query: DetailsSelectorSchema,  // DetailsQuery without cursor / limit
  paged: {
    item: DrillItemSchema,
    id: "id",                    // the item key: dedupe across page boundaries
    meta: z.object({ total: z.number().int().nonnegative() }),
    limit: 50,                   // page size; the read may ask a smaller first page
  },
  load: "on-demand",
});
useLive(metricDetails, selector, { first: 5 });  // → LivePagesResult<DrillItem, { total }>
serveValue(metricDetails, {
  source: "external",
  loader: (q, { cursor, limit }) => ({ items, nextCursor, meta: { total } }),
  whileSubscribed,
});
```

- **One page is one tuple** `{ q, n, c? }`: the query, the limit, and the opaque server cursor (absent on the first page). The wire schema is derived as `{ items: item[] (≤ n, checked), nextCursor: string | null, meta }`. The gate also checks that `n` is an integer in `1..limit` and that `c` is a non-empty string ≤ 1 KiB.
- **The chain** is pure data in `shared/page-chain.ts`, beside `scroll-plan.ts`:
  - Page 0 is `{ q, n: first ?? limit }`.
  - Page k+1 is `{ q, n: limit, c: page_k.nextCursor }`, minted only after `loadMore()`.
  - The hook (`web/internal/use-live-pages.ts`) reads the chain's tuples through `useResources`.
- **Live semantics:**
  - Each page refreshes on its own: the server invalidates it, and the tab refetches it.
  - If a refreshed page k returns a different `nextCursor`, page k+1's tuple is re-minted from it. The old tuple stays subscribed and rendered until the new one settles, using the same handoff rule as `useLiveScroll`. The chain therefore never flips back to loading.
  - When data shifts across a boundary, a duplicate is dropped by `id`, keeping the first occurrence.
  - `meta` comes from page 0.
  - A cap of `MAX_LIVE_PAGES` (32) leaves `canGrow: false` and sets `truncated: true`.
- **Result** `LivePagesResult<Item, Meta>` is `PagedResourceResult<Item>`, with `meta` added on the ready arm and also on the error arm when it is known.
  - A failed `loadMore` page puts the chain in the error arm, with the rows already held as `stale`, as today.
  - A query change starts over in the loading state.
- **Not spelled:** paged `source: "db"` (a Postgres list is a `liveCollection`; tsc refuses it), preload, and limit growth.

## 3. Metrics onto `useLive`

- **`core/`.** Add `metricCatalog = liveValue("metrics.catalog", { schema: CatalogSchema })`, plus `metricQuery` and `metricDetails` as above. `DetailsQuerySchema` is split into `DetailsSelectorSchema` (metric, interval, split, params), and cursor/limit become the paging tuple.
  - Delete `core/revision.ts` (`metricRevision`) and `shared/endpoints.ts`.
- **`server/`:**
  - **`metrics.catalog`**: external, `loader: () => getMetricRegistry().catalog`, never notified. The catalog is fixed per process, and a restart re-subscribes.
  - **`metrics.query` / `metrics.details`**: external, on-demand, `throttleMs: 1000` (keeps the old burst collapse). Their loaders are today's `runQuery` / `runDetails`. Validation failures become a `MetricQueryError` instead of `HttpError(400)`.
    - **Verify early:** check that a loader's thrown message reaches the card's `ResourceErrorInline` as the read's error arm. If it does not, stop and raise it.
  - **New `server/internal/source-watch.ts`**: a refcounted per-source hub. `whileSubscribed(q, notify)` resolves the query's source, and the hub's `acquire(sourceId, notify) → release` starts `source.changes` once per source and fans each change out to every subscribed tuple's `notify`.
  - Delete `server/internal/revision.ts` and the three `implement(...)` HTTP handlers.
- **`web/internal/use-metric.ts`:**
  - `useMetricCatalog() = useLive(metricCatalog)`.
  - `useMetric(query) = useLive(metricQuery, query)`.
  - `useMetricDetails(selector) = useLive(metricDetails, selector, { first: DETAILS_PREVIEW })`.
  - The `source` argument goes away. The query names its metric, and the server resolves the source.
  - "Keep the last answer while it refreshes" is now the cache's on-demand refetch, and a changed query is a new tuple that shows loading.
  - The drill drawer reads `meta.total` instead of `pages[0].total` and renders the flat item list.
- **`metrics/CLAUDE.md`, research P1 doc:** freshness is now `changes` → hub → per-tuple notify. Revision tick removed.

## 3b. Typed refusal (added 2026-10-09, user decision)

The early check failed. A loader throw reaches the tab only as `500 (loader-failed)` over HTTP, or as `sub-error { reason: "loader-failed" }` over WS, with no message. Every throw is also filed as a crash report. Metrics answers a bad query with a clean 400 today, so moving it as-is would make its errors worse.

The fix is a `ResourceRefusal` error, exported from `packages/resource-protocol`, that a loader throws for an expected problem the caller caused:
- **Server.** The runtime does not report it as a crash. It sends the message: over HTTP as a 4xx with `detail` and reason `"refused"`, and over WS as a `SubErrorFrame` whose `message` field (new) carries the text.
- **Client.** The read's error arm surfaces it as kind `refused`, with the server's text as the message.
- **Metrics.** `MetricQueryError` is a `ResourceRefusal`.
- **Other throws** keep today's `loader-failed` path and are still reported.

The follow-up migration needs the same mechanism for the endpoint reads that answer 400 today.

## 4. Delete the second path's live-state hooks

- **`useInfiniteQueryResource`**: metrics was its only caller. Delete it.
- **`useQueryResource`'s dependency-keyed overloads** (`useQueryResource(dep, build)`, the form a revision tick plugs into): metrics was the only caller. Delete them, together with `BLOCKED_KEY` / `depKey`, so a rev-keyed query has no spelling. The plain-options form stays for local async loads that are not server reads (`plugin-meta/exhibits` loads code-split modules), and its doc says exactly that.
- `useEndpointResource` stays until the follow-up task, behind the lint below.

## 5. The ratchet: lint `live/no-endpoint-read`

- **Location.** `network/live/lint/no-endpoint-read.ts`, registered in `lint/index.ts`, beside `no-legacy-resource-spelling`. It reuses that rule's import-resolution approach: named, aliased and namespace imports.
- **What it flags,** in files under a `web/` folder, test code excluded:
  - imports of `useEndpoint` (`infra/endpoints/web`) and `useEndpointResource` (`live-state/web`);
  - imports of `useQuery` / `useInfiniteQuery` / `useSuspenseQuery` from `@tanstack/react-query`;
  - a `fetchEndpoint(...)` call inside a `queryFn` property.

  The message names the replacements: `liveValue` (`params` / `query` / `paged`), or `liveCollection`, read with `useLive`.
- **What it allows.** Imperative `fetchEndpoint` (mutations and event handlers) is not a read, so it is untouched.
- **Exemptions:**
  - `sanctioned`: the substrate that defines or wraps these hooks (`infra/endpoints`, `primitives/live-state`, `network/live`, and `primitives/cursor-pagination` until the follow-up decides on it).
  - `debt`, `task: task-1791560308-woqgfi`: every current site, as file-level entries in each owning plugin's `exempt/index.ts`. Create the file where it is missing; this is mechanical and produced from the rule's own report.
  - Unused-exemption reporting means a migrated file cannot keep its entry.
- **Docs.** `network/live/CLAUDE.md` gets two new sections, "Typed-query values" and "Paged values", and the lint is added to "Old spellings". `infra/endpoints` docs say endpoints are for writes and for reads that are sanctioned to stay request/response.

## Critical files

- `plugins/packages/plugins/canonical-params/core/` (`canonicalJson` + tests)
- `plugins/network/plugins/live/core/internal/{live-value.ts, query-value.ts (new)}`, `core/index.ts`
- `plugins/network/plugins/live/shared/{compile-value.ts, page-chain.ts (new)}`
- `plugins/network/plugins/live/server/internal/serve-value.ts` (query and paged overloads; `ServedExternalValue.notify(q)`)
- `plugins/network/plugins/live/web/internal/{use-live.ts, use-live-pages.ts (new)}`, `web/index.ts`
- `plugins/network/plugins/live/lint/{no-endpoint-read.ts (new), index.ts}`, plus `exempt/index.ts` files across the debt plugins
- `plugins/framework/plugins/tooling/plugins/resource-vocabulary/core/vocabulary.ts` and `plugins/plugin-meta/plugins/facets/plugins/resources/facet/parse-resources.ts`, if the scanners need to record `query` / `paged` (no new factory, so the mint is still `liveValue`'s)
- `plugins/primitives/plugins/live-state/web/{use-query-resource.ts, index.ts}`
- `plugins/primitives/plugins/metrics/{core/{wire.ts, revision.ts→deleted, index.ts}, shared/endpoints.ts→deleted, server/internal/{handlers.ts, revision.ts→deleted, source-watch.ts (new), resources.ts (new)}, server/index.ts, web/internal/use-metric.ts, web/components/{drill-drawer.tsx, metric-card.tsx, metric-tile.tsx, breakdown-card.tsx, board-view.tsx}, CLAUDE.md}`

## Verification

- **Tests:** `./equin test plugins/packages/plugins/canonical-params plugins/network/plugins/live plugins/primitives/plugins/live-state plugins/primitives/plugins/metrics`
  - **`canonicalJson`**: key order is folded at every depth, arrays keep order, and non-JSON input throws.
  - **Query value:**
    - encoding then decoding round-trips;
    - a default is folded into one tuple;
    - a non-canonical `q`, an extra key, or a schema failure is `contract-mismatch`;
    - a transforming schema is refused by the equality check;
    - going over `LIVE_QUERY_MAX_BYTES` throws.
    - `@ts-expect-error` cases: `query` together with `params`, `query` together with `preload`, and `useLive(v)` without its query.
  - **`serveValue` with query and paged:**
    - the loader receives the decoded `Q` and `{ cursor, limit }`;
    - `notify(q)` invalidates exactly that tuple;
    - `whileSubscribed` pairs per tuple;
    - a page with more than `n` items fails loudly;
    - a paged `source: "db"` is a tsc error.
  - **`page-chain` (pure):**
    - first page versus later pages;
    - a re-minted successor when `nextCursor` changes;
    - the handoff keeps the old pages until the new ones settle;
    - dedupe by id;
    - the cap gives `truncated`.
  - **jsdom `use-live`:**
    - a query value goes from pending to settled, and a query change shows loading;
    - an invalidate keeps the old answer while it refetches;
    - pages: `loadMore` grows the list, a failed page gives the error arm with `stale`, and `useLive(v, null)` reads nothing.
  - **Metrics, server:** the handler tests move onto the served loaders through `registerValue` on a test runtime. One test covers the hub: two subscribed queries on one source share one `changes` subscription, a change invalidates both, and the last release stops it.
  - **Metrics, web:** `board.test.tsx` still mocks `use-metric`. Its fakes are updated to the new signatures.
- **`./equin check`:** `type-check` (lint included), `resource-vocabulary`, `plugins-doc-in-sync`, `plugins-registry-in-sync`, and the exempt in-sync / unused-exemption reporting. The lint fires on a fixture `useEndpoint` read in a web file and stays quiet on an exempted one.
- **`./equin build`,** then deploy at `http://<worktree>.localhost:9000`. Metrics has no real source on main (P2 adds them), so the end-to-end proof is the runtime-level test above plus one look at the read-set debug pane: `metrics.catalog` / `.query` / `.details` are listed as external, and `metrics.revision` is gone.
- **Grep gates:**
  - `rg "metricRevision|metrics.revision|useInfiniteQueryResource" plugins` returns nothing outside history notes.
  - `rg "useQueryResource\(" plugins` finds only `exhibits` and the definition.
- **Resources page:** update the item-7 "Gap found by the metrics primitive" status line in the agent card (`block-f6465fff-…`) to say the gap is closed, the lint is the ratchet, and the migration is `task-1791560308-woqgfi`.

## Result (sections 1–4; §5 landed separately)

As planned, with these deviations:

- **One entry point per form for `compileValue` / `registerValue`.** `serveValue` (worktree and central) carries the query / paged overloads, but the test-facing compile and register helpers are separate functions — `compileValue` / `compileQueryValue` / `compilePagedValue` (and `registerValue` / `registerQueryValue` / `registerPagedValue`) over one erased `compileValueOf`. Overloading them moved every existing `@ts-expect-error` on a wrong option to "no overload matches" at the call, so a misuse was no longer pinned to its property.
- **`notify(q)` on a paged value** reaches every subscribed page of the question through a per-`q` set of page tuples that `shared/compile-value.ts` keeps from the runtime's own 0→1 / N→0 hooks. The runtime's `subscribedParamsFor` is not exposed, and widening `resource-runtime`'s API (framework) was out of scope.
- **The codec rides on the descriptor** (`value.query`). `core/internal/query-value.ts` holds the one implementation (`queryCodec` → `liveQueryCodec` / `livePageCodec`). The params gate, `useLive` and the served half all read the descriptor's codec, so no consumer imports a second copy.
- **The provider contract is unchanged.** A metric's `details` still returns a `DrillPage` (`{ items, total, nextCursor }`), and the served loader maps it to `{ items, nextCursor, meta: { total } }`. `DetailsQuerySchema` became `DetailsSelectorSchema` (no cursor / limit) plus `DrillMetaSchema`. `runQuery` / `runDetails` moved from `handlers.ts` to `run.ts`, and the option factories live in `served.ts` so tests can drive them (`resources.ts` serves them).
- **Drill drawer.** The "Show all N" label shows when the next page completes the list (`total ≤ loaded + DRILL_PAGE`); otherwise it says "Show more". It used to show whenever only the first page was loaded, which is not visible on the flat item list.
- **Scanners** needed no change. `liveValue` is still the mint; query and paged values have no `preload`, and `load: "on-demand"` is read where it always was.

**The early check failed, and was fixed structurally (user decision: option A).** A loader's thrown message did not reach the read's error arm: the HTTP read answered `500 loader-failed` with no detail, `sub-error` carried no message, and every throw was reported as a server crash. Now:

- `ResourceRefusal` (`packages/resource-protocol`) is an expected, caller-caused refusal a loader throws, and `"refused"` joins the shared failure reasons.
- The runtime never reports it (`reportLoaderError` only logs it). The HTTP read answers `422 { reason: "refused", detail }`, and the sub-ack read sends `sub-error { reason: "refused", message }`.
- The live-state client maps it to `ResourceError` kind `refused` whose message is the server's. It is terminal (never retried) and is not counted as a failing read in the health row or the report sink. `ResourceErrorInline` shows the message with no Retry.
- `MetricQueryError extends ResourceRefusal`.
- Pinned by `resource-runtime/core/runtime-refusal.test.ts`, the client mapping tests, and the metrics refused-query test in `served.test.ts`.
