# One paging mechanism for network/live

Task: two live paging mechanisms diverge: collection key-range pages and cursor-paged values. This plan must settle before task-1791593959-9liyj7, which depends on it.

Research map and design panel: this conversation's two workflows (four readers plus a critic; three designs, three judges and a synthesis). Paths are relative to `plugins/network/plugins/live/` unless they start with `plugins/` or `research/`.

## Context

On 2026-10-10 three ways to read "more rows" were live side by side:

| | A. Key-range pages | B. Cursor-paged values | C. Plain window growth |
|---|---|---|---|
| Code | `shared/page-plan.ts` (938 lines) + `web/internal/use-live-collection-pages.ts` (580 lines) | `shared/page-chain.ts` (264 lines) + `web/internal/use-live-pages.ts` (220 lines) | `useCollection` in `web/internal/use-live.ts` (~L431–530) |
| Entry point | `useLiveCollectionPages`, reached only through data-view's `useLivePagesPaging` | `useLive(v, q, { first })` | `useLive(c, q)` → `loadMore` |
| What a page is | A key range `(after, until]` between server-minted cuts | `{ cursor: predecessor.nextCursor, n }` | One tuple whose `limit` grows by one step at a time |
| Boundary stability | A cut belongs to its row; it never moves | Page k+1 is re-minted whenever page k's `nextCursor` moves, in a cascade | Not applicable (one tuple) |
| Which pages are live | Only pages near the viewport | Every loaded page | The whole window |
| Depth | Unbounded | 32 pages | `maxLimit` rows |
| Cost to grow | One new page, seeded | One new page | A full reload of the larger window (O(limit)) |
| Users | 11 DataView surfaces and the Queue's Done section | **None.** `metrics.details` has no provider and no mounted surface | Set readers, hand-rolled lists |

Facts this plan builds on (all verified in code):

- **The planner does not depend on Postgres.** `page-plan.ts` never orders keys; it only tests them for equality and null.
  - It does rely on three things from the source: each row carries a cut key (`$key`), a range `(after, until]` can be answered with a limit, and a page is a prefix of its range.
- **What ties A to Postgres is the server.** Postgres can mint `$key` and seek to it, and the runtime keeps those pages current with keyed deltas and seeded derivation.
  - Runtime rule **D31** (`resource-runtime/core/runtime.ts:3478`) says an external resource is never keyed. External `notify` is therefore a full reload only.
- **Nobody decided B's chain shape in a discussion.** The 2026-10-09 "decision" recorded in B's plan was the agent's own; the user did not make it.
  - B's plan was written against the segmented scroll, and the key-range pages that replaced it landed 11 minutes after B. Neither plan references the other.
  - The 2026-09-29 discussion had already rejected chained cursors for collections, because of cascading re-subscribes.
- **Page 0 of a plan is byte-identical to the default window tuple** (when its limit is the default). This is what lets the boot snapshot and plain readers share it.

## Decisions

### D1. A page is always a key range. The cursor chain is deleted.

**Why key ranges are the cleaner design.** A cut belongs to the rows: it is a *position* in a total order, valid even after its row is deleted. So:

- each page is independent of the others;
- a page can be released and re-subscribed by itself, which is what lets liveness follow the viewport;
- an insert near the head never re-mints the pages after it. The planner absorbs it with an overflow split.

A cursor belongs to the *previous page's answer*. That forces every page to stay live (a released page could not hand its successor a fresh cursor). It also forces a depth cap (the live set grows with depth), and it makes one change at the head cost up to N−1 serial re-mints. Those are exactly the three costs listed in the task.

**What this rules out.** A source that can only hand out forward tokens (Gmail `pageToken`, a provider's `nextCursor`) cannot be declared paged. Nobody can page such a source live with stable boundaries, because it has no positions to cut at. Its clean form is one of two:

- one bounded `liveValue`, its first N results;
- mirrored into Postgres as a collection, which is already how `mail.threads` works.

Today no paged value has a user, so this rules out nothing that runs.

### D2. One planner and one entry point. The viewport only decides liveness.

`useLive` is the single entry point for every read. There is one planner (`page-plan.ts`), and a source plugs into it through an adapter seam. The **viewport is optional** and only changes which pages are live:

| Read | Live pages | Depth |
|---|---|---|
| `useLive(src, q, { viewport })` | The band around the viewport (±1, hysteresis at 2). Pages farther away are stale, then placeholders, as today. | Unbounded |
| `useLive(src, q)` (no viewport) | Every loaded page | Total rows capped at `maxLimit` |

**Why this is not duplication.** A reader that cannot say which rows are on screen must keep everything it loaded live, so its cost is O(loaded). "Bounded by construction" then requires a cap, and `maxLimit` is the cap such a reader already has today. The cap is the boundedness rule, not a second mechanism: the code path (`reconcile` / `split` / `assemble`) is the same.

The alternatives are worse on every axis:

- **Keeping C (limit growth) next to the planner** is duplicated code. It is also slower: each grow step is a fresh full load of O(limit), against one seeded page.
- **"Every page live, no cap"** breaks the rule that a reader is bounded by construction.

So mechanism C is deleted. It is not extracted into a shared helper. That happens in two steps:

- **In this plan:** C is deleted for every source that already carries `$key`: the scroll collections and the paged values.
- **In 9liyj7 (P5):** C is deleted for the remaining collections. They first need `$key` projected on every window, which is gated on a `benchmark_boot` measurement. Until then, a non-scroll collection's plain read keeps today's `loadMore`.

**Result types.** Each viewport mode keeps the state set its readers rely on:

- **Without a viewport:** the result is `LiveListResult<Row>` (`data`, `canGrow`, `growing`, `loadMore`, and an error arm with `stale`), exactly as plain readers have it today.
- **With a viewport:** the result is `LivePagesResult<Row>`, today's `LiveCollectionPagesResult` renamed (`rows`, `pageErrors`, `placeholders`, `truncated`).

Only the viewport mode has placeholders and per-page notices. Those are different *states*, which is the documented reason for a separate result shape.

`VisibleRange` stays branded, and data-view stays its only minter (today's lint). Giving hand-rolled lists a viewport is 9liyj7's work. The internal "all live" mode is not a `PageViewport` variant: it is the absence of the option, so it cannot be smuggled through a `VisibleRange`.

### D3. End state: one runtime path. Every page is a keyed window, whatever its source.

**Today the runtime has two paths:**

- **Collection pages** are keyed window membership entries. A change arrives as routed table changes carrying `affectedIds` and leaves as small `delta` frames. A split or merge is *seeded*: the server copies rows it already holds, so no load happens.
- **External values** are unkeyed. A `notify` reloads the whole tuple, and the client receives the whole value again (`update`), or an `invalidate` followed by an HTTP refetch.

**Clean end state.** The source decides only *how a change arrives*. Everything after that is shared:

| Source | How a change arrives |
|---|---|
| Postgres | A routed change carrying the affected ids (scoped refill) |
| External | `notify(q)`: every live page of `q` is re-run, then diffed by key (`drainMembershipFull`, which already exists and never calls `windowIdsOf`) |

Both then share:

- keyed `delta` frames;
- snapshots;
- seeded split and merge;
- one client cache path (`appliedSeq`, `socketValue`);
- no `derivable` branch in the planner seam.

**To get there,** D31 is narrowed: "an external resource is never *routed*", instead of never keyed. A new "external window membership" arm takes `limitOf` / `familyOf` from the codec. `windowIdsOf` comes from loading the page and mapping its ids, and is only needed on the paths that already call it.

**Sequencing.** It lands as the plan's last phase (P4). The unification (P1–P3) does not wait for it. Until P4, value pages are full-reload tuples that send no `derive`, which is correct but slower. Value pages will then carry derived acks, so they come under the per-build socket dialect, as collection pages already do. Fixing that dialect is item 9liyj7 already owns.

### D4. Smaller calls (recommended defaults, folded in)

- **Key contract for values.** The declaration says how to read a key: `key: { of: (item) => LiveCutKey, order: ("asc"|"desc")[] }`.
  - Parts are strings or null, the same `LiveCutKey` type collections use (a number or `Date` is a tsc error), and the framework appends the id.
  - The *framework* mints `$key` and checks every answer: arity, strictly ascending order, inside `(after, until]`, `≤ limit`, unique ids. A violation is a loud loader error.
  - The source supplies the precision of its text, which is the same principle as Postgres `::text`.
- **Meta** (B's page-0 `meta`) becomes a sibling per-question value, `value.meta`, declared through `paged.meta` and refreshed by the same `notify(q)`. Page 0 can be split or released, so it cannot own a per-question fact.
- **`{ first }` is dropped.** A preview is `useLive(v, q, { limit })`: the head page's limit, no viewport, capped at `maxLimit`.
- **One error model.** A paged read uses the collection pages' error model (head error, then per-page `pageErrors` with `retry`). B's `error { stale }` arm is gone.
- **`whileSubscribed` runs once per question,** not once per page. `pairLifecycle` gets a refcount keyed by `q` that counts every page tuple and the meta tuple.

## Design

### Public API

**core** (`core/internal/live-value.ts`, `core/internal/query-value.ts`, new `core/internal/row-key.ts`):

```ts
interface LivePagedSpec<Item, Meta> {
  item: LiveRowSchema<Item>;
  id: StringKeyOf<Item>;
  key: { of: (item: Item) => LiveCutKey; order: readonly ("asc" | "desc")[] };
  limit: number;       // H — step, default/page-0 limit
  maxLimit: number;    // ≥ 2H (same throw as scroll collections, live-collection.ts:731)
  meta?: ZodParser<Meta>;
}
type LivePagedParams = { q: string; limit: string; after?: string; until?: string };
```

- **`livePagedCodec`:** strict decode with a byte-identical round trip. Page 0 is `{ q, limit: H }`.
- **`row-key.ts`:** the cut checks shared with collections' `parseCut` (`core/internal/query-codec.ts` ~L362–392): canonical JSON, the 1 KiB `LIVE_ROW_KEY_MAX_BYTES` bound, parts that are strings or null, an id that is not null.
- **Deleted:** `LivePage`, `LivePageParams{q,n,c}`, `LivePageRequest`, `LivePageCodec`, `isLivePageCursor`, `LIVE_PAGE_CURSOR_MAX_BYTES`.

**web** (`web/internal/use-live.ts`, `web/index.ts`). Overloads are appended *after* the window and grouping overloads, so `where: or(…)` keeps its contextual typing:

```ts
useLive(c: LiveScrollCollection | null, q: LivePagesQuery | null, o: { viewport: VisibleRange; resetKey? }): LivePagesResult<Row>
useLive(v: LivePagedValue | null,      q: QIn | null,            o: { viewport: VisibleRange; resetKey? }): LivePagesResult<Item>
useLive(v: LivePagedValue,             q: QIn | null,            o?: { limit?: number; viewport?: never }): LiveListResult<Item>
// scroll collection without a viewport: the existing window overload; it now dispatches to the planner
```

- **Dispatch order.** A `viewport` in the options is checked *before* today's `source === null → useCount` branch. data-view passes a `null` collection for detached and sectioned reads (`data-view/web/internal/live-source.tsx:395-400`), and its hook order must stay fixed.
- **Branch guard.** A `useRef` records the branch the first render chose and throws if a later render picks another.
- **Renames:** `LiveCollectionPagesQuery` → `LivePagesQuery`, `LiveCollectionPageError` → `LivePageError`, `LiveCollectionPagePlaceholder` → `LivePagePlaceholder`.
- **Removed from the barrel:** `useLiveCollectionPages`, `MAX_LIVE_PAGES`, and B's `LivePagesOptions` / `LivePagesResult<Item,Meta>`.

**server** (`shared/compile-value.ts`, `server/internal/serve-value.ts`, `central/internal/serve-value.ts`):

```ts
loader: (query: Q, range: LiveKeyRange) => readonly Item[] | Promise<readonly Item[]>
interface LiveKeyRange { after: { key: LiveCutKey; id: string } | null; until: …; limit: number }
meta?: (query: Q) => Meta | Promise<Meta>
sliceRange(value, allItems, range)   // for sources that hold their whole list in memory
```

`notify(q)` reaches every subscribed page tuple of `q` and its meta tuple. The tracking per question already exists (`subjectsOf`, `compile-value.ts:374-397`).

### The seam (`web/internal/page-source.ts`, new)

```ts
interface PageSource<Row, Q, P> {
  descriptor; base(query): string; limits: { step; maxLimit };
  params(query, page: Page): P;   // INVARIANT: page 0 at step === the plain read's tuple (boot-snapshot equality)
  idField: string;                // entryOf reads row[idField] and row[LIVE_ROW_KEY]
  derivable: boolean;             // until P4: collections true, values false. Deleted in P4.
}
```

- `pageSourceOf(collection | pagedValue | null)` is cached per declaration in a `WeakMap`.
- `use-live-collection-pages.ts` becomes `web/internal/use-pages.ts`, which runs over the seam. Its body is unchanged except for:
  - an optional viewport: when it is absent, `liveSet` makes every page live and `loadMore` stops at `maxLimit` loaded rows;
  - the derive gate, which reads the seam's `derivable`.
- A `columns`-only change still keeps the plan, but only for collections: a value's `base` never includes `columns`.

### Metrics migration (B's only declaration; no provider, nothing mounted)

**`plugins/primitives/plugins/metrics/core/wire.ts`:**

- Tighten `DrillItem.at` to UTC `Z` with exactly millisecond precision (`z.string().datetime({ precision: 3 })`), so text order is time order. Today's `isoInstant` accepts any offset and any precision.
- Delete `DrillPage`.

**`metrics/core/live.ts`:**

```ts
paged: { item, id: "id", key: { of: i => [i.at], order: ["desc"] }, limit: 50, maxLimit: 500, meta }
```

**`metrics/server/internal/contribution.ts`:**

- `DetailsCtx` takes `range: LiveKeyRange` in place of `cursor` / `limit`, and returns `readonly DrillItem[]`.
- A new optional `detailsTotal` feeds `meta`.

**`metrics/server/internal/served.ts`:** passes the range through, and `whileSubscribed: watchMetric` now runs once per question.

**`metrics/web/internal/use-metric.ts:45`:**

- The preview reads `useLive(metricDetails, selector, { limit: DETAILS_PREVIEW })`.
- The total reads `useLive(metricDetails.meta, selector)`.

**`metrics/web/components/drill-drawer.tsx`:**

- "Show more" calls `loadMore`, up to 500 rows.
- The total renders as pending until it is known, never as 0.
- At the cap it reads "first N of total".

## Phases

Each phase builds and passes checks on its own.

1. **P0. Seam, no behaviour change.**
   - Add `page-source.ts` (collection source only).
   - Rename `use-live-collection-pages.ts` → `use-pages.ts`.
   - Extract `row-key.ts`.
   - Add the boot-equality test: `pageSourceOf(c).params({}, startPage)` deep-equals `c.window.defaultParams`, checked on fixtures and on `conversationsGone`.
2. **P1. Collections read through `useLive`.**
   - Add the viewport overload and the dispatch with its `useRef` guard.
   - Switch data-view's `useLivePagesPaging` to `useLive(c, q, { viewport, resetKey })`. It stays as data-view's glue that mints the viewport and the sink together.
   - Rename types and trim the barrel.
   - Point the `visible-range-minter` lint message at `useLive`.
   - Plain reads of a scroll collection without a viewport now go to the planner (all pages live, capped). The readers affected are `use-conversations.ts`, `recovery-view.tsx` and `use-release-info.ts`. Their page 0 tuple is unchanged, and `loadMore` now splits instead of reloading.
3. **P2. Paged values become key ranges.** This is one commit, because metrics is the only declaration.
   - Core spec and codec, `shared/key-order.ts` (the comparator: direction per part, nulls last, the id ascending as the tiebreak), and the loader checks.
   - `$key` minting, the meta sibling and the per-question lifecycle.
   - Worktree and central serve, the value overloads, `sliceRange`, and `server/testing` `checkPagedSource`.
   - The metrics migration.
   - Delete `page-chain.ts` and its test, `use-live-pages.ts`, `MAX_LIVE_PAGES`, `{first}`, and the cursor types.
4. **P3. Docs.**
   - In the live `CLAUDE.md`, merge "Paged collections" and "Paged values" into one "Paged reads" section that states D1–D3. Rewrite the C paragraph of *Read* as "a non-scroll collection, until P5".
   - Update the plugin description and the metrics and data-view docs.
   - Fix the stale "segments past `maxLimit`" comments in `plugins/reports/core/resources.ts:54`, `plugins/release/core/resources.ts:80` and `plugins/apps/plugins/deploy/plugins/deployments/core/runs.ts:224`.
5. **P4. One runtime path (D3).**
   - Narrow D31 to routes, and add the external window-membership arm in `resource-runtime/core/runtime.ts`: keyed entry, `limitOf` / `familyOf` / `windowIdsOf` from the value's codec and loader, and `notify(q)` → `drainMembershipFull` per live page.
   - Compile paged values as keyed (`keyOf` = id).
   - Delete `derivable` from the seam.
   - Extend `runtime-derive.test.ts`, and add an external-window oracle that seeds a split from value pages and turns `notify` into deltas.

## Deferred to task-1791593959-9liyj7

That task is re-planned on top of this plan.

- **P5.** `$key` on every window, gated on `benchmark_boot`. After it lands, mechanism C is deleted for every collection, the `scroll` flag goes, and `LiveScrollCollection` is retyped across `liveDataSource`, `useLivePagesPaging` and the overloads.
- **Viewports for hand-rolled lists.** Either move them onto DataView, or add a generic visible-rows minter (which moves the minter exemption). This is what gives them unbounded depth.
- **Set readers that read a window as a set** (starred, agent-origin, the automations origin field, event sources, the task-track auto-grow loop). They move to `all` collections or contributed columns.
- **The per-build socket dialect.** Replace the module URL with a protocol version. After P4, value pages also send derived acks, so this matters more.
- **The other open items:**
  - the hidden-rows marker;
  - a projection param for a `columns` change;
  - offset jump;
  - `long-sort-key` wording;
  - `LIST_MAX` for groupings;
  - the one-frame duplicate or gap across pages;
  - the `NotificationsClient` binding;
  - verifying the list, gallery and tree views;
  - `DERIVE_MAX_SOURCES`, defined twice (`runtime.ts:1189`, `notifications-client.ts:237`).
- **Seeding the first split after boot.** A boot-hydrated page 0 has `appliedSeq` 0, so `seedOf` refuses it.
- **A DataView source over a paged value,** which needs filterable and text-column seams that values do not have (`data-view/web/internal/live-data-source.ts:26-60`).

## Verification

**Must pass unchanged:**

- `./singularity test plugins/network/plugins/live`: `page-plan.test.ts` (27 cases), `serve-collection-pages-oracle.test.ts`, `scroll-key-roundtrip.test.ts`;
- `plugins/framework/plugins/resource-runtime`: `runtime-derive.test.ts`;
- `plugins/primitives/plugins/live-state`: `notifications-derive.test.ts`;
- `plugins/primitives/plugins/data-view`: `visible-rows.test.tsx`, `page-placeholders.test.tsx`;
- `lint/visible-range-minter.test.ts`.

**New or ported tests:**

- **`web/__tests__/use-pages.test.tsx`** (ported from `use-live-collection-pages.test.tsx`, driven through `useLive`). Its cases:
  - a value source splits without flashing;
  - a released value page unsubscribes at once;
  - `notify(q)` re-reads only the live pages;
  - an insert at the head overflow-splits page 0 without re-minting page 1;
  - with no viewport, every page is live, the read caps at `maxLimit` and `loadMore` splits;
  - a plain reader shares page 0 through the refcount and stays ready after the pager releases it;
  - toggling `null` ↔ collection under a viewport keeps the hook order;
  - a boot-hydrated `conversationsGone` page 0 is ready on the first render.
- **`web/__tests__/use-live-types.test.ts`** (`@ts-expect-error`): `limit` together with a viewport, `{ first }`, a key part that is not a string, `nextCursor` in a loader, and `opts | undefined` passed to the viewport overload.
- **`core/internal/query-value.test.ts`** (rewritten), plus `row-key.test.ts` and `shared/key-order.test.ts`.
- **`shared/compile-value.test.ts`:** each loader check fails loudly; `$key` is minted, and is null over 1 KiB; the meta sibling; one `whileSubscribed` per question.
- **`server/internal/serve-paged-value-oracle.test.ts`:** an in-memory source mutated at random through `checkPagedSource`, including a deleted cut row that stays a valid cut. After P4 the same oracle also asserts delta frames and seeded splits.
- **`metrics/server/internal/served.test.ts` and `run.test.ts`:** migrated.

**End to end:**

- `./singularity build`, then `./singularity run plugins/primitives/plugins/data-view/e2e/live-pages-scroll.ts`. The deep scroll must still show every row (5033/5033).
- Spot-check the Queue's Done section and the runs list at `http://<worktree>.localhost:9000`, using the e2e harness's screenshot script.
- `./singularity check` for boundaries, the minter lint, `plugins-doc-in-sync` and `type-check`.
