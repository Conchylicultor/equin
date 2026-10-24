# Live collections as key-range pages: paging cost set by the viewport, not by depth

Task `task-1790685688903-owz1mf` (Resources › item 7, API half; "limit 2" of the
2026-09-29 discussion). Status: **plan, awaiting approval**.

## 1. Context

**The ask.** Growing a live window should cost O(added rows). A read should page
past `maxLimit`, ideally without limit. Collections must stay bounded by
construction. No existing reader may silently widen. The default params must stay
byte-identical.

**The task text is out of date.**
- The seven revision-tick lists (runs, conversations, mail, events, deploy
  history, reports, release history) are already `scroll: true` live collections,
  read through `useLiveScroll`.
- `useServerDataSource` was deleted (`23a73ac070`, `3f7fe72db4`), and the
  Resources page marks item 7 "Done (2026-10-06)".
- They page past `maxLimit` with the **segmented scroll** (`shared/scroll-plan.ts`,
  shipped `c5c6433ce4` 2026-10-01). That is the "anchored multi-tuple segments"
  design the 09-29 discussion rejected. The routing agent chose it and recorded no
  user decision.

**What still holds.** Every segment is `{after, until, limit}`, so even a closed
segment is count-limited. As a result:

| Problem | Effect |
|---|---|
| A closed segment can hide rows | An insert inside it pushes its last row out. Each entry or exit costs an O(limit) `windowIdsOf` plus a backfill (`runtime.ts` ~4449). |
| Growing reloads | The tail grows H → 2H → … → M, and each step is a fresh tuple loaded in full, about M²/2H rows in total. A split costs M + 2H. A merge reloads too. Plain `useLive.loadMore` has the same cost. |
| Cost grows with depth | Every loaded segment stays live, hence `MAX_SCROLL_SEGMENTS = 16` and `truncated: "segment-cap"`, about 16·M rows. Plain `useLive` stops at `maxLimit`. |
| Churn rules | Split and merge hysteresis need `maxLimit ≥ 3·H`. |
| A projection change restarts the whole plan | `columns` is part of the plan key. |

**Decision (user, this conversation).** Build toward "infinite scroll for every
collection, without limitation". Raising a bound cannot get there: one growing
tuple still has O(depth) full reloads, `order` arrays and snapshots. The model is
instead: **a page is a key range, and liveness follows the viewport.**

## 2. Mental model

```
 head ───────────────────────────────────────────────────────────────▶ order
 [closed P1](c1)[closed P2](c2)[closed P3](c3)[closed P4](c4)[tail: after c4, limit H)
   stale          LIVE (band)   LIVE (visible) LIVE (band)    LIVE (when the footer is near)
```

- **Closed page `(cᵢ₋₁, cᵢ]`.** Every row matching `where` whose server-minted
  `$key` lies between two cuts. It has **no count limit**, so whether a row is a
  member depends only on the row's own key, and the page never hides a row. Its
  server read is capped at `cap = maxLimit + 1` rows. Reading `cap` rows
  (`rows.length === cap`) is the **overflow signal**.
- **Open tail `(c_last, ∞)` with limit H.** The only count-limited page. Its last
  row is where the next cut comes from.
- **Paging appends.** `loadMore` freezes the tail into a closed page ending at its
  last row's `$key`, then opens a new tail after it. That costs O(H) and does not
  re-read what is already loaded.
- **Viewport liveness.** A page is subscribed when it is visible or within ±1
  page. It is released once it is more than 2 pages away, so the band between the
  two thresholds gives hysteresis. A released page keeps its rows as **stale**
  data, or becomes a placeholder past a budget (P3). Live cost per reader is
  O(viewport), whatever the depth.
- **Overflow split.** A closed page that reaches `cap`, for example the head of a
  `desc` feed taking inserts, is split by the client at its median key. This is
  local and costs O(M). On a busy feed it is the steady state, at about one split
  per M/2 inserts, which is O(1) amortised per insert.

| Operation | Server | Client |
|---|---|---|
| First paint (`{limit:H}`, byte-identical) | O(H) | O(H) |
| `loadMore` (freeze the tail, open a new tail) | 2 × O(H) | 2 re-subscribes, seeded stale |
| A change inside a closed page | the scoped refill decides membership; on P1's runtime path also `windowIdsOf` ≤ O(cap); after P4, none on exit or in-place change | delta |
| Overflow | sticky full read ≤ O(cap) until the split | split: 2 × O(M/2) |
| Scroll a page out of / into the band | unsubscribe / O(page) sub-ack | stale rows shown until the ack |
| Depth | **no cap** | bounded by the P3 stale budget |

## 3. Design

### 3.1 Wire params and codec (`live/core/internal/{query.ts,query-codec.ts}`)

**Two canonical forms, and no new param key** (`PARAM_KEYS` is unchanged):

| Form | Params | Notes |
|---|---|---|
| Tail | `{limit, after?, where?, order?}` | The default `{limit:"H"}` is **byte-identical**, so boot tuples and L2 are untouched. |
| Closed | `{until, after?, where?, order?}` | **No `limit`.** |

- **Rule:** `until` present ⇔ `limit` absent. In P1 the legacy segment form
  `{until, limit}` is still accepted, because today's scroll and old tabs send it.
  P2 removes it.
- **Decoded type is a union**, so a "closed page with a count" cannot be written:
  ```ts
  type LiveWindowBound = { kind: "count"; limit: number } | { kind: "range"; until: LiveCutKey };
  interface LiveDecodedQuery { …; after?: LiveCutKey; bound: LiveWindowBound }   // replaces limit + until
  ```
- **`capOf(bound)`** returns `min(limit, maxLimit)` for `count` and
  `maxLimit + 1` for `range`. It is the one helper behind the loader,
  `windowIdsOf` and both compilers.
- **`live-state/core/window.ts` is NOT widened.** Live already supplies
  `spec.window.limitOf` (`serve-collection.ts` ~934, `serve-union.ts` ~497), and
  it returns `capOf(decode(p).bound)`.
- **`compile-window.ts` ~444** keeps clamping with `Math.min(…, maxLimit)` for
  count tuples only. A range tuple is passed `cap` through a `capOf`-shaped seam
  (`window.limitOf` returns the already-clamped cap, and the compiler stops
  re-clamping it).
- The codec still refuses cuts on a collection that is not `scroll`, and
  `validateParams` is the guard. No new server throw is needed.

### 3.2 Server: correct on today's runtime (no framework change)

- **A closed page needs no runtime change to be correct.** Served as a bounded
  window, its loader and `windowIdsOf` are exactly the first `cap` rows of
  `where ∧ (after, until]`. The cuts are already in the full, scoped and ids
  shapes of both compilers (`arm-plan.ts` `cutWhere` 643-671,
  `compile-union-window.ts` 527-573). On the existing bounded branch:
  - the page never hides a row below `cap`;
  - overflow stays sticky for free, because `windowIdsOf` backfills after an exit;
  - the overflow signal is in-band (`rows.length === cap`), so the protocol does
    not change.
- **Union collections:** `capOf` replaces the per-arm limit, the outer `fullRows`
  limit and the `windowIdsOf` limit (`compile-union-window.ts` 584-597, 629,
  673-680).
- **Golden fixtures:** every existing case of `compile-sql-golden.json` and
  `compile-union-golden.json` stays byte-identical. New `range` cases are added.

### 3.3 Client page plan (`live/shared/page-plan.ts`, replaces `scroll-plan.ts`)

Pure data, shared by the hook and the DB oracle:
```ts
type Page =
  | { kind: "closed"; after: Cut | null; until: Cut }
  | { kind: "tail";   after: Cut | null; limit: number };       // exactly one, last
interface PagePlan { base: string; pages: Page[] }               // contiguous: pages[i].after === pages[i-1].until
```
- **`base`** is the collection key plus the **encoded** `where` and `order`, not
  the raw query, because `columns` resolves names.

| Function | Behaviour |
|---|---|
| `startPlan` | `[tail {limit:H}]`, which is today's default tuple. |
| `freezeTail(rows)` | Cut at the **last row with a non-null `$key`**. The rows after it go to the new tail. `truncated: "long-sort-key"` only when no row has a key. |
| `splitOverflow(i, rows)` | Cut at the non-null key nearest the median. With no candidate, mark the page `truncated: "long-sort-key"`. While a split is pending, the page is `splitting`: `assemble` renders a loading placeholder after its `cap` rows, so the hidden rows never read as a seamless join. |
| `mergeSmall` | Merge two adjacent **closed** pages whose combined rows are ≤ H by dropping the cut between them. An empty page always merges into its smaller neighbour. Because no two adjacent closed pages total ≤ H, the visible page count is ≤ 2·⌈viewportRows / H⌉ + 2, a real bound. |
| `liveSet(visible)` | Subscribe visible ±1 and release beyond ±2. The tail is live while the footer sentinel is within the band. A stale tail never drives `loadMore`: `loadMore` re-subscribes it first, and `canGrow` / `exhausted` come only from a live tail. |
| `assemble` | Concatenates pages in order. Dedup: a live copy beats a stale one; between two live copies, the page whose frame was **applied most recently** wins (a per-tuple apply counter, §3.4). A sort-key update can move a row backwards, so "later page wins" would be wrong. Returns `rows`, `rowPage`, `canGrow`, `exhausted`, `truncated?`, `pageErrors`. |

**Hand-off.** Every new tuple starts from the rows of the tuple(s) it replaces,
shown as stale until its sub-ack arrives:
- freeze: the closed page gets the old tail's rows;
- split: each half gets its positional slice;
- merge: the union of both pages.

So the head never flashes to `loading`, and the result never drops back from
`ready`.

**Errors.**
- A failing tail sets `blocksPaging`.
- A failing closed page is a `pageErrors` notice with `retry`, keeping its stale
  rows.
- This carries the `ResourceError` typing from `a8af6ea67a` over unchanged.

**Removed:**
- grow-by-limit, the `2·step` split and the merge hysteresis;
- `MAX_SCROLL_SEGMENTS`;
- `"segment-cap"`;
- the `maxLimit ≥ 3·H` rule, which becomes **`maxLimit ≥ 2·H`** so a frozen page
  has headroom before it overflows.

### 3.4 Hook and live-state support

- **The hook: `useLiveCollectionPages(c, query, { viewport, resetKey? })`.**
  - It replaces `useLiveScroll` (deleted) and keeps its result shape, with
    `segmentErrors` renamed to `pageErrors` and `truncated` narrowed to
    `"long-sort-key"`.
  - `viewport: VisibleRange` is **required and branded**. Only data-view's
    viewport hook mints one, so a reader with no viewport source cannot read
    pages at all. That makes "set readers never page" a type error (rung 2), not
    documentation.
- **live-state changes (`primitives/live-state`, not framework):**
  - `useResources(params[], { release: "now" })` → `unobserve` skips the 30 s
    `SUB_KEEPALIVE_MS`, so released pages leave at once. The hysteresis band
    above absorbs back-and-forth scrolling.
  - Each entry carries a monotonic `appliedSeq`, bumped per applied frame, for
    the dedup rule.
  - Both land in P2 with their first consumer (R13 forbids a test-only export).
- **Stale rows live in plan state**, not the React Query cache: `useResources`
  only reads observed tuples, and its `gcTime` is 5 min.

### 3.5 Viewport signal (`primitives/data-view`, `primitives/virtual-rows`)

- **Range type:** `VisibleRange = { firstKey; lastKey } | "none"`. It is keyed by
  row id, because view indices are not reader indices once fold, grouping, merged
  sources or the queue's mixing apply.
- **Virtualized views:** `virtual-rows.tsx` gains `onRangeChange` via
  `useVirtualizer({ onChange })`, mapped to keys with `getKey`.
- **Non-virtualized views:** `useVisibleRowKeys(containerRef)` uses one
  IntersectionObserver over `[data-row-key]`. It is push-based, with no polling.
  After P3, a released page is one placeholder element, so the observed set stays
  bounded.
- **Plumbing:**
  - `data-view-body.tsx` merges per-section ranges for each reader.
  - Folded or collapsed sections report `"none"`, so their pages release.
  - A 250 ms scroll-idle settle prevents a fling from subscribing every page it
    crosses.
  - `scroll-paging.ts` → `pagesPaging`. The footer sentinel and `loadMore` are
    unchanged.
- **One budget per DataView, not per section:** an off-screen section's pages are
  outside the viewport and release like any other page.

### 3.6 Readers

| Reader | Change |
|---|---|
| `liveDataSource` (`data-view/web/internal/live-source.tsx` ~390, `live-sections.tsx` ~223) | `useLiveScroll` → `useLiveCollectionPages` + the viewport |
| Queue Done section (`use-queue-rows.ts` ~101) | the same, taking the range of the DataView it renders into |
| Plain `useLive` window readers (trash, debug queue, claude-cli calls, bookmarks, automation history, `:groups`) | **unchanged.** `useLive` stays one bounded window that grows to `maxLimit`. |
| Set readers (task-track auto-grow, starred, agent-origin, automations origin, event sources) | **unchanged, and they cannot widen:** they stay on `useLive`, whose `canGrow` keeps `limit < maxLimit`, and they cannot get a `VisibleRange`. The task-track loop keeps its 2000 ceiling. |

## 4. Phases

Each phase builds, passes `./equin check`, and leaves the app working.
**Only P4 touches `plugins/framework/`, and it needs your approval before it
starts.**

**P1: Closed-page params and compile.** Additive, and nothing calls it yet.
- `LiveWindowBound` and the decode union.
- The legacy `{until, limit}` is still accepted.
- `capOf` through `limitOf`, in both the single-table and union compilers.
- New golden cases.
- **Verify:**
  - Codec tests: closed round-trip; `until` without `limit`; a closed page on a
    non-scroll collection is refused.
  - The existing golden diff is empty.
  - A new `serve-collection-range-oracle.test.ts` checks, under random inserts,
    updates, deletes and order moves, that rows = `where ∧ (after, until]` in
    order, truncated to `cap`, with sticky overflow, including a backward
    sort-key move.
  - The same checks in `serve-union-oracle.test.ts`.

**P2: Page plan, viewport and reader swap.**
- `page-plan.ts` and `use-live-collection-pages.ts`.
- The live-state `release: "now"` and `appliedSeq`.
- The viewport signal (virtual-rows and data-view).
- `pagesPaging`.
- The three reader swaps.
- Delete `scroll-plan.ts`, `useLiveScroll`, `LiveSegmentError`, `"segment-cap"`
  and the legacy `{until, limit}` form. Change the `3·H` rule to `2·H`.
- **Interim client bound:** stale pages keep their rows, with no depth cap. This
  is the same as the old `useServerDataSource`, and P3 bounds it. P2 and P3 may
  land in one push.
- **Projection:** a `columns` change still restarts the plan, as today, until P3.
- **Verify:**
  - Pure `page-plan.test.ts`:
    - freeze, including at a null last key;
    - split, including when no key is cuttable;
    - merge bound;
    - live-set hysteresis;
    - dedup by `appliedSeq` with backward moves;
    - contiguity;
    - stale-tail `canGrow`.
  - `serve-collection-scroll-oracle.test.ts` rewritten as a page oracle:
    - random writes, `loadMore` and viewport moves;
    - the assembled live prefix is gap-free;
    - head-burst inserts split correctly.
  - `use-live-collection-pages.test.tsx`, the data-view tests (`live-source`,
    `merged-live-source`, `section-body`, `use-data-view-sections`,
    `body-types`, `facet-options`, `field-extension-check`, `live-fields`) and
    `runs-data-view.test.tsx`.
- **Docs:**
  - The live `CLAUDE.md` scroll section becomes "Paged collections".
  - The data-view `CLAUDE.md` (Paging, Live sources).
  - The queue, runs, mail, deploy-history, event-list, source-detail and
    all-conversations `CLAUDE.md` files.
  - The comments in `tasks-core/core/resources.ts`, `reports/core/resources.ts`,
    `event-list/.../collection.ts`, `sonata/library/core/resources.ts` and
    `live-data-source.ts`.
  - The message in `live/lint/no-legacy-resource-spelling.ts`.
  - Mark `research/2026-09-29-global-scoped-change-routing.md` (P2 scroll
    section), `…-p5-p8-v2.md` and the two 2026-10-08 data-view docs as
    superseded.

**P3: Stale budget, placeholders, and the projection change.**
- Past a stale-row budget, released pages drop to `{ size }` placeholders. These
  render as fixed-height skeleton blocks, one element per page, through
  `primitives/loading`, and re-subscribe when visible.
- Client memory and DOM become O(viewport + budget).
- A `columns` change keeps the plan and its cuts: live pages re-read, and
  released pages become placeholders. A row missing the new columns is never
  rendered as a value.
- **Verify:** jsdom tests for placeholder height and scroll anchoring; a deep
  scroll keeps the DOM node count bounded.

**P4: Range drain without the ids query (framework, approval required).**
- The window membership gains `boundOf(params) → "count" | "range"`.
- `drainMembershipScoped` sends a `range` tuple down the alias semantics: ordered
  ids only on entry or an order move, none on exit or in-place change, no
  backfill, still `bounded: true`.
- **Sticky rule:** `prev.size === cap` → `drainMembershipFull`.
- This is a cost optimisation only; P1 is already correct.
- **Verify:** the range oracle shows equal results on both paths, zero
  ordered-ids queries on exit or in-place change, and sticky overflow; plus
  `resource-runtime` tests.

**P5: Paging for every windowed collection.**
- Every window collection becomes pageable when `maxLimit ≥ 2·H`. `$key` is
  projected always, and the `scroll` flag is removed.
- A collection with `maxLimit < 2·H` is typed non-pageable (rung 2).
- **Gate:** measure the boot snapshot growth of preloaded windows
  (notifications `{limit:200}` and others) with `benchmark_boot` before and
  after, and report it before landing.

## 5. Follow-up tasks (filed with `add_task` when this lands)

1. **Set readers → `all` collections or contributed columns:** task-track,
   starred, agent-origin, automations origin, event sources.
2. **Atomic cross-page delivery.** One commit's deltas reach a socket as one
   frame and render once. This needs a loader executor seam for a shared
   `REPEATABLE READ` snapshot (framework). File it only if the `appliedSeq`
   dedup leaves visible gaps.
3. **Hand-rolled list readers to DataView, then to pages:** notifications panel,
   pages trash, mail thread messages (which render in reverse, so they need
   scroll anchoring).
4. **Offset jump.** Dragging the scrollbar to an arbitrary depth needs an
   offset-seek tuple that mints a cut.
5. **Covering-tuple seeding.** A frozen page seeded server-side from the tail's
   snapshot, so freezing costs nothing.
6. **Projection as a param.** Read stale pages with a narrower `columns`.

## 6. Risks

- **Busy head.** A busy `desc` feed's closed head splits about every M/2 inserts.
  Between overflow and split, every change pays a capped full read. Watched in
  the oracle and in the `live-pages` logs.
- **Stale pages** do not see changes until scrolled back. A deleted row stays
  visible off-screen, and an entrant into a released page is invisible until
  then. This is accepted by design.
- **Derived readers** that read every loaded row (the queue's `classifyQueue`,
  `exhausted`) see stale and placeholder pages. Counts come from `count: true`,
  and the queue's Done section is small (H = 30).
- **Cross-page moves** can show a one-frame duplicate or gap until follow-up 2.
- **An entering row** still costs the O(cap) `windowIdsOf` on the page it enters.
  Postgres order cannot be reproduced in JS.

## 7. Critical files

- **Codec:** `plugins/network/plugins/live/core/internal/{query.ts,query-codec.ts,live-collection.ts}`
- **Compile:** `plugins/infra/plugins/query-resource/server/internal/{compile-window.ts,arm-plan.ts,compile-union-window.ts}`; `plugins/network/plugins/live/server/internal/{serve-collection.ts,serve-union.ts}`
- **Plan and hook:** `plugins/network/plugins/live/shared/page-plan.ts` (new), `web/internal/use-live-collection-pages.ts` (new); delete `shared/scroll-plan.ts` and `web/internal/use-live-scroll.ts`
- **live-state:** `plugins/primitives/plugins/live-state/web/{notifications-client.ts,use-resource.ts}`
- **DataView:** `plugins/primitives/plugins/data-view/{core/internal/types.ts,web/internal/{live-source.tsx,live-sections.tsx,scroll-paging.ts,data-view-body.tsx}}`; `plugins/primitives/plugins/virtual-rows/web/internal/virtual-rows.tsx`
- **Queue:** `plugins/conversations/plugins/conversations-view/plugins/data-view/plugins/queue/web/components/use-queue-rows.ts`
- **Runtime (P4 only):** `plugins/framework/plugins/resource-runtime/core/runtime.ts` (`drainMembershipScoped` ~4449/4511)

## 8. End-to-end verification

1. **Tests:**
   ```
   ./equin test plugins/network/plugins/live
   ./equin test plugins/infra/plugins/query-resource
   ./equin test plugins/primitives/plugins/live-state
   ./equin test plugins/primitives/plugins/data-view
   ./equin test plugins/primitives/plugins/virtual-rows
   ./equin test plugins/runs
   ./equin test plugins/framework/plugins/resource-runtime   # P4
   ```
   These include the DB oracles: range, union and the page oracle.
2. **Byte-identity:** the existing golden fixtures are unchanged. The default
   tuples and boot payloads of non-pageable collections are unchanged through
   P1–P4, which `benchmark_boot` compares.
3. **Build:** `./equin build` (in the background, then await) and
   `./equin check`.
4. **Screenshots**
   (`plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts`):
   all-conversations, runs, mail threads and the events list, scrolled 30+ pages
   deep.
   - Rows are continuous.
   - There is no segment-cap notice.
   - Rows past the old 16·M depth are reachable.
5. **Liveness:** `~/.singularity/worktrees/<wt>/logs/live-pages.jsonl` shows, per
   plan change:
   - live tuples per reader ≤ visible pages + 4 + tail while scrolled deep;
   - pages beyond 16;
   - overflow splits during a burst-insert script.
6. **Server cost:** the `windowIdsOf` profiler span (`wrapMembership`) shows only
   O(cap) reads on closed pages, and after P4 none on exits.
