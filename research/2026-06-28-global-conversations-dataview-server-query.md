# Conversations × DataView — server-query seam (scale to ~10k)

**Date:** 2026-06-28
**Category:** global (data-view primitive + fields + conversations)
**Status:** Plan — awaiting approval

## Context

`data-view` is the Notion-like multi-view surface (table/list/gallery/tree) with
built-in filter/sort/search and per-view persistence. Today it is **strictly
in-memory**: a consumer hands it `rows: readonly TRow[]`, and search/filter/sort
run as pure JS over that array in `useFlatRows`
(`data-view/web/internal/use-flat-rows.ts`). There is **no server-delegation
seam** — no callback fires when the user changes sort/filter.

We want conversations to reuse that filter/sort/search machinery while scaling to
~10,000 conversations. The blocker isn't rendering (the list/gallery/tree views
already virtualize via `<VirtualRows>`); it's the data layer:

- `conversationsActiveResource` (`tasks-core/server/internal/resources.ts:43`) is
  an **unbounded full-table live-state push** — every active row, re-pushed on
  every meaningful change. At 10k this is the scaling wall.
- There is no user-facing SQL `WHERE`/`ORDER BY` surface for conversations; the
  active list is hard-coded `ORDER BY createdAt DESC`, no filter.

**Outcome:** a reusable server-delegated data source for `data-view` (filter +
sort + search + keyset pagination compiled to SQL), with a cheap live
"invalidation tick" keeping the loaded window fresh. Conversations is the first
consumer, via a new full-pane **"All conversations"** view. The in-memory path is
untouched — `dataSource` is purely additive.

### Approved decisions

1. **Liveness = invalidation tick.** Paginated SQL is the source of truth; a cheap
   scalar live-state signal triggers refetch of the currently-loaded pages. Works
   under any sort/filter; near-live.
2. **First surface = new full-pane "All conversations" DataView.** The sidebar
   `HistoryView` stays as-is.
3. **Compiler = generic data-view primitive.** A reusable
   `FilterGroup`/`SortRule` → SQL compiler + keyset cursor logic lives in a new
   `data-view/plugins/server-query` companion; conversations is the first consumer.

## Architecture

```
DataView (web)                    ── optional dataSource={{ fetchPage, changeTick }}
  └ DataViewInner                 ── runs useServerDataSource(activeState, dataSource)
       substitutes rows + strips sort/filter/query  →  useFlatRows becomes identity
       views virtualize the accumulated pages via <VirtualRows> (unchanged)

useServerDataSource (web, NEW)    ── useInfiniteQuery; viewState→queryKey; tick→refetch
       │  POST /api/conversations/query  { sort, filter, query, cursor, limit }
       ▼
handleQuery (conversations server, NEW)
       compileWhere(filter) + buildSortKeys/seekPredicate(sort,cursor) + searchWhere(query)
       │  uses Fields.FilterSql resolver (per field-type operator→SQL)
       ▼  conversations_v   ──  { items, nextCursor, hasMore }   (limit+1 probe)

conversationsRevisionResource (NEW scalar push) ── the invalidation tick
```

**The seam (single insertion point).** In `DataViewInner`
(`data-view/web/components/data-view.tsx`, at the `renderProps` construction,
~line 180): when `dataSource` is present, feed the accumulated server rows and
neutralize the client pipeline so `useFlatRows` (search→filter→sort) collapses to
a pass-through. **No view-child (table/list/gallery/tree) changes** — they already
window the full array via `<VirtualRows items={rows}>`. The toolbar keeps reading
the real `activeState`, so the user still authors sort/filter/query; only the
state handed *into the view* is neutralized.

## Implementation

Staged so each step is independently testable.

### 1. Generic SQL compiler — `data-view/plugins/server-query/{core,server}`

- **`core`** (browser-safe, no drizzle): `ColumnBinding`/`FieldColumnMap` shape,
  `encodeCursor`/`decodeCursor` (base64url JSON of the keyset tuple + a sort
  signature; revives `Date`s by key type).
- **`server`** (owns `drizzle-orm`): `compileWhere(filter, map, resolve)` walks
  the `FilterGroup` AND/OR tree → drizzle `and()`/`or()`; `buildSortKeys`,
  `orderBy` (explicit `NULLS LAST` on every key), `seekPredicate` (null-aware
  lexicographic OR-of-AND), `compilePage` (the `limit+1` probe).
- Imports `FilterGroup`/`FilterNode`/`SortRule` from `@plugins/.../data-view/core`
  (pure types, already barrel-exported; same dependency direction as
  gallery/table/list — no cycle).
- **Keyset, not OFFSET** (chosen for refetch-stability under live inserts, not raw
  speed): always append PK `id asc` as a total-order tiebreaker; the cursor is the
  last row's key tuple. Refetch of a stored page param is then gap-free even when
  rows are inserted above it — required for the tick-refetch model.
- Non-SQL field in a filter/sort rule → **ignore** (drop the fragment / skip the
  key), never 400. Matches data-view's fail-soft orphan doctrine; the UI only
  offers mapped fields as filterable (structural, via the shared vocabulary).
- Tests: pure unit tests of compiler output + a null-boundary seek test on a
  nullable column (`endedAt`) — the highest-risk correctness area.

### 2. `Fields.FilterSql` capability — `fields/server` + per-type contributors

- New server registry parallel to the existing `Fields.Storage` carve-out:
  `(typeId, operatorId) → (col, operand) => SQL`, resolved through the field-type
  extends-chain (`int`→`number`, `multiline-text`→`text`).
- Contributors under `fields/plugins/<type>/plugins/filter-sql/server/` for
  **text, enum, bool, number, date** — each SQL fragment must reproduce the
  existing JS predicate's truth table (incl. NULL handling and the "empty operand
  ⇒ emit nothing" rule that drops incomplete rules). Use drizzle's `sql` template
  for bound params (no injection); escape LIKE wildcards.
- **Date refactor (prereq):** lift the pure anchor math
  (`resolveAnchorDay`/`addUnits`/`withinRange`,
  `fields/plugins/date/plugins/filter/web/internal/`) into a browser-safe core so
  the SQL contributor reuses it byte-identically. Day-granular comparisons compile
  to half-open `timestamptz` ranges (`c >= $d AND c < $d+1d`).
- Tests: per-operator SQL truth-table parity with the `*-filter-logic.test.ts`.

### 3. Wire schema — `FilterGroupSchema` in `data-view/core`

Recursive `z.lazy` zod mirror of the `FilterGroup` interface, for body validation.

### 4. Conversations endpoint + revision tick — `conversations/plugins/all-conversations/{core,server}`

- **`POST /api/conversations/query`** (`defineEndpoint`): body
  `{ sort, filter, query, cursor?, limit }`, response
  `{ items, nextCursor, hasMore }`. POST so the structured `FilterGroup` rides in
  the body.
- **Handler** (`implement`, mirroring
  `conversations/server/internal/handle-list-gone.ts`): compose
  `ne(kind,'system')` + `searchWhere(query)` (ILIKE over `title`/`model`/
  `worktreePath`) + `compileWhere(filter)`; order/seek from `buildSortKeys`; query
  `conversations_v`; `limit+1` → `{ items, hasMore, nextCursor }`. Reject a cursor
  whose sort-signature ≠ the request's (backstop). Register the route in
  `conversations/server/index.ts` httpRoutes.
- **Field vocabulary** (`all-conversations/core`): one `CONVERSATION_FIELDS` table
  (id/type/label/sortable) drives **both** the web `FieldDef[]` and the server
  `FieldColumnMap` so they can't drift. v1 columns: `title`(text), `status`(enum),
  `model`(enum), `kind`(enum), `runtime`(text), `createdAt`(date),
  `endedAt`(date, nullable), `worktreePath`(text).
- **`conversationsRevisionResource`** (new scalar push, mirroring
  `conversationsGoneStatsResource`): loader reads only status-bucket counts +
  `max(createdAt)`/`max(endedAt)` + total over `ne(kind,'system')`, hashed to a
  `rev` string. Because it never reads `updatedAt`/`lastViewedAt`/`waitingFor`,
  transient ~1/s churn yields a byte-identical scalar → `mode:"push"` no-op
  suppression fires it only on real changes (new/status/ended). `debounceMs:250`.
  Known v1 gap: a pure title/model edit won't pulse — acceptable; note it.
- **Index:** add `(createdAt, id)` composite index to `_conversations`
  (`tables.ts`) so the default keyset is index-only. Generate via
  `./equin build` (never `drizzle-kit` by hand).

### 5. Client hook + DataView seam — `data-view/web` + `data-view/core`

- **`useServerDataSource(view, { fetchPage, changeTick, pageSize? })`** (new):
  `useInfiniteQuery` keyed on `stableStringify(view)` (sort+filter+query) →
  changing any restarts pagination from page 0; `getNextPageParam` reads
  `lastPage.nextCursor` (server-computed keyset, not client-derived);
  `changeTick` kept **out** of the queryKey and instead drives `q.refetch()` (keep
  loaded page count, re-run each stored keyset param). Returns
  `{ rows, hasMore, fetchMore, sentinelRef, loading }`. Reuse the
  `IntersectionObserver` sentinel idiom from `cursor-pagination` (or its
  `ScrollSentinel`).
- **`DataViewProps.dataSource?`** (new, `data-view/core/internal/types.ts`):
  carries `{ fetchPage, changeTick, pageSize? }` (a factory, not pre-resolved
  rows) so `DataViewInner` invokes the hook with the live `activeState` it already
  owns — `ViewState` stays the single source of truth; the consumer never touches
  it.
- **`DataViewInner` substitution** (~line 180): `effectiveRows = server.rows`;
  `effectiveState = { ...activeState, sort:[], filter:null, query:"" }`; render the
  sentinel after the view body inside the root pane scroll.

### 6. The pane — `all-conversations/web`

`defineDataView("all-conversations")`, an `AllConversationsView` full-pane host
(`views={["table","list"]}`), `conversationFieldDefs` derived from
`CONVERSATION_FIELDS`, pane route + sidebar entry, `onRowActivate` → open the
conversation. **Author `config/<plugin>/all-conversations.jsonc`** with ≥1 view
instance — the `data-view` configs-authored build check fails otherwise.

### 7. Build

`./equin build` — codegen picks up the new `defineDataView` marker + new
plugins + the migration. Then `./equin check`.

## Critical files

- `plugins/primitives/plugins/data-view/web/components/data-view.tsx` — the seam (~L180)
- `plugins/primitives/plugins/data-view/core/internal/types.ts` — `DataViewProps.dataSource`, `FilterGroupSchema`
- `plugins/primitives/plugins/data-view/web/internal/use-flat-rows.ts` — confirm no-op pass-through
- `plugins/primitives/plugins/data-view/plugins/server-query/{core,server}/` — NEW compiler
- `plugins/primitives/plugins/data-view/web/internal/use-server-data-source.ts` — NEW hook
- `plugins/fields/server/` + `plugins/fields/plugins/<type>/plugins/filter-sql/server/` — NEW `Fields.FilterSql`
- `plugins/fields/plugins/date/plugins/filter/web/internal/` — lift anchor math to a core
- `plugins/conversations/plugins/all-conversations/{core,server,web}/` — NEW endpoint/handler/tick/pane
- `plugins/conversations/server/internal/handle-list-gone.ts` — handler template (`limit+1`)
- `plugins/tasks/plugins/tasks-core/server/internal/{tables.ts,views.ts,resources.ts}` — index, `conversations_v`, revision-resource pattern
- `plugins/primitives/plugins/cursor-pagination/web/` — sentinel/IntersectionObserver idiom

## Risks & edge-cases

- **NULLS-LAST seek correctness** (highest risk): the desc-nulls-last branch and
  the "null cursor value ⇒ FALSE after-term, eq-term `IS NULL` chains to next key"
  logic must be unit-tested with a nullable sort column crossing the null boundary
  mid-scroll. Wrong → duplicated/skipped rows at page seams.
- **Date timezone fidelity:** SQL anchors resolve on the *server* clock/TZ; the JS
  predicate uses the *browser* local day. Send the client TZ offset in the body
  (or resolve to UTC-day and document). Subtlest correctness gap.
- **Tick-refetch cost:** post-debounce the revision loader could fire ~4×/s; two
  aggregate scans over ≤10k each is fine but watch under contention (cf.
  `research/2026-06-15-global-live-state-cascade-contention.md`).
- **Ext-table fields** (category/progress/notes) aren't on `conversations_v` →
  filtering on them silently drops (correct per ignore policy); enabling them later
  needs a join into the view + a map entry, not just a `FieldDef`.
- **`ConversationSchema` vs `conversations_v`:** ensure the response item schema
  covers projected columns (`worktreePath`/`taskId`/`active`), as the existing
  gone/active resources already do.

## Verification

1. `./equin build` then `./equin check` (boundaries, migrations,
   data-view configs-authored, plugins-registry/doc-in-sync all green).
2. Unit tests: `bun test plugins/primitives/plugins/data-view/plugins/server-query`
   (compiler + null-boundary seek) and the per-type `filter-sql` truth-table
   tests under `plugins/fields/plugins/*/plugins/filter-sql`.
3. Seed scale: insert ~10k synthetic conversations (script via `query_db` is
   read-only — use a server-side seed or the existing test harness) and open
   `http://<worktree>.localhost:9000` → the All-conversations pane.
4. Scripted Playwright (`e2e/screenshot.mjs`): scroll to trigger
   `fetchNextPage` (verify pages accumulate, no dup/skip at seams); apply a status
   filter + sort by title (verify SQL result order); type a search term (ILIKE);
   then mutate a conversation's status elsewhere and confirm the tick refetches the
   loaded window in place (no scroll jump).
5. Inspect `~/.singularity/worktrees/<wt>/logs/*.jsonl` for query timings; confirm
   the default `createdAt DESC` keyset is index-backed and pages stay <50ms at 10k.
```