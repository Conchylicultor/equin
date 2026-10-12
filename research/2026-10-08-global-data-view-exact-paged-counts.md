# DataView: exact section counts over paged reads

> **Status: landed** (`cc0166ae05`). `DataViewPaging.total` is
> `DataViewPagingTotal` (`{ count, uniform? }`, `data-view/core`), threaded
> into `rowsComplete` as `{ growable, total }`; `liveCollection` declares
> `count: true` and mints `:count`, read with `useLive(c, { count: true,
> where? })`; live sources read it over their scope only; the queue's Done,
> History and All conversations count exactly, and `conversationsGoneStats` is
> gone. Not landed as written: §3's grouped `byValue` per-bucket totals — a
> live source grouped by a groupable column now lists server sections with
> exact counts from `:groups` instead (data-view CLAUDE.md, *Live sources*).
> The design below is kept as the record.

> **Superseded (2026-10-09):** the segmented scroll (`useLiveScroll`, `shared/scroll-plan.ts`, every loaded segment live, the 16-segment cap) is replaced by live key-range pages (`useLiveCollectionPages`, `shared/page-plan.ts`) whose liveness follows the viewport — see `research/2026-10-09-global-live-key-range-pages-v2.md`. Where this doc reads a scroll or its segments, read the paged read and its pages.

## Context

Since `7535e62b2d`, a DataView over a paged read shows a section count as a lower
bound (`Done 30+`, `All 100+`) until every page is loaded, because it only counts
the rows it holds (`rowsComplete: false | { growable }`). Often the exact total is
cheap and the server already knows it. The queue's Done section has
`conversationsGoneStats.totalGoneCount`, but that is a hand-written second COUNT
whose predicate (`kind <> 'system' AND status = 'done' AND ended_at IS NOT NULL`)
has to be kept in step with `conversationsGone`'s serve options by hand.

Goal: a count is **exact by default whenever that is cheap**, and `N+` only where
it is not. The total has to come from the collection itself, so it cannot drift
from the rows, and no consumer wires it in by hand.

Decided policy (user): a DataView asks for the total **only over the source's
scope**, meaning no user filter and no search. Under a filter or a search the
count stays `N+`.

## Design

### 1. `network/live`: a collection can declare a cheap total (`count: true`)

- `LiveCollectionSpec.count?: true` is an opt-in. The author is asserting that a
  COUNT over the collection's base is cheap enough to recompute on every change to
  its tables, the same judgment `unbounded: { reason }` asks for. Declaring it
  mints a fourth sibling, `${key}:count`: a plain push value
  `ResourceDescriptor<number, LiveCountParams>` whose params are `{ where? }`
  (canonical encode/decode, the same `where` codec as `:groups`). The
  `LiveCollection` type gains `count: LiveCountDescriptor<F> | undefined`, typed
  `never` for an undeclared collection (the `all` property is the precedent).
- Read: `useLive(c, { count: true, where? })` returns `ResourceResult<number>`. It
  is a new arm in `use-live.ts`, next to the `groupBy` arm, and on a collection
  without `count` it is a tsc error.
- Preload: when the collection preloads, the **unfiltered** count tuple
  preloads with it (boot snapshot, plus L2 when it is DB-backed), so a scope-less
  total paints settled.
- Server: `serveCollection` compiles `:count` the same way it compiles `:groups`,
  as `SELECT count(*) FROM <table+joins> WHERE <base> AND <where>`, and routes it
  on the same change-feed read set. A new `compileCountQuery` goes in
  `infra/query-resource/server/internal/` beside `compile-groups.ts`, reusing its
  where/joins planning. A union (`arms`) collection sums its per-arm counts
  (`planGroupArm` already plans one arm per kind). If that turns out to be
  non-trivial, `arms` + `count` becomes a declaration error for now and a
  follow-up task.
- Files: `plugins/network/plugins/live/core/internal/{live-collection.ts,query.ts,query-codec.ts}`,
  `web/internal/use-live.ts`, `server/internal/serve-collection.ts` (+ `serve-union.ts`),
  `plugins/infra/plugins/query-resource/server/internal/compile-count.ts` (new),
  plus `resource-vocabulary` if the new sibling has to be listed for the scanners.

### 2. `data-view` core: paging carries an optional known total

`DataViewPaging<TRow>` gains:

```ts
/**
 * How many rows the WHOLE read holds, when it is known cheaply. Absent or null:
 * unknown, so a section holding paged rows stays a lower bound until `complete`.
 * `uniform`: field ids on which every row of the read has the SAME value, so
 * unloaded rows land in the section the loaded ones are in (e.g. the queue's
 * synthetic `section`).
 */
total?: { count: number; uniform?: readonly string[] } | null;
```

`DataViewRowsComplete<TRow>` becomes a third shape, which the body derives from
`paging`:

```ts
| { growable: (row: TRow) => boolean; total: number | null; uniform: readonly string[] }
```

`partitionIntoSections` (`web/internal/use-data-view-sections.ts`) then decides
each section's count:

- A section with no growable row: exact, as today.
- A section holding growable rows, where `total` is known, **the section holds
  every loaded growable row**, and the view is ungrouped or grouped by a field in
  `uniform`: `exact(nonGrowableInSection + total)`.
- Otherwise: `atLeast(n)`, as today. That covers the appearance-order shortcut
  (exact once a later section has started), which stays.

The body (`data-view-body.tsx`, where `rowsComplete` is built near line 838)
passes `total` through **only when the view's search and in-memory filter don't
constrain** (`useRowMatcher(...) === null`). A filter or a search could hide rows
of the read, which would make the total wrong, so in that case the count stays
`N+`. For a live source this also follows from the source not asking for a total
under a filter or search.

### 3. Live `source`: ask for the total automatically

In `useLiveSource` (`web/internal/live-source.ts`):

- When `source.collection.count` is declared **and** the lowering has no view
  filter and no search (its `where` is only `source.scope`), also read
  `useLive(collection, { count: true, where: scope })`. It is always called with a
  stable hook order: a detached/`null` query otherwise, as `useLiveScroll(null)`
  does.
- Feed it into `paging.total`. A live source's rows are all paged and ungrouped,
  so the ungrouped section becomes `exact(total)`.
- **Grouped, `sectionOrder: "appearance"`** (a one-bucket-per-value grouping over
  a sortable column): also read `useLive(collection, { groupBy: column, where: scope })`
  (the existing `:groups`, which every window collection already has) and give the
  partition a per-bucket total map: `total` becomes `{ count, byValue?: Map }`, and
  `partitionIntoSections` uses `byValue.get(bucketValue)` for a section that is
  still growable. This applies only when the collection declares `count` (same
  cost opt-in) and the groups read is not truncated (`canGrow` false). Bucket
  groupings that are not one-per-value (date buckets) stay `N+`.
- While the total is pending or has failed, the count stays the lower bound. That
  is truthful (at least N), so it does not break the "not-known-yet" rule; the
  total only ever refines it.

### 4. Consumers

- **`tasks-core`**: `conversationsGone` declares `count: true`. Delete
  `conversationsGoneStats` (core descriptor, `conversationsGoneStatsServed`, its
  `declare`, `countGoneConversations`), so the total is the collection's own and
  cannot drift.
- **`conversations/web/use-conversations.ts`**: `totalGoneCount` comes from
  `useLive(conversationsGone, { count: true })`. That is preloaded, because
  `conversationsGone` is `preload: "boot"`, so the welcome view's counts still
  paint settled.
- **Queue** (`.../data-view/plugins/queue/web/components/use-queue-rows.ts`):
  `paging.total = { count: goneCount, uniform: ["section"] }` from the same
  `useLive(conversationsGone, { count: true })`. Done then reads exactly, for
  example `Done 1 234`, while it is grouped by `section` with no search.
- **Live sources** (History, All conversations, events, runs, mail, Sonata
  library, …): opt in per collection by adding `count: true` where a base COUNT is
  cheap. First pass: the conversation collections behind History / All
  conversations. List the others in the PR, and leave out any collection that is
  large or write-hot (events) unless it is known to be cheap.

### 5. Docs

- `data-view/CLAUDE.md`, *Paging*: the `Counts:` bullet describes `total`,
  `uniform`, and the filter/search fallback.
- `network/live/CLAUDE.md`: `count: true`, the `:count` sibling, its preload, and
  `useLive(c, { count: true })`.

## Verification

- Unit (`./singularity test plugins/primitives/plugins/data-view`):
  `use-data-view-sections.test.ts` cases for a growable section with a total
  (ungrouped, grouped by a `uniform` field, grouped by a non-uniform field → `N+`,
  growable rows split across sections → `N+`, appearance + `byValue`).
- Live (`./singularity test plugins/network/plugins/live`): codec round-trip for
  `:count` params, a serve test that the count matches the window's rows under the
  base and a `where` (oracle-style beside `serve-collection-oracle.test.ts`), and
  the tsc-level `count` read on an undeclared collection (`@ts-expect-error`).
- `data-view/web/__tests__/live-source.test.tsx`: a source with a declared count
  renders `All 1234`, while a search renders `100+`.
- E2E: extend `queue/e2e/done-paging.ts` to check that the Done header shows the
  exact count, equal to `query_db` `count(*)` of done conversations, before any
  page is loaded, and switches to `N+` while a search is active.
- `./singularity build` (checks, which include `plugins-doc-in-sync` and
  `type-check`), then eyeball `http://<worktree>.localhost:9000` for the queue's
  Done header and the History count.
