# Live collections, proof 2: the notifications bell — server filters, groupBy, boot preload

## Context

The bell's type filter (`shell/notifications/web/components/bell-button.tsx`)
filters the boot-loaded window of the newest 200 undismissed notifications on
the client. That breaks in two ways:

1. **The list.** Picking a type shows only that type's rows among the newest 200,
   never older ones.
2. **The chips.** The chips are built from the types seen in those 200 rows, so a
   type that appears only in older rows has no chip at all.

This is step 5 of the Resources page (`block-f64cfc08-…`) and §1 of "Phases after
the proof" in `research/2026-09-25-global-unified-live-resource-api.md`. It is the
first real screen that filters on the server, and the first boot-preloaded
collection on the new API.

It also closes the gaps left by the `events.sources` proof, and adds one
capability the target model (§9 of "Live resources — audit and target model")
does not have yet: **grouping**, the values a filterable column takes across the
whole collection, as a `groupBy` query shape of `useLive`. It fixes problem 2 generically: any filter UI that today builds
its choices from the rows it has loaded can use them.

Decisions (user, 2026-09-25):
- The filtered list is a dynamic server window. It loads when a chip is picked and
  grows by infinite scroll.
- Grouping is part of this proof, as a generic query shape of `useLive` (no new
  hook), not a resource written only for the bell.
- The fix for `source-origin.ts` is the cleanest one: send the source with each event
  row (see §5).

## 1. `liveCollection`: `preload` and grouping (`network/live/core`)

### `preload?: "none" | "boot"` (default `"none"`)

- `"boot"` sets `bootCritical: true` on the **window** descriptor only. The boot
  snapshot hydrates the default window's tuple (`defaultParams`, which stays
  `{ limit: "200" }` for the bell, byte-identical to today), and the owning plugin
  is pinned to the eager tier.
- The `:rows` and `:groups` siblings are never preloaded: the server can't know a
  tab's ids or group queries at boot.
- `"boot-and-keep"` (resident) arrives with values (phase 2). The bell is always
  mounted, so it does not need it.
- Nothing is persisted to L2: bounded resources already skip persistence
  (page §6).

### Grouping: a query shape, not a new hook — internal `${key}:groups`

No new read API. `useLive` already picks the internal resource from the query's
shape (`{ ids }` → `:rows`); a grouping is one more shape:

```ts
useLive(notifications, { groupBy: "type" })                               // every type
useLive(notifications, { groupBy: "variant", where: { type: "build" } })
// → LiveListResult<{ value: V | null; count: number }>  — the same result as a window
```

- **Why not a separate hook** (user, 2026-09-25): the API is kept minimal on purpose
  to avoid re-creating the 12-spelling duplication. A separate hook is justified only
  when the result has different *states* (`useLiveRow`'s found / doesn't exist), not
  just different data. Groups are a window over the grouped relation, so they reuse
  `LiveListResult` exactly: `canGrow` / `growing` / `loadMore()` page through groups,
  and there is no bespoke `truncated` flag.
- **`groupBy`** is typed `keyof F`, so any declared `filterable` column can be grouped
  on. The filterable whitelist stays the only whitelist.
- **Groups are ordered** by count descending, then value (code-point order). The
  default limit is 50 and the max is `LIVE_LIST_MAX`. A NULL value is its own group
  (`value: null`), and selecting it is `{ isNull: true }`.
- **Wire params** (internal, canonical, strict decode): `groupBy`, `where` (the same
  codec, present only when non-empty) and `limit`. The query codec gains the
  group-shape encode/decode and reuses the `where` canonicalisation. `orderBy` on a
  group query is rejected by the type (the order is fixed).
- **`where` is applied as given.** To keep the other chips visible when one is picked,
  a caller leaves the grouped column out of `where`.
- **Kind.** A plain (non-keyed) push value with params. It is re-run whenever its
  read-set table changes. The read-set is captured automatically, so no scope policy
  and no runtime change are needed.
- **Cost.** One `GROUP BY … LIMIT n+1` per subscribed group tuple per change to the
  table. Group queries are mounted only while a filter UI is open (see §3), so the
  resting cost is zero.

## 2. `serveCollection` (`network/live/server`)

- **Mints the groups resource.** `serveCollection` compiles `:groups` with
  `defineResource(desc, { mode: "push", loader })`. The loader is
  `SELECT col, count(*) FROM from WHERE <base> AND <where> GROUP BY col ORDER BY count DESC, col LIMIT n+1`.
  `declare` returns three `Resource.Declare` entries, and the served object also
  exposes `keys` (all three minted keys).
- **New `where?: SQL`, the collection's base membership.** The collection *is* the
  rows of `from` that match it. It is ANDed into the window, the `:rows` sibling
  and the groups.
  - For the bell it is `dismissed = false`, a mutable column. The window already
    handles a where-flip as a membership exit.
  - For `:rows`, a new test must show that a flipped row leaves a point tuple.
    If the point path does not treat a failed refill as an exit, that is fixed in
    `query-resource`'s compiler, not worked around.
- **Projection derived from the row schema.** It selects exactly the row schema's
  keys, each bound by property name (or via `columns`). This makes it impossible to
  leak a server-only column, such as `dedupKey`, to the wire. Today a `PgTable`
  source projects every column.
  - `liveCollection`'s `row` narrows to a zod object, so its keys can be read.
  - A row key that binds to no column throws at module eval.
  - This also tightens `events.sources`.

## 3. The bell (`shell/notifications`)

- **Declare** (`shared/resources.ts`):
  `export const notifications = liveCollection("notifications", { row: NotificationSchema, id: "id", filterable: { type: z.string(), variant: NotificationVariantSchema }, sortable: ["createdAt"], default: { orderBy: [["createdAt", "desc"]], limit: 200 }, maxLimit: 500, preload: "boot" })`.
- **Serve:** `serveCollection(notifications, { from: _notifications, where: eq(_notifications.dismissed, false) })`.
  The hand-written `select` goes, because the projection is derived. Spread
  `.declare` into the contributions.
- **Read-set guard.** `reconcile-read-set.ts` currently asserts that `notifications`
  is the only reader of its table. It becomes
  `reconcileReadSetTable(db, "notifications", notificationsServed.keys)`, derived from
  the served collection, so adding a sibling can never evict it.
- **Web:**
  - `BellButton` (always mounted) reads `useLive(notifications)`, the preloaded
    default window. That drives the toasts, the unread badge and the trigger, as
    today.
  - The popover body becomes its own component, mounted only while the popover is
    open. It holds:
    - **Chips:** `useLive(notifications, { groupBy: "type" })`, plus an "Errors"
      chip when `useLive(notifications, { groupBy: "variant" })` has an `error`
      group. While the groups are pending the chip row shows a loading state, never
      an empty row. The chip strip grows with `loadMore()` while `canGrow` is true.
    - **List:** "All" reuses the default window (the same tuple, no extra
      subscription). A type chip reads `useLive(notifications, { where: { type } })`,
      and "Errors" reads `{ where: { variant: "error" } }`. While a filtered window
      is pending, the list area shows a loading state and the header and chips stay
      put.
    - **Infinite scroll:** a `ScrollSentinel` (`primitives/cursor-pagination`) at the
      end of the list calls `loadMore()` while `canGrow` is true. `growing` shows the
      footer spinner.
- **Unchanged (noted):** the unread badge counts unread errors and warnings in the
  newest 200. A "count of unread" is a value (phase 2), not part of this proof.
- The Unread / Earlier split and "Clear all" work unchanged on whichever window is
  shown.

## 4. Scanners (`tooling/resource-vocabulary`, eager tier, docs facet)

- The `liveCollection` vocabulary entry gains a third mint,
  `{ suffix: ":groups", keyed: false, membership: null }`.
- `MintedResource` gains `preloadable: boolean` (true on the window mint only).
- `DescriptorFactory` gains the preload flag it spells: `{ field: "bootCritical" }`
  for the old factories, `{ field: "preload", value: "boot" }` for
  `liveCollection`.
- `eager-tier-gen.ts` `bootCriticalKeysIn` and
  `plugin-meta/facets/plugins/resources/facet/parse-resources.ts` read the flag
  through that entry, and mark only the preloadable mints.
  - Today `bootCriticalKeysIn` would mark *every* mint boot-critical, `:rows`
    included. This fixes that before it can bite.
- `resource-vocabulary/check`: nothing new. `serveCollection` is already a register
  marker.
- Update the scanner test fixtures that inline the old `notificationsResource`
  (`eager-tier-gen.test.ts`, `parse-resources.test.ts`), and add a `liveCollection`
  preload fixture.

## 5. Gaps carried over from the `events.sources` proof

- **Browser test for a live `enabled` toggle.** Extend
  `apps/events/sources/e2e/live-sources.ts`:
  - with the list and the detail pane open, toggle a source's `enabled` through the
    UI;
  - assert that both update without a reload;
  - restore the value in a `finally`.
  The script becomes writing, so its header says so.
- **Slow-ops `loader` spans.** After the e2e runs, `get_runtime_profile` on this
  worktree must show `loader` entries for `events.sources`, `events.sources:rows`,
  `notifications`, `notifications:groups`, and a filtered `notifications` tuple.
  `get_timeline` must show no new flush stalls. Record the result in this doc.
- **`source-origin.ts`: send the source with the event row.**
  - `event-list/server/internal/handle-query.ts` (it already imports
    `_eventSources`) and the run-events endpoint behind `useRunEvents` join
    `event_sources`. Each row gains `source: { type, config }`, a `SourceRef` in
    `events-core/core`.
  - `useOpenEvent` / `useEventUrl` resolve through `useEventSourceOrigin()(row.source)`.
  - `useSourceOriginUrl` (the id lookup against the newest-100 window) is deleted.
  - Result: no subscription, no window bound, and no "not loaded yet" collapsed into
    `null`. The one cost is staleness: a URL edited on a source shows on the list's
    next refresh.

## 6. Docs

- `network/live/CLAUDE.md`: `preload`, `groupBy`, base `where`, the derived
  projection.
- `research/2026-09-25-global-unified-live-resource-api.md`: mark phase 1 done and
  link here.
- Add a status line to the Resources page's agent card (via `edit_page` inside
  `block-f6465fff-…`). Record `groupBy` as a target-model addition in the sub-page
  (§9).

## Critical files

- `plugins/network/plugins/live/core/internal/{live-collection,query-codec,query}.ts`
- `plugins/network/plugins/live/server/internal/serve-collection.ts`
- `plugins/network/plugins/live/web/internal/use-live.ts` (the `groupBy` query shape)
- `plugins/shell/plugins/notifications/{shared/resources.ts, server/internal/resources.ts, server/internal/reconcile-read-set.ts, server/index.ts, web/components/bell-button.tsx}`
- `plugins/framework/plugins/tooling/plugins/resource-vocabulary/core/vocabulary.ts`,
  `…/codegen/core/eager-tier-gen.ts`, `plugins/plugin-meta/plugins/facets/plugins/resources/facet/parse-resources.ts`
- `plugins/apps/plugins/events/plugins/{events-core/web/internal/source-origin.ts, event-list/server/internal/handle-query.ts, event-list/web/internal/use-open-event.ts}`

## Verification

- **Tests:** `./equin test plugins/network/plugins/live plugins/infra/plugins/query-resource plugins/shell/plugins/notifications plugins/framework/plugins/tooling plugins/plugin-meta/plugins/facets/plugins/resources`
  - codec: group params canonicalise, strict decode throws on an undeclared column
    or a limit above max;
  - group loader against `createTestDb`: counts, ordering, the NULL bucket,
    paging through groups, base `where` applied;
  - compiled runtime: a `dismissed` flip leaves the window, the `:rows` tuple and the
    group counts; a type-filtered tuple gains only matching entrants;
  - the projection excludes a non-row column;
  - jsdom: `useLive({ groupBy })` pending → settled, grow keeps it settled, and the bell popover shows a chip
    loading state (never an empty chip row).
- `./equin check`, including `eager-tier-in-sync`, `plugins-doc-in-sync` (four
  keys listed for each collection) and `resource-vocabulary`.
- `./equin build`, then:
  - a new `shell/notifications/e2e/bell-filter.ts`:
    - seed 250 notifications through `POST /api/notifications`, with one old type
      that appears only outside the newest 200;
    - its chip exists, and picking it lists all of them;
    - scrolling grows the list;
    - dismissing one removes it live;
    - the boot snapshot contains `notifications` with `{limit:"200"}` and the bell
      paints without a pending state;
    - clean up through dismiss-all;
  - the extended `live-sources.ts`;
  - `open-event-verify.ts` still opens a source's page for an event with no URL.
- The slow-ops and timeline confirmation in §5.

## Result (2026-09-25)

Implemented as planned. The bell's code is in
`shell/notifications/{shared/resources.ts, server/internal/resources.ts, server/internal/reconcile-read-set.ts}`
and `web/components/{bell-button.tsx, notifications-panel.tsx}`. The popover body is now
`NotificationsPanel`, which mounts only while the popover is open. Its chips come from
`useLive(notifications, { groupBy: "type" | "variant" })`, and each type chip shows its
whole-collection count. A "More" chip pages the groups. The list pages with
`useInfiniteScroll` + `InfiniteScrollFooter` driven by `canGrow` / `growing` / `loadMore`.
Dismiss and Clear all now go through `useEndpointMutation`.

Deviations:

- **`live-collection.ts` forwards the preload flag.** A `bootCritical: true` literal inside
  its own `windowQueryResourceDescriptor(key, …)` call crashed the eager-tier scanner:
  `bootCriticalKeysIn` read it as a boot-critical declaration site with a non-literal key.
  The flag is now hoisted into a variable and spread, which is the wrapper contract the
  scanner documents.
- **`open-event-verify.ts` locator.** The script found the event row with the CSS locator
  `button`, but the events list's default view is a gallery whose cards are
  `role="button"` boxes, so the row was never found. It now uses `getByRole("button")`.
  This was a stale locator, not an app bug.

Verification:

- **Tests.** `./equin test plugins/shell/plugins/notifications` passes. This
  includes the new jsdom suite `web/__tests__/notifications-panel.test.tsx`: while the
  groupings are pending, the chip row shows a loading status and no chips; once settled,
  it shows one chip per server group, plus Errors when an `error` group exists.
- **Build and check.** `./equin build` succeeded, with every check passing, and a final `./equin check` passed.
- **`shell/notifications/e2e/bell-filter.ts`: 17/17 passed.**
  - The boot snapshot has `notifications` with exactly 200 rows, none of them of the old
    type. `:rows` and `:groups` are not preloaded.
  - A page whose websockets never connect still paints the unread badge, so the bell
    settles from the preload alone.
  - A type seeded only outside the newest 200 has a chip showing its count, and picking
    it lists all 5 of its rows.
  - Dismissing one removes it live, and the chip's count drops.
  - The bulk filter opens at 200 and grows to all 245 on scroll.
  - Cleanup ran through dismiss-all.
- **`apps/events/sources/e2e/live-sources.ts`: 18/18 passed**, including the live
  `enabled` toggle in both directions and the restore.
- **`apps/events/event-list/e2e/open-event-verify.ts`: 7/7 passed** after the locator fix.
  A link-less event opens its source page.
- **Slow-ops** (`get_runtime_profile`, this worktree).
  - `loader` aggregates exist for `events.sources` (10 loads, max 4.7 ms),
    `events.sources:rows` (8, max 3.0 ms), `notifications` (36, max 35 ms) and
    `notifications:groups` (8, max 3.2 ms). The `:groups` loads come from `sub` and
    `push` origins, the push ones being recounts after a dismiss.
  - The filtered `notifications` tuples are loads under the `notifications` label. The
    profile names a tuple only on its slowest spans, and those were all the default
    `{"limit":"200"}`. So a filtered tuple's own span is not individually visible in this
    window, but its loads are counted in the aggregate.
- **Timeline.** `get_timeline` (30 min, warning+) shows no flush stall on this worktree.
  The one `flushNotifies` slow-op is on `singularity` (main) during a host-wide duress
  window.
