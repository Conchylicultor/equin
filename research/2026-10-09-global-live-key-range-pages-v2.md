# Live collections as key-range pages, v2: one page kind, one operation

Supersedes `2026-10-09-global-live-key-range-pages.md`. v1 split pages into
"closed" and "tail" kinds. That distinction was false, and v2 unifies them.
Framework changes are in scope: this is load-bearing work.

Task `task-1790685688903-owz1mf` (Resources › item 7, API half). Status: **plan,
awaiting approval**.

## 1. Context

See v1 §1 for the full background. In short:
- The seven tick lists are already `scroll: true` collections read through the
  **segmented scroll** (`shared/scroll-plan.ts`).
- Every structural change (grow, split, merge) mints a tuple that is loaded in
  full.
- Every loaded segment stays live, so depth is capped at 16 segments
  (about 16 · `maxLimit`).
- Plain `useLive` stops at `maxLimit`.

The goal, agreed with the user: infinite scroll for every collection, with no
depth limit, bounded by construction.

## 2. Why v1's two kinds collapse into one

- v1 gave a closed page no `limit`, so that it "never hides rows".
- Bounded-by-construction still needs a server read cap. So v1's closed page was
  read with `LIMIT maxLimit+1` and treated a cap-sized read as overflow. That is
  a count limit under another name.
- So every page in v1 was already "a key range, read with a limit". "Closed" and
  "tail" only differ in their values (`until` set or not, which limit).

## 3. The unified model

**A page is a key range read with a limit:**
```ts
Page = { after: Cut | null; until: Cut | null; limit: number }
```
- `after` is exclusive and `until` inclusive.
- Cuts are server-minted `$key`s, and `null` is the order's start or end.
- This is today's `Segment` and today's wire params (`{limit, after?, until?}`),
  so **there is no codec or wire change** and the default `{limit:"H"}` is
  untouched.

**A page is *full* when `rows.length === limit`.** A full page may be hiding rows
past its last one.

**One structural operation: split a full page at a key.**

| Situation | What the split does | Read cost |
|---|---|---|
| **`loadMore`** = split the full **last** page at its last row | `(a, k] @ 2H` (its H rows, with headroom) + `(k, ∞) @ H` | the new page: O(H) |
| **Overflow** = a full page that is not last, split at its median non-null key | `(a, m] @ 2H` + `(m, b] @ 2H` | O(H) for the half past the old cap; the other half is known |

- After a split, every page except the last holds ≤ `limit` rows, with headroom.
  Inserts fill the headroom until the page is full again, which triggers another
  split.
- `maxLimit` is no longer a depth bound. It only bounds one page's `limit`.
- **Hidden rows are always marked.** A full page that is not last renders a
  loading placeholder after its rows until its split settles.

**Merge (the only other step).** Two adjacent pages holding ≤ H rows together
merge into one, by dropping the cut between them. An empty page always merges.
This bounds how many pages a viewport can span.

**Liveness follows the viewport:**
- A page is subscribed while it is visible or ±1 page away, and released beyond
  ±2.
- The last page is live while the footer is within that band.
- Released pages keep their rows as stale, up to a budget, and become
  height-keeping placeholders past it.

| | Per page (server) | Per reader |
|---|---|---|
| Live cost | ≤ `limit` ≤ `maxLimit` | ≤ (visible pages + 4) pages |
| Client memory | — | O(viewport + stale budget) |
| Depth | — | **unbounded**, no cap |

## 4. Design

### 4.1 Page plan (`live/shared/page-plan.ts`, replaces `scroll-plan.ts`)

Pure data, shared by the hook and the DB oracle.

**Operations:**
- `start`
- `split(i, rows, at)`, used by both `loadMore` and overflow
- `merge(i)`
- `liveSet(visible)`
- `assemble(results)`

**Invariants:**
- Pages are contiguous: `pages[i].after === pages[i-1].until`.
- Exactly one page has `until: null`, and it is the last.
- The rendered rows are a gap-free prefix, except for marked placeholders.

**Cuts:**
- A cut is always a non-null `$key`.
- With no cuttable key in a full page (every sort key is over 1 KiB), the page
  reports `truncated: "long-sort-key"`. This is the only truncation left.

**Hand-off:**
- Each new tuple starts with the rows of the tuple it replaces, sliced by
  position at the cut row, shown as stale until it settles.
- The list never flashes back to `loading`.

**Dedup:**
- A live copy beats a stale one.
- Between two live copies, the page whose frame was applied most recently wins,
  using live-state's per-tuple `appliedSeq`. A sort-key update can move a row
  backwards, so "the later page wins" would be wrong.

**Removed:**
- grow-by-limit;
- `MAX_SCROLL_SEGMENTS` and `"segment-cap"`;
- merge hysteresis;
- the `maxLimit ≥ 3·H` rule, which becomes `maxLimit ≥ 2·H` so a split page has
  headroom.

### 4.2 Hook: `useLiveCollectionPages(c, query, { viewport, resetKey? })`

- It replaces `useLiveScroll` and keeps its result shape: `segmentErrors` becomes
  `pageErrors`, and `truncated` is now only `"long-sort-key"`.
- `viewport: VisibleRange` is **required and branded**. Only data-view's viewport
  hook mints one, so a set reader cannot reach pages (a tsc error).
- Plain `useLive` stays one bounded window that grows to `maxLimit`, so set
  readers are unchanged and cannot widen. The task-track loop keeps its 2000
  ceiling.

### 4.3 Viewport signal (data-view, virtual-rows)

v1 §3.5 is unchanged:
- `VisibleRange = { firstKey; lastKey } | "none"`, keyed by row id.
- `virtual-rows` `onRangeChange`.
- For non-virtualized views, one `IntersectionObserver` over `[data-row-key]`.
- A 250 ms scroll-idle settle.
- One budget per DataView, so the pages of off-screen or collapsed sections
  release.

### 4.4 Seeded derivation (resource-runtime and live-state)

Every split and merge produces tuples whose rows are, wholly or partly, a
**positional slice of a tuple the client and server both hold**:

| Operation | Seeded part | Loaded part |
|---|---|---|
| `loadMore` | `(a, k]` = the whole old tail | `(k, ∞)` |
| Overflow | the half up to the old cap | the half beyond it |
| Merge | both sides | nothing |

So these tuples need not be re-read or re-sent.

**Frame protocol:**
- The `sub` frame gains `derive: { from: params, version, slice: { fromRow, toRow } }`.
  Rows are identified by the boundary `$key`s, which both sides hold.
- **Server**, only if the source tuple is quiescent at `version` and the slice is
  complete (it lies within the source's rows and the source was not full past
  it):
  - copy that slice of the source's snapshot and order signatures into the new
    pk;
  - register the new pk before the copy, so concurrent commits reach it as
    pendings;
  - answer `sub-ack { derived: true, version }` with no value.
- **Client:** it already holds those rows; it adopts its stale slice as the
  value.
- **Otherwise** the server falls back to today's full load. The client tolerates
  either answer.
- **Merge** derives from two sources (a two-entry `derive`).
- **Result:** `loadMore` reads and sends only the H new rows, splits only the
  unknown half, and merges nothing.

**live-state also gains:**
- `useResources(…, { release: "now" })`, which skips the 30 s keep-alive for
  released pages;
- `appliedSeq`.

### 4.5 Exits from a non-full window need no ids query (resource-runtime, general)

- A bounded window that is **not full** (`prev.size < limit`) holds its whole
  range. An exit therefore cannot pull in a hidden row, and its order comes from
  the previous snapshot. This mirrors the alias branch (`runtime.ts` ~4511).
- Today every entry or exit runs `windowIdsOf` (~4449).
- With the change:
  - An exit or in-place change on a non-full window: zero queries.
  - An entrant or order move: still one `windowIdsOf`, O(limit) and bounded.
  - A full window keeps today's path, which backfills.
- **This helps every windowed collection, not only pages.** Split headroom keeps
  pages non-full most of the time.

### 4.6 Readers

| Reader | Change |
|---|---|
| `liveDataSource` (`live-source.tsx` ~390, `live-sections.tsx` ~223) | `useLiveScroll` → `useLiveCollectionPages` with the viewport |
| Queue Done (`use-queue-rows.ts` ~101) | the same, with its DataView's range |
| Plain `useLive` readers and set readers | unchanged (see v1 §3.6) |

## 5. Phases

Each phase builds, passes checks, and leaves the app working.

**P1: Page plan, viewport, reader swap.** Client only: no wire, codec or server
change.
- `page-plan.ts` and `use-live-collection-pages.ts`.
- live-state `release: "now"` and `appliedSeq`.
- The viewport signal (a measurement keyed by the rows it saw, with a max
  wait), and `useLivePagesPaging` minting the viewport and the paging
  together; `mintVisibleRange` is data-view's alone (`live/visible-range-minter`).
- A page released with `release: "now"` drops its cached value, so a page
  re-subscribed is pending until the server vouches for it again.
- The three reader swaps.
- Delete `scroll-plan.ts`, `useLiveScroll`, `LiveSegmentError`, `"segment-cap"`
  and the `3·H` rule.
- **Interim:** stale rows are kept without a budget, and splits re-read in full.
- **Verify:**
  - Pure `page-plan.test.ts`:
    - `loadMore` as split;
    - overflow split;
    - no cuttable key;
    - merge bound;
    - live-set hysteresis;
    - dedup on a backward move;
    - contiguity;
    - stale-last-page `canGrow`.
  - `serve-collection-scroll-oracle.test.ts` rewritten as a page oracle:
    - random writes, `loadMore` and viewport moves;
    - a gap-free prefix;
    - a head-burst split.
  - The data-view, queue and runs tests (list in v1 §4 P2).
- **Docs:** the doc and comment list in v1 §4 P2.

**P2: Stale budget, placeholders, projection change.**
- Placeholders past the budget, one element per page.
- The hidden-rows marker (§3, moved from P1): a full page that is not last
  renders a placeholder after its rows until its split settles. In P1 the
  split is minted in the same reconcile that observes the page full, so the
  unmarked window is one round trip for the half past the old cap.
- A `columns` change keeps the cuts: live pages re-read and released pages
  become placeholders. *(Superseded: `columns` is not a wire param, so a
  change keeps the plan and re-reads nothing — see* As landed *below and
  `live/web/internal/use-pages.ts`'s `sameColumns` branch.)*
- **Verify:** jsdom height and anchoring tests; the DOM node count stays bounded
  on a deep scroll.
- **As landed.**
  - Budget: `PageLimits.staleRows` = `8 · default.limit`, walked out from the
    visible pages one page each side at a time; a placeholder ends its side.
  - Placeholders are drawn only before or after the rows (the rows' pages are
    one contiguous core; a page holding rows past a placeholder is drawn as
    one), so no view needs a non-row entry kind. Viewports name them by
    `placeholderKey`.
  - Height: EXACTLY the room the page's rows took when released — so a
    release changes no layout and needs no anchoring. Each settled viewport
    records every drawn row's advance (its top to the next entry's top); a
    placeholder is sized once, in the render it appears in, from the
    previous layout's entries between its surviving neighbours
    (`data-view/web/internal/placeholder-heights.ts`). The mean advance is
    the fallback for rows never measured. (First landed as rows × a measured
    pitch; see the deep-scroll fix below.)
  - `auto-scroll` gains `KeepAnchorAcross` for the residue (rows landing
    back that changed, `isPaged` reads with nothing standing in); its box
    opts out of browser scroll anchoring. `virtual-rows` re-measures
    `scrollMargin` when its items change.
  - Deep-scroll fix (e2e `data-view/e2e/live-pages-scroll.ts` on
    /agents/all-conversations, 5033 rows; before: 2958–4270 rows seen,
    page-aligned chunks skipped). Root cause, from a trace of every scroll
    write: Chromium's own scroll anchoring moved `scrollTop` by a released
    page's height (+3100 px, no script write) in the release commit — it
    anchored on a box of the virtualized table the window was recycling
    (its spacer), on top of `KeepAnchorAcross`. Fixed by (1) the exact
    placeholder height above, (2) `KeepAnchorAcross` owning its box with
    `overflow-anchor: none` (one anchoring per region), (3) `virtual-rows`
    holding scroll adjustments while its margin is stale — the release
    commit draws the window against the old margin, and the virtualizer
    "compensated" rows first measured there from its cached, pre-scroll
    offset (−700 px, the whole step undone), and (4) `virtual-rows`
    estimating unmeasured rows at the first measured row's size (a probe
    of a real row before the first window, then the first measurement) —
    the table's fixed 36 px guess for 31 px rows made every row first drawn
    above the reader jolt the list 5 px (tens of px per step; pre-existing,
    not caused by the pages work). The measured pitch was right for this
    table (31 px); the "35.3 px/row" average was the 36 px estimate of
    unmeasured rows. After: 5033/5033 rows seen and no row on screen
    moving on its own, at `--step 0.4` and `0.8`.
  - Under `isPaged` (the Queue's Done section) no placeholder is drawn.
  - `columns` was never a wire param (every row carries the whole
    projection), so a change of it keeps the plan and re-reads nothing; the
    "re-read live / placeholder released" half waits for a projection param.
  - Not done: the hidden-rows marker. It would sit between two rows (after
    the half of a split past the old cap), which the edge-only placeholders
    cannot express without flashing the rows after it; it stays the one
    round trip described above.

**P3: Seeded derivation (§4.4).**
- resource-runtime: the `derive` sub path, the quiescence and completeness check,
  and the snapshot slice copy.
- live-state: the `derive` field on `sendSub` and adopting the stale slice.
- **Verify:**
  - Runtime harness tests:
    - a derived sub-ack carries no value;
    - a non-quiescent or incomplete source falls back to a full load;
    - a commit racing the derivation reaches the new pk;
    - the `makeClientView` convergence property under random interleavings.
  - The page oracle shows `loadMore` loading exactly H rows and merges loading
    none.
- **As landed.**
  - Slice bounds are row IDS, not `$key`s: the runtime keys rows by `keyOf`
    and its snapshots hold hashes, so it cannot read a row's `$key`. A slice
    is `{ after: id | null, until: id | null }` (exclusive / inclusive, `null`
    = the source's first row / the end of its range), mirroring the cuts.
  - The window membership gains `limitOf` and `familyOf` (query-resource
    states both for a scroll window, the union too; the family is the codec's
    `where` + `order`); a resource without them never derives, and a source of
    another family is refused (`foreign-source`) — the copied rows and order
    signatures hold only within one query. A slice through a source's end
    needs the source not full; the slices may not share a row nor exceed the
    new window (`over-limit`) — no truncation on either side; at most two
    sources (a split one, a merge two), more is `malformed`.
  - The derived ack ECHOES the id the client minted for the derivation
    (`derive: { id, from }` → `derived: { id }`), and a tab adopts only an
    echo of its own in-flight one: the shared socket broadcasts every frame,
    and another tab may hold the same tuple. Matching on a client-chosen id
    rather than the sources re-serialized means a server-side canonicalization
    can never strand the asking tab. A replay, a forced resub and a sub-error
    each drop the derivation in flight.
  - Version skew: a bundle predating derived acks would misread one (no value)
    and wedge its read, so live-state's socket names a dialect — its own
    content-addressed module URL — and shares the SharedWorker socket only
    with tabs running the same client (networking's `dialect` option).
  - live-state cuts the slice itself, at send time, from a source whose
    `appliedSeq` is still the one the plan decided on and whose value the
    socket built (`socketValue`; an HTTP body is read apart from the server's
    snapshot) — so the version sent and the rows adopted are one value.
  - Derivation only on the span-opening sub (`firstGlobal`); refusals are
    counted by reason in `_debug` (`deriveFallbacks`), derivations in
    `derivedSubs`. A derived tuple is exactly as current as its sources'
    subscribers (the same base their next delta diffs against) — the
    runtime's existing same-version re-seed race is inherited, not widened.

**P4: Exits from a non-full window without the ids query (§4.5).**
- **Verify:**
  - `runtime-window-membership.test.ts`: zero `windowIdsOf` calls on an exit or
    in-place change while not full; today's path when full.
  - The existing oracles stay green.
- **As landed.**
  - `membership.limitOf` is now REQUIRED on the window arm (it was optional
    since P3): a bounded window has a LIMIT by definition, so "absent ⇒
    today's path" was a spelling with no meaning. Both query-resource
    compilers already stated it. The internal record splits the bounded
    window (`bounded: true`, `limitOf`) from the alias (`bounded: false`, no
    limit); derivation's `not-derivable` now means "no `familyOf`" (or
    `revalidate`) only. The routed test fixture defaults it to `Infinity`,
    the size of its default (unlimited) `windowIdsOf`.
  - The drain: `full = prev.size >= limitOf(params)`; `windowIdsOf` runs on
    `entered || orderMoved || (exited && full)`. A non-full exit leaves
    `orderedIds` unset, so the diff derives the order from the prior snapshot
    minus the leavers (the alias's exit path). A where-flip exit still costs
    its scoped refill (the read that finds the row gone); a pure DELETE costs
    nothing.
  - Tests: `runtime-window-membership.test.ts` §"exits from a non-full
    window" — DELETE and where-flip exits with zero `windowIdsOf`, in-place
    stays query-free, an entrant still re-derives, exit + entrant in one
    flush re-derives once, a full ⇄ not-full walk, and a seeded random-write
    property (convergence + no query on any exit-only flush of a non-full
    window).

**P5: Paging for every windowed collection.**
- Pageable iff `maxLimit ≥ 2·H` (otherwise typed non-pageable). `$key` always
  projected; the `scroll` flag removed.
- **Gate:** measure the boot payload delta with `benchmark_boot` and report it
  before landing.

**P6 (measured, optional): Atomic per-commit delivery.**
- One commit's deltas for a reader's pages go in one frame and are applied in one
  React batch. That needs a loader executor seam, so the page refills share one
  `REPEATABLE READ` snapshot.
- Land it only if the P1 logs show cross-page duplicates or gaps that users see.

## 6. Follow-up tasks (filed with `add_task` when this lands)

- Set readers → `all` collections or contributed columns.
- Hand-rolled lists (notifications, trash, mail messages) → DataView, then pages.
- Offset jump (dragging the scrollbar far).
- A projection param — and with it the deferred half of P2's `columns`
  change: live pages re-read, released pages become placeholders. *(Dropped —
  research/2026-10-12-global-live-paging-followups.md: only `reports` rows are
  wide, and slimming its list row is cheaper than a new tuple dimension.)*
- The hidden-rows marker (P2, not landed — see *As landed*): an inline
  placeholder after the rows of a full page that is not last, until its split
  settles. Needs an inline (non-edge) entry kind every view can draw. *(Dropped,
  instrumented — the follow-ups doc: the `live-pages` log times each
  overflow split's gap; reopen if it is common or over about 150 ms.)*
- live-state: the tab's `NotificationsClient` is bound to the FIRST
  `QueryClient` a `NotificationsProvider` mounts with; a later provider with
  another client silently shares the first one's cache (a test making a client
  per test loses `release: "now"` drops — two P1 assertions passed wrongly).
  Make the wrong spelling impossible: drop the provider's `queryClient` prop
  for a `web/testing` harness owning one client, or assert on a different one.
  *(Done in the follow-ups' session 1: the provider takes no client, and
  `createLiveStateHarness()` gives each test its own pair.)*

## 7. Risks

- **Busy head.** The head of a busy `desc` feed splits about every H inserts. With
  P3 and P4, each split loads at most the unknown half.
- **Stale pages** do not see changes until they come back into view. This is
  accepted by design.
- **Cross-page moves** can show a one-frame gap: a row moving between two live
  pages is in neither while the frame of the page it left has landed and the
  other's has not. The duplicate (the entering frame first) is already fixed —
  the plan shows a row once, from the most recently applied page
  (`winningPages`, `live/shared/page-plan.ts`). The gap is measured, not fixed:
  the `live-pages` log records each one closed within 1 s, and the fix if it
  fires is a client-side departure hold in the plan, not P6's batched frame
  (research/2026-10-12-global-live-paging-followups.md).
- **An entrant** still costs one O(limit) `windowIdsOf`: Postgres collation cannot
  be reproduced in JS.

## 8. Critical files

- `plugins/network/plugins/live/{shared/page-plan.ts (new), web/internal/use-live-collection-pages.ts (new), core/internal/live-collection.ts}`
- delete `plugins/network/plugins/live/{shared/scroll-plan.ts, web/internal/use-live-scroll.ts}`
- `plugins/primitives/plugins/live-state/web/{notifications-client.ts,use-resource.ts}`
- `plugins/framework/plugins/resource-runtime/core/{runtime.ts,keyed-diff.ts}` (P3, P4)
- `plugins/primitives/plugins/data-view/{core/internal/types.ts, web/internal/{live-source.tsx,live-sections.tsx,scroll-paging.ts,data-view-body.tsx}}`
- `plugins/primitives/plugins/virtual-rows/web/internal/virtual-rows.tsx`
- `.../conversations-view/plugins/data-view/plugins/queue/web/components/use-queue-rows.ts`

## 9. Verification

1. **Tests:** `./singularity test` over `plugins/network/plugins/live`,
   `plugins/infra/plugins/query-resource`, `plugins/primitives/plugins/live-state`,
   `plugins/primitives/plugins/data-view`, `plugins/primitives/plugins/virtual-rows`,
   `plugins/framework/plugins/resource-runtime` and `plugins/runs`.
2. **Byte-identity:** the golden fixtures are untouched (no SQL change before P5),
   and the boot payloads are unchanged through P4.
3. **Build and check:** `./singularity build` and `./singularity check`.
4. **Screenshots:** all-conversations, runs, mail and events, 30+ pages deep.
   - Rows are continuous.
   - There is no segment cap.
5. **Logs:** `live-pages.jsonl` shows live tuples per reader ≤ visible + 4, and
   page counts beyond 16. After P3, the `wrapLoad` spans show `loadMore` loading H
   rows.
