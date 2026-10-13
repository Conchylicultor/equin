# Live paging follow-ups: what is left after key-range pages and unification

Task `task-1791593959-9liyj7` (Resources track › item 7, API half). Status: **approved; sessions 1 and 2 implemented** (see *As landed (session 1)* and *As landed (session 2)* at the end). Session 2's execution plan: `research/2026-10-13-global-live-paging-followups-session2.md`.

This builds on two docs:
- `research/2026-10-09-global-live-key-range-pages-v2.md`, for P1–P4 (on main as `1f49945319`);
- `research/2026-10-11-global-live-paging-unification.md`, for the one paging mechanism (on main as `fa14318eb7`).

Research method: eight read-only investigators (one per gap) and a completeness critic, all run against `fa14318eb7`. Their claims were spot-checked in code.

## Context

**The goal agreed for item 7:** infinite scroll for every collection, with no depth limit, at a cost bounded by construction. Pages are now key ranges, read through `useLive`, with liveness following the viewport. A deep scroll reaches every row: 5033/5033 on all-conversations.

The task was filed with 13 gaps on 2026-10-10, before the unification landed. Re-checked at `fa14318eb7`, about half are real and half are already solved or not worth building. This plan does the real ones in **two sessions** and records a decision for each of the rest.

### Exit criteria for item 7
1. Every window collection pages. No `scroll` flag remains, and no read grows by reloading its whole window ("mechanism C") except groupings.
2. No reader treats a window as the whole set. A lint stops new ones.
3. Tabs on different builds share one socket unless the frame vocabulary changed.
4. The list, gallery and Queue Done views pass the same deep-scroll checks as the table. The tree view cannot be given a paged source (tsc).

## Decisions: dropped or deferred (no task filed)

| Gap | Decision | Why |
|---|---|---|
| Column changes restart the read | **Not a bug.** | `columns` is not a wire param. A change takes the `sameColumns` branch (`live/web/internal/use-pages.ts:396`) and keeps pages and scroll, as `use-pages.test.tsx` pins. Visible-field toggles never reach the read. |
| Projection param | **Dropped.** | Only `reports` rows are wide (about 2 KB, `data` about 0.9 KB). If that matters, slim its list row (move `data` to the `:rows` read). Wire cost does not justify a new tuple dimension. |
| Hidden-rows marker | **Dropped, instrumented.** | It needs an inline entry kind in every view (L). The gap is one round trip, self-heals, and appears only after ≥ H inserts land in one page's range faster than that round trip. Session 1 adds a timing log. Reopen if the gap is common or over about 150 ms. |
| Cross-page one-frame duplicate or gap | **Duplicate: already fixed** (`winningPages`, `live/shared/page-plan.ts`). **Gap: measure first.** | Session 1 adds a counter. The fix, if it ever fires, is a client-side departure hold in `page-plan` (S–M), not the v2 P6 batched frame (L). |
| Offset jump (drag the scrollbar far) | **Deferred.** | L, with an open policy question (counting under a filter). It pays off only at tens of thousands of rows. Sketch for later: a `:cut` sibling (`OFFSET n LIMIT 1` over the window's order), plus a plan whose first page opens after a sized gap. |
| `long-sort-key` | **Kept as is.** | The wording is done (`data-view/web/internal/pages-paging.ts:22`). Main's longest title is 95 B against a 1 KiB limit. A JS prefix cut is unsound under Postgres collation. If mail subjects ever hit it, use a declared `left(col, n)` sort expression. |
| Groupings at `LIST_MAX` (100) | **Deferred.** | Every consumer is already complete or loud at the cap (facet error, sections `truncated` hint). |
| Seeding the first split after boot | **Accepted.** | A boot-hydrated page 0 has `appliedSeq` 0 until its first `sub-ack`, so a split in that window loads normally. This costs latency, not correctness. Session 1 adds a counter. |
| Generic viewport minter for hand-rolled lists | **Not built.** | After session 2 no hand-rolled list needs one. A free-standing minter would recreate the "viewport nothing measures" bug that the `visible-range-minter` lint exists to stop. |
| A DataView source over a paged value | **Deferred.** | It has no consumer. It needs filterable and text-column seams that values lack (`data-view/web/internal/live-data-source.ts:26-60`). |

## Session 1: correctness and hygiene

Independent of P5. Each step lands green on its own.

### 1.1 Set readers → `all` collections
Precedent: `taskCategories` (`tasks/plugins/task-category/shared/resources.ts`). Its reason reads "at most one row per X; a field projects it for every X".

| Reader | Today | Change |
|---|---|---|
| task-track (`web/hooks.ts:39-60`) | window 500 → 2000 grown by a `useEffect` `loadMore` loop | `taskTracks` becomes `all` (keep `preload: "boot-and-keep"`); delete the loop |
| starred (`web/internal/use-starred-ids.ts`) | window, `maxLimit` 1000 | `starredPages` becomes `all` |
| agent-origin (`web/components/origin-field.tsx:33`) | window, `maxLimit` 500 | `agentPages` becomes `all` |
| automations origin field (`web/components/origin-field.tsx`) | `automationTasks` at `limit: 2000` | a new `automations.origins` `all` with a narrow projection `{taskId, automationId}`; `automationTasks` stays the history window |
| event sources (`source-field.tsx:54`, `SourcesList`) | windows of 500 and 100 | `eventSources` becomes `all`; this also fixes `SourcesList`, which stops at 100 |
| sidequest-autopilot `launch-list-section.tsx:70` | `limit: 2000` windows joined as sets | `all` siblings for triage and decisions |
| ops `worktree-op-gantt.tsx`, `op-section.tsx` | `limit: 2000` read as full history | review each: either an `all`, or a bounded time range stated in the query |

- **Rollout:** **rename each converted key** (for example `task-tracks.all`), along with its preload and boot entries. An old bundle then never parses the new shape, so no C39 proof is needed. This follows the precedent of the `pages.tree` rename.
- **Guard (lint, rung 3):** `live/no-grow-in-effect` bans `loadMore` called from a `useEffect` or `useLayoutEffect` (the auto-grow loop). Session 2's P5 then removes `loadMore` from plain windows and the old growth path behind it (rung 1).
- **Not built:** a `no-window-as-set` flow lint. It is heuristic and favours false negatives. The `all` conversions plus the grow ban cover the known class.
- **Fix stale comments.** The `shared/resources.ts` files claim that an id-set read is O(tasks/pages). That is false now that `taskRows` and `pagesTree` are `all`.

### 1.2 Socket dialect → protocol version
- **Today:** `SOCKET_DIALECT = import.meta.url` (`live-state/web/notifications-client.ts:112`). Any rebuild of live-state splits the shared socket.
- **The frame vocabulary is hand-declared twice:** `ServerFrame` at `resource-runtime/core/runtime.ts:~1172`, and `ServerMsg` at `notifications-client.ts:~264`.
- **Change:**
  - one frame-vocabulary module in `packages/plugins/resource-protocol/core` (data plus derived types);
  - type `sendJson`, `broadcastJson` and the client message union from it;
  - `PROTOCOL` = a small pure-JS hash of its canonical JSON. A vocabulary change cannot ship without changing the id (rung 1).
  - `{ dialect: PROTOCOL }`. Send `protocol` on `sub` and `sub-batch`. A `derive` with a foreign protocol falls back to a full load, counted in `deriveFallbacks` as `protocol-skew`.
- **Move into the same module:** `DERIVE_MAX_SOURCES` (defined in both `runtime.ts` and `notifications-client.ts` at `fa14318eb7`), `DERIVE_MAX_ID`, and the `Derivation` and `DeriveSource` types.
- **Check first:** the SharedWorker script URL (`networking/web/shared-websocket.ts:63`, `new URL("./shared-ws.worker.ts", import.meta.url)`) is content-addressed. The socket also splits whenever the worker chunk changes. That is acceptable because it is rare. Confirm that its hash does not change with unrelated live-state edits.

### 1.3 `NotificationsClient` bound to the first `QueryClient`
- **Today:** a module-level singleton (`live-state/web/use-resource.ts:94-97`). Production is fine, with one caller. 19 test files pass `queryClient` into `NotificationsProvider`, and two of `use-pages.test.tsx`'s P1 assertions passed wrongly.
- **Change (rung 1):** drop the `queryClient` prop. The client owns its `QueryClient`. Add `live-state/web/testing` `createLiveStateHarness()`, which returns `{ Wrapper, queryClient, notifications, dispose }` with a fresh pair per test. Migrate the 19 files mechanically.

### 1.4 Instrumentation (feeds the decisions above)
These go in the `live-pages` `clientLog` channel (`use-pages.ts`):
- **overflow-split gap:** ms from minting a split to its rest page settling;
- **cross-page gap:** an id leaving one live page and reappearing in another within 1 s, with no delete;
- **seed refusal after boot:** a `seedOf` skip on `appliedSeq === 0`.

### 1.5 Docs
- **v2 doc:** P2 line 238 (columns) and §7 ("duplicate" is fixed).
- **Exact-counts doc:** `DataViewPaging.total` has landed.
- **`visible-range-minter` lint message:** its no-viewport advice is true only for scroll collections until P5.
- **The track page header** (done with this plan).

### Session 1 verification
- `./singularity test`:
  - `network/live`, `primitives/live-state`, `framework/resource-runtime`, `packages/resource-protocol`, `primitives/networking`;
  - the plugins of each converted reader.
- New tests:
  - each converted field resolves the row at `old maxLimit + 1`;
  - `RuleTester` for `no-grow-in-effect`;
  - `frames.test.ts`: the id is stable across key order, changes when a field is added, and is pinned by a snapshot;
  - `shared-websocket.test.ts`: the same protocol from different module URLs shares one worker;
  - `runtime-derive.test.ts`: the `protocol-skew` fallback;
  - `use-pages.test.tsx` on per-test clients: the release-now assertions run for real.
- e2e:
  - `screenshot.ts` on the task list grouped by track and by origin, and on Pages Favorites;
  - `events/e2e` `live-sources.ts` / `sources-verify.ts`.
- `./singularity build`, then `./singularity check`.

## Session 2: P5 (every window pages), hand-rolled lists, view verification

### 2.1 Gate: measure the boot payload first
- `benchmark_boot` (`debug/plugins/profiling/plugins/boot-bench/server/internal/{handle-run,aggregate}.ts`) reports timings only.
- Add raw and gzipped bytes per snapshot key.
- Measure on `singularity` (real data: 3143 notifications, 5031 ended conversations) before and after `$key`.
- The preloaded windows affected are `build.history` (50), `op-store.in-flight` (200), `notifications` (200) and `task-tracks` (500).
  - `task-tracks` drops out once 1.1 makes it `all`.
  - The estimate is +20–35 KB raw.
- **Gate:** at most 2% of the gzipped snapshot and at most 25 KB raw.
- **If it fails:** stop and report. The fallback, a keyed-tuple opt-in, is the old flag under another name, so it needs the user's decision.

### 2.2 `$key` on every window; the `scroll` flag deleted
- **`live/core/internal/live-collection.ts`:**
  - delete `spec.scroll`, `LiveCollection.scroll` and the `Sc` generic;
  - the window row schema always carries `$key`;
  - keep the `maxLimit ≥ 2·limit` throw for every window, and raise `build.history` (50/50) to fix the one violator.
- **`query-codec.ts`** always accepts `after` and `until`.
- **`live/server/internal/{serve-collection,serve-union}.ts`** always pass the key block. In query-resource, the option becomes required (`arm-plan.ts:572-584`, `fold` `:688-702`, `compile-union-window.ts:507`).
- **`live/web/internal/use-live.ts`:**
  - every non-group, non-`ids` window read dispatches to the pager (all pages live without a viewport, capped at `maxLimit`);
  - `useCollection` keeps only groups and `ids`, so mechanism C survives for groupings alone;
  - drop the `scroll === true` gates (`:454`, `:617`).
- **Retype `LiveScrollCollection` → `LiveCollection`.** Sites: `use-pages.ts`, `page-source.ts`, `web/testing/page-zero.ts`, `data-view/{core,web}/internal/live-data-source.ts`, `use-live-pages-paging.ts`, and the type tests.
- **Callers of plain `loadMore`** now split instead of reloading, with no API change: pages-trash, bookmarks bar and start page, metrics drill, automation history.
- Update the goldens and `scroll: true` fixtures (about 20 files). The case "only a scroll collection takes a cut" (`query-codec.test.ts:700`) is deleted.

### 2.3 Hand-rolled lists
- **Pages trash → DataView `list`** inside its dialog: a `sourceId` scope, with restore and purge as item actions. This removes the `no-adhoc-row-list` disable at `pages-trash.tsx:196`.
- **Notifications:**
  - The bell popover stays a bounded card list over the preloaded default window. It is chrome with an annotated `Row` map.
  - Add a **"View all"** that opens a notifications pane: a DataView `list` with unbounded depth, unread/read as a `groupBy`, and type chips as filters.
  - This keeps the popover light and the boot window unchanged in shape.
- **Mail thread messages:** stay on a bounded read (no viewport, capped at `maxLimit` 500, "Load older" splits). This is a documented exception: a thread is a reading surface of tall, expandable cards.

### 2.4 View verification
- **Conformance harness:** add `data-view/web/testing` `mountPagedDataView({ viewType, rows, paging })`, lifted from `page-placeholders.test.tsx` (its IntersectionObserver and layout mocks). Each real view's `__tests__/` runs the same cases: list, table, gallery, icons. Cases:
  - a placeholder carries `data-row-key` and `data-page-placeholder`;
  - its height equals the released rows' room;
  - a release writes no scroll;
  - a landing above the reader is anchored.
- **Gallery bugs (from code reading; write the failing test first):**
  - **A page boundary that falls mid-line** changes the layout on release, because the page size is not a multiple of `columns`. Fix: a view-supplied placeholder height (`placeholderHeight?` on `DataViewViewType` in view-core, defaulting to the advance sum). The gallery and icons views size it as `ceil(rows / columns)` lines.
  - **Chunk keys** (`gallery-view.tsx:364-389`) join every card key, so a head insert remounts every chunk. Key them by first card plus column count instead.
- **Tree:** `paging` together with `hierarchy` becomes a tsc error, via a union on `DataViewProps` (`data-view/core/internal/types.ts:907`). This replaces "verify the tree".
- **Queue Done (`isPaged`):** no placeholders are drawn. While Done is off screen every page releases, and coming back relies on anchoring alone. Extend `queue/e2e/done-paging.ts` into a deep scroll that leaves and returns. If rows jump, draw section-level placeholders through `SectionBody` (`section-body.tsx:70`).
- **`data-view/e2e/live-pages-scroll.ts`** gains `--view`, `--scroller <css>` and `--expect-placeholders`.

| View | Route | Checks |
|---|---|---|
| table (regression) | `/agents/all-conversations` | continuity (≤ 1 px drift), every row seen, DOM bounded, back to head |
| list | `/agents/all-conversations`, `/events/list` (with a live insert mid-scroll) | same |
| gallery | `/events/list` at 800, 1280 and 1600 px wide | same, at `--step 0.4` and `0.8` |
| list | notifications pane, pages trash (seed > 500 entries) | same, past the old `maxLimit` |
| list, `isPaged` | Queue Done (`--scroller` the sidebar) | the exact Done count, no skipped row after leaving and returning, `loadMore` after a hidden tail |

### Session 2 verification
- The bytes gate (2.1), reported in the result section of this doc.
- `./singularity test` on: `network/live`, `infra/query-resource`, `primitives/live-state`, `primitives/data-view` and its view plugins, `primitives/virtual-rows`, `framework/resource-runtime`, `runs`.
  - These must pass unchanged: `page-plan.test.ts`, `serve-collection-pages-oracle.test.ts`, `scroll-key-roundtrip.test.ts`, `use-pages.test.tsx`.
- New tests:
  - every window row carries `$key`;
  - `useLive(c)` on a formerly non-scroll collection splits on `loadMore`;
  - the gallery conformance case at a column count that does not divide the page.
- `./singularity build`, then the e2e matrix above. `live-pages-scroll.ts` must still show 5033/5033.
- `./singularity check`: `type-check`, `plugins-doc-in-sync`, the resource facets, `migrations-in-sync`.

## Decisions to confirm (recommended default in bold)
1. **P5 gate:** **at most 2% gzipped and 25 KB raw, stop and report if over**, or land regardless and report.
2. **Notifications:** **bounded popover plus a "View all" paged pane**, or a DataView inside the popover.
3. **Set-reader rollout:** **rename keys**, or keep the keys and prove old-bundle compatibility per key.
4. **The drop and defer table above.**

## Critical files
- `plugins/network/plugins/live/{core/internal/{live-collection,query-codec,row-key}.ts, web/internal/{use-live,use-pages,page-source,window-fields}.ts, server/internal/{serve-collection,serve-union}.ts, lint/}`
- `plugins/infra/plugins/query-resource/server/internal/{arm-plan,compile-window,compile-union-window,spec}.ts`
- `plugins/primitives/plugins/live-state/web/{notifications-client,use-resource}.ts`, plus a new `web/testing/`
- `plugins/framework/plugins/resource-runtime/core/runtime.ts`, `plugins/packages/plugins/resource-protocol/core/`
- `plugins/primitives/plugins/networking/web/shared-websocket.ts`
- `plugins/primitives/plugins/data-view/{core/internal/types.ts, web/internal/data-view-body.tsx, web/testing/, e2e/live-pages-scroll.ts}` and the gallery and icons view plugins
- `plugins/debug/plugins/profiling/plugins/boot-bench/server/internal/{handle-run,aggregate}.ts`
- Readers:
  - `tasks/plugins/task-track`, `pages/.../starred`, `pages/.../agent-origin`, `tasks/plugins/automations`, `apps/plugins/events/.../sources`, `tasks/plugins/sidequest-autopilot`, ops;
  - `shell/plugins/notifications`, `apps/plugins/pages/plugins/trash`, `infra/plugins/trash`.

## As landed (session 1)

Four parallel lanes, one worktree, then one integration build. Decisions the user took before it started: rename every converted key (with its preload and boot entries), build no `no-window-as-set` flow lint, build only `no-grow-in-effect`.

### Lane A — set readers → `all` (§1.1)
- **Converted, each to an `all` collection under a renamed key** (an old bundle gets `unknown-key`, a `skew` verdict, and never parses the new rows — no C39 proof needed):

  | Reader | Key now | Order | Read |
  |---|---|---|---|
  | task-track | `task-tracks.all` (still `boot-and-keep`) | `taskId` | `useLive(taskTracks, { select })` → the track map; the `useEffect` `loadMore` loop is gone |
  | starred | `pages-starred.all` | `blockId` | `useStarredPageIds` over the whole set |
  | agent-origin | `pages-origin.all` | `blockId` | `OriginField` via `useLive(agentPages, { select })` |
  | automations origin field | new `automations.origins` (`{ taskId, automationId }`) | `taskId` | the field reads it; `automationTasks` stays the history window |
  | automations launch decisions | `automations.launch-decisions.all` | `taskId` | the launch list's `select` keeps its own automation's |
  | sidequest-autopilot triage | `sidequest-autopilot.triage.all` | `taskId` | the launch list joins both sets by `select` maps (`ROWS_LIMIT` gone) |
  | event sources | `events.sources.all` | `createdAt desc` | `SourcesList` and the Source field read the whole set (the list no longer stops at 100) |

  Each states its `unbounded.reason` ("at most one row per X; a field projects it for every X", or "a person adds every source by hand").
- **Ops** (not converted — reviewed as the plan asked): no Gantt read is taken for the history as a set. Each is newest first at `OPS_READ_LIMIT` (read off the collection: `opsHistory.window.window.maxLimit`, 2000). The section's and the worktree window's reads are time ranges stated in their query; the worktree's own read has no time bound but the store's 30-day retention. A read that comes back full draws the newest ops and says it may hold older ones above the chart (`LiveOpGantt`'s `capped`; exactly-full says so too — `canGrow` cannot tell, being `false` at `limit = maxLimit`).
- **Guard:** `live/no-grow-in-effect` (rung 3) flags `loadMore` called from inside a `useEffect` / `useLayoutEffect` / `useInsertionEffect` callback — a member call, a binding named `loadMore` (not a function the file defines under that name) or destructured from it, a binding initialised from an uncalled `loadMore` read, or the effect callback being one — with a `RuleTester` suite. Deliberately strict on handlers the effect registers (an `IntersectionObserver` callback, a scroll listener): a hand-built pager is pointed at data-view / `useInfiniteScroll`; pinned by test cases.
- **Tests:** per converted set, a server test over the real feed (`task-tracks-all`, `pages-starred-all`, `pages-origin-all`, `sources-all`, `sets-all`, `triage-all`) that the row past the old `maxLimit` is held. Stale "O(tasks/pages)" comments and the readers' `CLAUDE.md` prose updated; the starred and events e2e scripts follow the new keys.

### Lane B (protocol) — socket dialect → protocol id (§1.2)
- **One frame vocabulary** (`packages/resource-protocol/core/internal/frames.ts`): every server→tab and tab→server frame declared once as data; `ServerFrame`, `ClientFrame`, `SubErrorFrame`, `Derivation`, `DeriveSource` derived from it. `DERIVE_MAX_SOURCES` / `DERIVE_MAX_ID` moved there (both copies deleted) and are part of the hashed data.
- **`PROTOCOL`** = `"rp-"` + a pure-JS cyrb53 of the vocabulary's canonical JSON (keys and `oneOf` values sorted) — `rp-1c585c874748dd` at landing; `protocol.ts`'s reason / verdict sets derive from it. The `sub` frame declares the `version` / `epoch` echo the runtime honours on any sub (the client sends it only in a `sub-batch`).
- **Exactly the vocabulary, both ends** (review fix): a frame type alone let a sender grow a field — TypeScript checks excess properties only on a fresh literal, never on its spreads, and four runtime sites built frames in variables. `sendJson` / `broadcastJson` take `ExactServerFrame<F>` and the client's `wire` `ExactClientFrame<F>`: every field the frame's kind / `op` does not declare is `never`, at every depth, however the frame was built. The runtime reads each tab frame as `ReceivedFrame<op>` (untrusted, every field optional, nothing undeclared), dispatched by `op` — its hand-declared message shapes are gone.
- **Server:** `sendJson` / `broadcastJson` take only `ServerFrame`; a `derive` under a foreign (or no) `protocol` loads in full, counted as `protocol-skew` in `deriveFallbacks` (checked before `held`).
- **Client:** `{ dialect: PROTOCOL }` replaces `import.meta.url`; it reads `ServerFrame` and sends only `ClientFrame`s (`wire`); `sub` and `sub-batch` carry `protocol`.
- **Checked first, as asked:** the SharedWorker URL is content-addressed by networking's own artifact (its `web` / `shared` / `exhibits` and the builder identity), so unrelated live-state edits never move it (`networking/CLAUDE.md`). A worker script that moves under an unchanged `PROTOCOL` is no name collision: SharedWorker identity is (script URL, name) — verified in Chromium 151 (same name, another URL: its own worker, no `error`).
- **Deviations:** the client's `makeSocket` hook takes `(url, options)` (to test the dialect; `SharedWebSocketOptions` exported, the transport fakes forward options); tab→server frames are in the hash too (what the server's derive check relies on); `"derived" in msg` replaces a fake `derived?: undefined`; the client keeps its tolerance of older servers' missing `epoch` / `flushOpenMs`; `sub-batch`'s `protocol` is sent but unused (only `sub` can carry a derive).
- **Tests:** `frames.test.ts` (stable across key order; changes on a field added or made optional, a frame kind added, a limit changed; pinned by an inline snapshot; `@ts-expect-error` cases for an undeclared field in a variable, a conditional spread and a nested entry), `runtime-derive.test.ts` (`protocol-skew` fallback still converges), `notifications-protocol.test.ts` (the client's dialect is `PROTOCOL`). A `shared-websocket.test.ts` case was dropped as redundant: the networking layer never sees module URLs, and same-dialect sharing was already pinned.

### Lane B (harness) — `NotificationsClient` owns its cache (§1.3)
- `NotificationsProvider` takes only `children`; the client exposes `readonly queryClient`, and an internal `NotificationsClientProvider({ client })` mounts a client with its own cache (the app provider and the harness both use it). `getOrCreateNotifications(qc)` and `NotificationsProviderProps` are deleted; `App.tsx` needed no change.
- `live-state/web/testing`'s `createLiveStateHarness(options?)` → `{ Wrapper, queryClient, notifications, dispose }`, a fresh pair per test (no retry, no refetch on mount, never stale — `options.queries` overrides), disposed by vitest's `onTestFinished`; it throws outside a running test, so a file-wide client cannot be written. 19 test files (28 sites) migrated; two boot-hydration cases keep the bare provider on purpose (they test the singleton the boot snapshot seeds).
- **Release-now made real:** with the cache drop in `unobserve(…, "now")` removed, three `use-pages.test.tsx` assertions now fail (loadMore cache drop, far pages, stale-budget placeholders) — the wrong passes P1 recorded are gone.

### Lane C — instrumentation and docs (§1.4, §1.5)
All three signals are `live-pages` `clientLog` lines, written from effects (no timer, no poll):
- **Overflow-split gap** — `reconcile` now reports `overflowed`: the rest page `(m, b]` of each overflow split it made (the half read whole). `use-pages.ts` appends each batch to the hook state (the last 8 kept, so two renders splitting before one commit lose none), stamps every batch past the last `seq` the effect saw in the commit that mints it, and logs `overflow-split gap Nms (rest page settled with K rows)` in the commit its read first settles; a rest page that leaves the plan first is dropped untimed.
- **Cross-page gap** — `web/internal/cross-page-gaps.ts`, a pure detector fed each settled live page's rows (by tuple) after every result change: a row leaving one page and reappearing in another within 1 s, in no live page between, is one gap (`cross-page gap: row X was in no live page for Nms`). It diffs only pages whose rows array changed (live-state keeps an unchanged value's identity), applies arrivals before departures (both frames in one observation is no gap), counts a departure only once no live page holds the row (the duplicate order is the dedup's), and treats a page leaving the plan as handing its rows on.
- **Seed refusal after boot** — live-state can import `clientLog` (it already traces with it), so no `_debug` counter was needed: `seedOf`'s `appliedSeq === 0` case (was folded into `source-moved`) is split in two — `source-loading` (nothing cached, or a derivation of its own in flight: not counted) and `source-hydrated` (a cached, boot-hydrated value), which also writes `seed refused: a source holds a boot-hydrated value` on `live-pages`, one line per refused seed.
- **Deviation:** the instrumentation reads a memoized snapshot of the live pages (`liveReads`) and keeps the overflow state as raw pages plus the plan's `base`, keyed inside the effect — passing render-time plan objects into helpers made the React Compiler bail out of `usePages` (`preserve-manual-memoization`).
- **Docs:** the v2 doc's P2 `columns` bullet marked superseded, its §6 follow-ups annotated (projection param dropped, hidden-rows marker dropped and instrumented, the `NotificationsClient` binding done) and §7 rewritten (the duplicate is fixed by `winningPages`, only a measured gap remains); the exact-counts doc marked landed (`cc0166ae05`, `DataViewPagingTotal`; the grouped `byValue` part superseded by server sections); the `visible-range-minter` message now says the every-page-live advice holds for scroll collections and paged values, and that any other collection's read is one growing window (no task id in the message — P5 rewrites that arm); the stale `DERIVE_MAX_SOURCES` line references replaced. `network/live` and `live-state` `CLAUDE.md` describe the three signals.
- **Tests:** `cross-page-gaps.test.ts` (8 cases), an `overflowed` assertion in `page-plan.test.ts`, and two `notifications-derive.test.ts` cases: a boot-hydrated source (no `derive` sent, one `live-pages` line) and a source still loading (no `derive`, no line).

### Open after session 1
Each item below is resolved in session 2 (see *As landed (session 2)*), except where marked.
- ~~P5 must rewrite the `visible-range-minter` message's "any other collection" arm~~ — rewritten in P5.
- ~~`debug/queue`'s `useJobRows` reads `jobRuns` as one window~~ — `job-runs.all` (A.1).
- The `*-all.test.ts` note is informational; no action.
- ~~`serve-collection-pages-oracle.test.ts` sends `derive` without `protocol`~~ — fixed on main before session 2 (`PROTOCOL` is sent); the live suites pass.
- ~~`build-button.test.tsx` mocks the live barrel without `mintVisibleRange`~~ — `pages-viewport.ts` mints lazily (0.1); the test is unchanged and passes.
- ~~The session-1 e2e runs~~ — run in session 2 against its integration build (all checks pass; see below).

## As landed (session 2)

One worktree, four lanes (0, A, B, C) and a review pass, then integration builds. Execution plan and the user's decisions: `research/2026-10-13-global-live-paging-followups-session2.md`. Item 7's exit criteria are met: every window pages and no `scroll` flag exists (1), no known reader takes a window for the set (2), and the list, gallery and Queue Done views pass the table's deep-scroll checks (4).

### Gate (§2.1)
- `benchmark_boot` reports `snapshotBytes { total, perKey, rowKeyBytes }` per mode (boot-bench, measured once per mode outside the timed burst).
- Measured on the worktree build: `$key` costs **73 B per row** (`notifications`, `build.history`). On main's real rows (200 notifications + 50 build runs) that is **~18.3 KB raw** (limit 25 KB) and **+2.1–2.4 KB gzipped, 0.21–0.24 %** of main's 1,012,384 B gzipped snapshot (limit 2 %). **Passed.** `op-store.in-flight` became an `all` set, so it carries no `$key` and has no worst case. `conversations-gone` already carried it.

### Lane 0 — test baseline
- `pages-viewport.ts` mints its `measuring` range lazily, so `build-button.test.tsx` passes unchanged.
- **Duplicate `events.source-runs` — root cause:** `source-runs-oracle.test.ts` registered the real key on server-core's global registry in `beforeAll`, and `./singularity test` runs every bun suite in one process. The oracle now uses its own `createResourceRuntime()` + `createChangeRouter(runtime)`, as the tasks-core tree oracle did. The review pass moved three more oracles the same way (`reports-list`, `latest-run` → the `release.history` duplicate behind `schema-layer-replay`, `conversations`). Nothing under `framework/` changed. A guard against a test file registering a real key globally is filed as a follow-up.

### Lane A — conversions, then P5
- **A.1, to `all` under renamed keys:** `job-runs.all` (`finishedAt desc`; `JOB_RUNS_MAX_LIMIT` and the unused `job-runs:groups` deleted), `op-store.in-flight.all` (`requestedAt asc`, preload `boot` kept), `places.places.all`, `places.tags.all` (`rank asc`). Each states its `unbounded.reason`. `pushes` and `prompt-block-tasks` stay windows: they are per-entity reads, not taken as a set.
- **A.2 P5:**
  - `scroll` and `LiveScrollCollection` are deleted; the `maxLimit ≥ 2 · limit` throw applies to every window.
  - `$key`, codec cuts, the key block and `familyOf` exist for every window.
  - query-resource's spec splits into `WindowQueryResourceSpec` (requires `rowKey`, renamed from `scroll`, union spec included) and `PointQueryResourceSpec`. `readField` moved to the window kind.
  - `use-live`'s `readKindOf` sends every window read to pages; `useCollection` serves groupings and id sets only.
  - `build.history` `maxLimit` is now 100.
  - The pager logs `pages= live=` only under a viewport or past one page.
  - The `visible-range-minter` message is rewritten. 15 production declarations and 21 test files lost `scroll: true`, and both goldens were regenerated (the SQL golden had been stale since `d9a446a1c1`).
- **A.3** reader-visible changes are documented in live's `CLAUDE.md`: the notifications popover stops at 400 (the step that fits under 500), any page's failure is the `error` arm, and a boot-hydrated page 0 logs `seed refused` on its first split.

### Lane B — views
- **3.1:** `DataViewInMemoryOrigin` is `rows & (hierarchy arm | paging arm)`, so `paging` beside `hierarchy` is a tsc error, pinned in `body-types.test.ts`.
- **3.2:** `data-view/web/testing` has `mountPagedDataView({ view, bundle, layout })`, which mounts through `DataViewShellFrame` + `DataViewBody` on a laid-out page, and `describePagedConformance`. list, table, gallery and icons each run it in a `paged-conformance.test.tsx`; grids add the mid-line and windowed-release cases.
- **3.3:** `useGridPhase` (data-view web barrel) records each cell's absolute index and pads a band with `data-grid-pad` spacers while pages stand above it. Line keys are `line:<n>@<columns>`.
  - **Deviation:** one new render prop, `DataViewRenderProps.placeholders` (the flat read's, present exactly when the body draws them). Without it a release could not be told apart from a head delete or an in-memory search hit.
  - The grouped table still draws no declared section's `before` placeholders (anchoring only); filed.
- **3.4:** `live-pages-scroll.ts` gains `--view`, `--scroller`, `--width`, `--expect-placeholders`, a per-key x check, and (integration) `--click <text>` for a surface behind a control.
- **3.5:** `done-paging.ts` gains the leave-and-return checks. No section-placeholder plumbing was needed.

### Lane C — hand-rolled lists
- **Pages trash:** a DataView `list` (`pages.trash`) inside its dialog, over `trashEntries` scoped to the pages source (search on `label`). Restore and Delete permanently are `item-actions`; Delete still confirms. The read happens only while the dialog is open. `GET /api/trash/:sourceId` is kept for agents and curl.
- **Notifications:** a "View all" header button opens **Debug → Notifications** (`notificationsPane`, route in `core/`), a DataView `list` over the bell's own collection.
  - Search on `title`; `type` and `variant` are facets.
  - The authored view groups by the raw `read` column as server sections, labelled **Unread / Read** (a bool field now names its sections through its `options` — `fields/bool/data-view-group`).
  - Open and Dismiss are item actions; Mark all read and Clear all are toolbar actions.
  - View all closes the popover through `onClose`, so nothing is marked read (pinned in `bell-button.test.tsx` and e2e step 4b).
- **Mail thread messages** stay a bounded exception: comments are fixed, and `MessageList` reverses its own pages, with a test that an appended older page remounts nothing.

### Integration fixes
- **list view:** a section dropped its band padding (`pt-section-body pb-sm`) on crossing the 100-row windowing threshold, so every row on screen jumped 8 px when a paged read grew past 100. This predates session 2 and was caught by `live-pages-scroll.ts`. The padding no longer depends on windowing.
- **`bell-filter.ts`:** the bell locator also matched Debug's new "Notifications" row, so it now requires the bell's `aria-label`. Step 4b checks that the unread count did not drop, rather than that it stayed exact (a host-filed report may raise it).
- The pane manifest records `notifications`. Three seeded overrides were authored: the Debug sidebar (Notifications after Reports), the trash and notification item actions.

### Verification (deployed worktree build)
- **Table:** `live-pages-scroll.ts` on `/agents/all-conversations` passes; **list** too, after the band fix. Each scrolls 3,200 rows down and back, with up to 21 placeholders, no row moving or changing column, and no reload.
- **Gallery** at 800, 1280 and 1600 px, steps 0.4 and 0.8: all pass (1,500 cards each way, placeholders, 0 column moves). Run over All conversations with list and gallery views added to the worktree's user config for the run and restored after: the events list holds 162 events (main too), too few to release a page.
- **Pages trash**, 541 seeded entries: all 542 reached both ways, DOM ≤ 100. No placeholder is expected under the 800-row stale budget.
- **Notifications pane**, 600 seeded: all 600 reached both ways, DOM ≤ 32, no placeholder under the 1,600-row budget. `bell-filter.ts`: all 26 checks pass, including View all.
- **Queue Done** (`done-paging.ts`): 11/11, exact "Done 5071" kept across leave-and-return.
- **Session-1 carry-overs:** `sources-verify.ts` 21/21; `live-sources.ts` all checks pass; screenshots of the task list, Pages, the trash dialog and the notifications pane.
- Two harness runs (`bell-filter`, `live-sources`) exited 1 only at the final network-idle wait: a request still in flight while the server shed load (429) under the e2e load. Every check passed.
- **Observed once under the bell e2e's ~1,000 inserts:** a `live-state-noop` report for `notifications` (817 of 1,076 pushes in 60 s carried no change). Main has never filed it for this key. Filed as a follow-up.

### Open after session 2
- Prune `job_runs` rows for retired job names (114 names hold 1,814 rows; the ring keeps 20 per name forever).
- `DataTableGroup` has no leading row, so the grouped table draws no declared section's `before` placeholders.
- A guard against test files registering real resource keys on the global runtime.
- The `notifications` no-op pushes under a write burst.
- Pre-existing suite failures unrelated to this work: the tasks-core `tree-oracle` C39 case (the legacy schema rejects `$columns`, since `164ecb112b`), and the shared-process ESLint rule tests ("not found by the project service").
