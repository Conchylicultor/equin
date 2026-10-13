# Live paging follow-ups, session 2: every window pages, notifications and trash, views verified

Task `task-1791791847-yvbl37` (Resources track › item 7). Status: **approved and implemented** (2026-10-13). What landed, deviations, measurements and verification: the parent's *As landed (session 2)*.

This is the execution plan for session 2 of `research/2026-10-12-global-live-paging-followups.md` (called "the parent" below). It does not repeat the parent's design. It records:
- what changed against HEAD `5f0705437a`;
- where the parent's session-2 design was wrong;
- the user's decisions;
- the order the work runs in.

Research method: five read-only investigators (P5 core, the boot gate, hand-rolled lists, views, leftovers) and a completeness critic. Then three adversarial reviewers, one per lane, checked this plan against the code; their corrections are folded in.

## Context

Session 1 is on main (`1e6a7ba34d`, `f75a8f3c7f`, `b75715fc16`). Item 7's exit criteria (parent §"Exit criteria") still have these gaps:

1. Only `scroll: true` windows page. 19 other windows grow by reloading their whole window (mechanism C).
2. Window-as-set readers remain: `jobRuns`, and three the parent missed: `places.places`, `places.tags` and `op-store.in-flight`.
3. Pages trash and notifications are hand-rolled lists with no viewport.
4. Only the table view is verified with pages. Not yet verified: list, gallery, icons and Queue Done. `paging` + `hierarchy` type-checks.
5. Pre-existing test noise (`build-button.test.tsx`, duplicate `events.source-runs`) makes this session's runs unreliable.

Track instructions (block-361815ed…) ask for as few sessions as possible. **This is the last session of item 7.** Its lanes run in one worktree, then one integration build.

## User decisions (2026-10-13)

| Question | Decision |
|---|---|
| Home app of the notifications pane | **Debug**, like the build popover's "Open in Debug" (`Pane.define({ app: debugApp })`) |
| Unread grouping in the pane | **The raw `read` column** (`groupBy read`). It can differ from the badge (`countedUnread`) on info and success rows. Accepted. |
| Mark-all-read on popover close | **Skipped when leaving through "View all".** The pane offers "Mark all read". |
| Places windows read as sets | **Convert them in this session** to `all`, with renamed keys |

Carried from the parent:
- the P5 gate: at most 2% gzipped and 25 KB raw; stop and report if over;
- rename a key when its collection changes shape;
- mail thread messages stay bounded.

## Corrections to the parent's session 2

| Parent says | At HEAD | Consequence |
|---|---|---|
| Measure the gate "before and after `$key`" on `singularity` | `notifications` is `ExcludeFromFork` and `build.history` is per namespace, so a worktree "after" measures about nothing | "After" = main's rows with `$key` added (§0.2) |
| Estimate +20–35 KB raw | Simulated on main's real payload: **+17,847 B raw, +2,420 B gzipped (0.24%)**. The baseline is 5,851,455 B raw and 1,012,789 B gzipped. The only risk was `op-store.in-flight` at 200 rows (~+16 KB). | That risk goes away once the window is an `all` set (A.1) |
| Gallery fix: `placeholderHeight?` sized `ceil(rows/columns)` | Heights are already advance sums. The defect is a **column shift**: after a mid-line release, the first surviving card restarts in column 0. | A phase pad replaces the seam (§3.3) |
| Chunk keys: first card + column count | A head insert still shifts every chunk's first card | Key by absolute line (§3.3). **Icons has the same two bugs.** |
| Queue Done: section placeholders "through `SectionBody`" | `SectionBody` draws only a *declared* section's `paging` (with a footer). `flatPlaceholders` is null under `isPaged` (`data-view-body.tsx:845`). | New plumbing (§3.5), built only if the e2e shows a jump |
| `DataViewProps` at `types.ts:907` | `hierarchy` and `paging` coexist on `DataViewInMemoryOrigin` (`types.ts:1247-1287`) | The union goes there (§3.1) |
| Plain `loadMore` callers: trash, bookmarks, metrics drill, automation history | The metrics drill already pages a value. Automation history only reads `canGrow`. **Missing:** the notifications popover (`notifications-panel.tsx:312`) and mail "Load older" (`message-list.tsx:43`). | The list in A.3 |
| Scroll gates at `use-live.ts:454` / `:617` | Now `:606` (`readKindOf`) and `:881` (`strip`). The query-resource option is named `scroll` (`spec.ts:261-292`). | — |
| ~20 fixture files | 27 test files (47 lines), `server/testing/compile-sql-golden.ts`, and both goldens | Size M–L |
| "Open after session 1": the oracle tests send no `protocol` | **Already fixed** in `1e6a7ba34d` | Mark resolved in the parent |

## Lane 0 (first): test baseline and gate instrumentation

### 0.1 Test noise
- **`MEASURING` minted at module load** (`data-view/web/internal/pages-viewport.ts:44`):
  - make it `useState<VisibleRange>(() => mintVisibleRange({ kind: "measuring" }))`;
  - nothing compares it by identity, and nothing else in data-view calls the live barrel at module scope;
  - this alone fixes `build-button.test.tsx` and protects the 8 other hand mocks of the live barrel;
  - the test itself is left unchanged.
- **Duplicate `events.source-runs`:**
  - **Reproduce first.** `echo.test.ts` only *type*-imports `events-core/server`, so it does not trigger this. The modules that evaluate `serveCollection(eventSourceRuns)` are `source-type.test.ts` and `events-core/server/internal/source-runs-oracle.test.ts`, plus every other file that loads `events-core/server`. Run them in both orders and capture the stack of the second registration (`runtime.ts:3477`).
  - **Fix the source** (the same module loaded under two specifiers, or re-evaluated).
  - **Idempotent `defineDeferredResource` for the same contract object:** add this only if the cause is "the same module evaluated twice" (it silently keeps the first `bind`).
  - **If no root cause is found:** stop and report.

### 0.2 Boot bytes (the parent's §2.1)
- **boot-bench** (`debug/plugins/profiling/plugins/boot-bench`):
  - `snapshotBytes: { total: {raw, gzip}, perKey: Record<key, {raw, gzip}>, rowKeyBytes: Record<key, number> }`;
  - measured once per mode, outside the timed burst (`handle-run.ts`);
  - carried through `aggregate.ts` `buildReport`;
  - described in the `benchmark_boot` MCP description.
- **Gate procedure:**
  - **Before:** `benchmark_boot` on `singularity`.
  - **After:** after the P5 build, take the worktree's `rowKeyBytes` per row, multiplied by main's row counts in the preloaded windows that remain (`notifications`, `build.history`). Cross-check with the jq simulation.
  - Record both numbers in the result section.
  - Over the gate → stop and report.

## Lane A: conversions, then P5

### A.1 Remaining window-as-set readers → `all`
These land **before** A.2, for two reasons:
- the fixtures are touched once;
- the pager costs one plan per call site. Today's set readers (one `useLive(opsInFlight)` per sidebar chip; `job-rows.ts:186-191`'s merge cached by array identity) would otherwise each re-map their rows on every push.

| Reader | Today | Change |
|---|---|---|
| `debug/queue` `useJobRows` (`job-rows.ts:172-181`) | `jobRuns` read as one window at `JOB_RUNS_MAX_LIMIT` (5000). Main has 1,814 rows over 114 job names (a ring of 20 per name; no name is ever pruned). | `job-runs.all`: `all` ordered by `finishedAt desc`, reason "ring of 20 per job name", no preload. `useLive(jobRuns)`. Delete `JOB_RUNS_MAX_LIMIT` and its export. Fix the stale "~2100" / "~2000" comments and `infra/jobs/CLAUDE.md:474-476`. |
| op-status `useWorktreeOp` (`use-worktree-op.ts:21`) | `op-store.in-flight` 200/500, oldest first. Above 200 in flight, the newest ops never appear (the banner's "+N others", the per-slug chips). | `op-store.in-flight.all`, ordered by `requestedAt asc`, `preload: "boot"` kept, reason "every op in flight on the host" |
| Places `usePlaces` (`places-core/web/internal/hooks.ts:24-30`) | `places.places` 2000/5000. The map draws every pin and caps silently at 2000. | `places.places.all`, reason "a person saves every place by hand". `:rows` is unchanged. Fix `hooks.ts:26` and `places-map/CLAUDE.md:10`. |
| Places `usePlaceTags` (`:37-40`) | `places.tags` 2000/5000. A cut orphans children. | `places.tags.all`, ordered by `rank`, reason "a person adds every tag by hand" |

- **Not converted, recorded:** `pushes` per attempt and `prompt-block-tasks` per block. Each is one entity's handful of rows, newest first.
- **Filed as a task, not built:** pruning `job_runs` for retired job names.
- **Tests:** one `*-all.test.ts` per set (the row past the old cap is held). Also update the queue, op-status and places tests.

### A.2 P5: `$key` on every window, `scroll` deleted
- **`live-collection.ts`:**
  - Delete `scroll` from the spec, `LiveCollection`, `LiveScrollCollection`, the `Sc` generic, `LiveArmsSpec` / `LiveArmsCollection` and the arms throw (`:578-582`).
  - The `maxLimit ≥ 2·limit` throw becomes unconditional (`:728-735`).
  - Every window row schema carries `$key`.
  - `runs` drops its `scroll: true`.
  - The field is deleted outright: every declaration is a fresh literal, so tsc rejects a stray one.
- **`query-codec.ts`:** `after` / `until` are accepted for every window (`:371-375` deleted).
- **`serve-collection.ts:949-962`:** serve the key block for every window, `familyOf` included, so non-scroll derivations can seed.
- **query-resource: split the spec into window and point kinds** (`spec.ts:261-292`), so a wrong state cannot be written:
  - the window kind requires `rowKey` (renamed from `scroll`) and holds the other window-only fields (`orderBy`, `signatureColumns`, `families`, `recomputeOn`), which `compile-window.ts:340-353` today refuses on a point only at runtime;
  - the point kind holds none of them;
  - sites:
    - `arm-plan.ts:188` (required on the window mode), `:562`, `:574-584`, `:643-645` and `:688-701`, where the branches become unconditional;
    - `compile-window.ts:442`, `:454` and the `windowQueryResource` overloads (`:492-535`);
    - `serve-collection.ts:211`, `:217` and `:683`;
    - `server/testing/compile-sql-golden.ts:170`, `:587` and `:703`;
  - the union spec's `scroll: {keyField, maxKeyBytes}` (`compile-union-window.ts:178`, `:507`; `serve-union.ts:510`) is renamed `rowKey` too.
- **`use-live.ts`:**
  - `readKindOf` (`:606`) sends every window read that is neither a group nor `ids` to `"all-pages"`;
  - `useCollection` keeps its grow state for groups only (the notification chips still grow);
  - the window `strip` (`:881`) is deleted;
  - the viewport overload is retyped (`:291`, `:476`, `:532`).
- **Retype `LiveScrollCollection` → `LiveCollection`:** `use-pages.ts`, `page-source.ts`, `web/testing/page-zero.ts`, data-view `core|web/internal/live-data-source.ts`, `use-live-pages-paging.ts`, `body-types.test.ts`.
- **`build.history`:** `maxLimit` 50 → 100. The boot tuple stays `{limit: "50"}`. Fix the comment at `build/core/resources.ts:21-31`, and in `build/CLAUDE.md` both "50 (also its max)" and "three list readers" (there are four).
- **Pager log:** the `[key] pages=1 live=1` line (`use-pages.ts:686-695`) is written only when `pages > 1` or a viewport is present.
- **Lint message:** rewrite the `visible-range-minter` arm "any other collection, one window whose `limit` grows" (`lint/visible-range-minter.ts:52-55`).
- **Docs:**
  - live `CLAUDE.md`: Read, the D2 table, "Collections — `scroll: true`", wire params, the union section;
  - live `web/index.ts:25`: the plugin description, which feeds `plugins-doc-in-sync`;
  - query-resource `CLAUDE.md`;
  - every plugin `CLAUDE.md` that says `scroll: true` / `LiveScrollCollection` (check each hit; some are DOM scroll).

### A.3 Reader-visible changes (accepted, documented in live `CLAUDE.md`)
- **Readers whose `loadMore` now splits instead of reloading:** pages trash, bookmarks bar and start page, the notifications popover, mail "Load older". The API is unchanged; `canGrow`, `growing` and `loadMore` stay on the result.
- **Cap one step short.** When `maxLimit` is not a multiple of the step, the pager stops one step early (`fits`, `use-pages.ts:785-788`). The notifications popover now stops at 400, not 500, which is acceptable with "View all". At 100/500 every window still reaches 500.
- **Errors.** A failure of a *later* page now turns the read into the `error` arm too; before, only page 0's tuple did.
- **Boot-hydrated page 0.** The first `loadMore` on it logs `seed refused` and loads `(a, k]` in full. This is latency only, and the parent already accepted it.
- **No key rename for P5.** An old bundle's zod object strips `$key`, and one build restarts both server and client.

### A.4 Tests
- **Delete:**
  - `query-codec.test.ts:692-720`;
  - `use-live-types.test.ts:79`;
  - `live-collection.test.ts:158`, `:214-215`.
- **Edit, not delete:**
  - `live-arms.test.ts:48`;
  - `mints.test.ts:86`, `:95` (the union fixture and the scanned source text: remove `scroll: true`).
- **Rewrite:** the window grow cases of `use-live.test.tsx` (`:65`, `:129`, `:186`, `:262`, `:975`), as split semantics. The groups case `:374` stays.
- **Fix the fixtures where limit equals `maxLimit`:**
  - `query-codec.test.ts:63,72,83`;
  - `serve-collection.test.ts:429,534,869`;
  - `serve-collection-joins.test.ts:1183`;
  - `serve-collection-all.test.ts:152`;
  - `mints.test.ts:41`;
  - `eager-tier-gen.test.ts:223`;
  - `parse-resources.test.ts:116,138`.
- **Strip** `scroll: true` from the 27 files. Regenerate both goldens.
- **Seed `$key`** in any harness test that asserts growth on a seeded window tuple. `setQueryData` skips parsing, so a row without `$key` cannot be cut.
- **New:**
  - every window row carries `$key`;
  - `useLive(formerly non-scroll)` splits on `loadMore`, with no full reload;
  - `familyOf` is served for every window (a derivation seeds);
  - `@ts-expect-error` for a stray `scroll`, and for window-only fields on a point spec.
- **Must pass unchanged:** `page-plan.test.ts`, `serve-collection-pages-oracle.test.ts`, `scroll-key-roundtrip.test.ts`, `use-pages.test.tsx`.

## Lane B: views
3.3, 3.4 and 3.5's e2e can start at once. 3.1 and 3.2 start after A.2's retype, because `body-types.test.ts` and `page-placeholders.test.tsx` are touched by both lanes.

### 3.1 `paging` ⊕ `hierarchy`
- Split `DataViewInMemoryOrigin` into `{ hierarchy?: HierarchyConfig; paging?: never } | { hierarchy?: never; paging?: DataViewPaging }`. Both keys stay optional, so a `HierarchyConfig | undefined` prop still fits.
- `manualOrder` + `paging` stays legal, because Queue uses both.
- Add `Rejects` cases on `DataViewProps` and `DataViewSourceBundle` (`body-types.test.ts`).
- Size S.

### 3.2 Conformance harness: `data-view/web/testing`
- **`mountPagedDataView({ view: { type, component }, bundle, layout })`:**
  - It renders through the existing prop seam: `<DataViewShellFrame viewModel={fake}>{(i, c, m) => <DataViewBody {...bundle} viewModel={m} activeInstance={i} chrome={c}/>}</DataViewShellFrame>`, inside `PluginProvider`. No test-only context is added.
  - `bundle` is the origin union, so the "live source scrolled deep" case can move as well.
  - `view.component` is passed in, because data-view cannot import its views.
  - `layout` is `"stack"` or `{ columns, linePx }`: a lane-aware layout model that stubs both column reads (gallery's probe `clientWidth` / `columnGap`; icons' `gridTemplateColumns`).
  - Lifted from `page-placeholders.test.tsx`: the IntersectionObserver class, the `scrollTop` spies, `settle()`, `consumerPaging()`, `model()`.
  - That file moves onto the harness.
- **One `paged-conformance.test.tsx` per view** (list, table, gallery, icons), with the parent's four cases:
  - a placeholder carries `data-row-key` and `data-page-placeholder`;
  - its height equals the released room;
  - a release writes no scroll;
  - a landing above the reader is anchored.
- **Gallery and icons, two more cases:**
  - a column count that does not divide the page, below and above the windowing threshold; written failing first, it asserts that each card's column is unchanged across a release;
  - windowed: a head release keeps the mounted chunk DOM nodes.
- **Grouped table:** a "before" case shows the gap (`section-body.tsx:69` skips "before" on an empty band; the table passes `null`, `table-view.tsx:277-280`). Draw it if small; else document that the grouped table relies on anchoring, and file a task.

### 3.3 Gallery and icons: phase pad and stable line keys
- **The view records its own layout.** Each view keeps a ref from entry key to the absolute cell index it was drawn at.
- **The pad comes from that record.** On render, the pad is the first drawn entry's recorded index mod `columns` (0 when unknown, e.g. at the head), drawn as that many empty spacer cells.
  - It counts **drawn cells**, so it stays correct under folding, aggregation and client filtering, where read rows ≠ cards.
  - It needs no new render prop.
  - It applies when the grid shows one ungrouped band. That is the flat read, or `sections.length === 1 && key === null`; a declared section uses its own record per section.
- **Spacer cells carry no `data-row-key`.** Viewport advances, anchoring, icons keyboard navigation, drag rects and selection all key on it, so they ignore the spacers.
- **Column count measured in both branches.** Mount the column probe whenever the view is paged, not only in the windowed branch (gallery > 60, icons > 120), and draw the pad in the plain `<Grid>` too.
- **Chunk keys** become `line:${n}@${columns}` from absolute line indexes. Icons' `keepMounted` / `raisedKey` use the same key function.
- **Result:**
  - a release or landing never reflows the cards below it;
  - mounted chunks survive;
  - a live head insert into page 0 still moves about 1/C of the cards (a true reflow).
- **Heights are unchanged.** Advance sums are exact when every row is drawn. They fall back to `rowPitch` around folded rows, as today.

### 3.4 e2e: `data-view/e2e/live-pages-scroll.ts`
- New flags:
  - `--view <type>`: click the switcher before the scroller is tagged;
  - `--scroller <css>`;
  - `--expect-placeholders`;
  - `--width <px>`.
- Record each key's `left` per snapshot, and fail when a key's x moves across a release or landing (the "no column shift" check).

### 3.5 Queue Done
- **Extend `queue/e2e/done-paging.ts`:**
  - a deep scroll in the sidebar;
  - scroll up until Done is off screen, then wait more than one settle;
  - come back, and assert every Done key is seen once, in order, with the count unchanged;
  - then `loadMore` after the hidden tail.
- **Only if rows jump:**
  - thread `placeholders` and `isPaged` into `DataViewRenderProps` and `PartitionOptions`;
  - add a **placeholders-only** field on `DataViewSection` (not `paging`, which would draw a second footer);
  - `useDataViewSections` puts the placeholders on the section that holds the tail;
  - the body also counts them under `isPaged` in its viewport target (`data-view-body.tsx:845-886`), so they are measured and sized;
  - size M.

## Lane C: hand-rolled lists (after A.2: `liveDataSource` takes `LiveScrollCollection` until then)

### 4.1 Pages trash → DataView `list` in its dialog
- **The read moves into the dialog body.** Today it subscribes at sidebar mount (`pages-trash.tsx:59`). The new source is `liveDataSource(trashEntries, { searchable: ["label"] }).scoped({ where: { sourceId: PAGES_TRASH_SOURCE } })`, and `label: liveText()` is added to `trashEntries.filterable`.
- **DataView:** `defineDataView("pages.trash")`, `views={["list"]}`, compact.
- **Fields:** `label` (primary), `deletedAt` (a date, shown with `RelativeTime`).
- **Item actions:** `restore` and `purge`, `zone: "persistent"`. Purge opens the existing confirm dialog through a context, following `history/plugins/dialog` (`RestoreVersionContext`).
- **Config:** author only the override `config/apps/pages/trash/pages.trash.jsonc` (seeded by the build with `@review`; clear it). The origin files, item-actions included, are generated.
- **Delete:** `TrashList`, `useInfiniteScroll` and the `no-adhoc-row-list` disable.
- **Kept:** `GET /api/trash/:sourceId` (agent/curl use), with a comment that the UI reads the live collection.

### 4.2 Notifications: "View all" pane in Debug
- **Pane placement:** in the notifications plugin itself (`notifications/web/panes.tsx`), following build (`build/web/panes.tsx`, `DebugApp.Sidebar`).
  - A sub-plugin could not import the parent's `shared/` (rule R10).
  - The bell imports `debugApp` for the link anyway; it is a single `defineApp` in `debug/shell/core`.
  - No boundary rule forbids it, and it creates no cycle.
- **Route:** `notificationsRoute` in `notifications/core/`, with `Pane.define({ title: "Notifications", route, app: debugApp })`, `Pane.Register` and a `DebugApp.Sidebar` entry. `pane:segments-unique` passes (no other `"notifications"` segment).
- **Collection:**
  - `notifications.filterable` gains `read` and `muted`, by reusing `countedUnreadFilterable` (`shared/unread.ts`);
  - it also gains `title: liveText()` for search;
  - the boot tuple stays `{limit: "200"}` (`defaultParams` has no `where`);
  - no `count`.
- **DataView:**
  - `liveDataSource(notifications, { searchable: ["title"], facets: ["type", "variant"] })`: the parent's "type chips" are facets;
  - `defineDataView("shell.notifications")`, `views={["list"]}`;
  - the `read` field has type `bool`, whose grouping `"value"` lowers to server sections;
  - `renderRow` reuses the popover row body, extracted without its `li`;
  - `rowTone` by variant;
  - row activation → `appLink(linkTo)`.
- **Config:** the authored override under `config/shell/notifications/` holds `groupBy { fieldId: "read", groupingId: "value" }` and `createdAt desc`.
- **Actions:**
  - item actions: dismiss, and open (when `linkTo` is set);
  - toolbar: "Mark all read" and "Clear all" (the existing endpoints);
  - no per-row mark-read endpoint.
- **Bell: "View all" in the panel header**, wired as `activationProps(afterOpen(appLink(notificationsRoute.link(debugApp, {})), onClose))`.
  - `onClose` calls `setOpen(false)` directly and never runs `markAllNotificationsRead`; only `onOpenChange` does (`bell-button.tsx:116-124`, `:174-176`). Row links already leave this way.
  - So the bell needs no change. A bell test pins it.
- **The popover stays:** a bounded default boot window whose `loadMore` now splits (cap 400). `e2e/bell-filter.ts:207-233` (200 → 245) keeps passing.
- **Tests and e2e:**
  - a pane test (groups, facets, dismiss);
  - a bell test (leaving through "View all" does not mark read);
  - `e2e/bell-filter.ts` extended with "View all".

### 4.3 Mail thread messages: documented bounded exception
- No DataView.
- "Load older" now splits, still capped at 500.
- Fix the comments: `resources.ts:5-11`, `message-list.tsx:16,20-23`, `web/index.ts:9`, and `panes.tsx:42-44` (`useThreadTitle` keeps page 0).
- One test: the split keeps order after the reverse, and no card remounts.

## Verification
- **Gate (0.2):** before and after numbers in the result section.
- **`./singularity test`:**
  - `network/live`, `infra/query-resource`, `primitives/live-state`;
  - `primitives/data-view` and its views, `primitives/virtual-rows`;
  - `framework/resource-runtime`, `runs`, `infra/jobs`;
  - `debug/queue`, `infra/op-store`, `op-status`, `apps/places`;
  - `shell/notifications`, `apps/pages/trash`, `mail`, `build`;
  - `debug/profiling`, `apps/events`;
  - then the whole suite once (the lane-0 noise must be gone).
- **`./singularity build`, then the e2e matrix:**

| View | Route | Checks |
|---|---|---|
| table (regression) | `/agents/all-conversations` | continuity ≤ 1 px, every row seen (5033/5033 or main's current count), DOM bounded, back to head |
| list | `/agents/all-conversations`, `/events/list` with a live insert mid-scroll | same |
| gallery | `/events/list` at 800, 1280 and 1600 px, `--step 0.4` and `0.8` | same, plus no column shift |
| list | notifications pane: seed > 500 undismissed rows through `POST /api/notifications` (no `dedupeKey`) before opening the tab | past the old `maxLimit` |
| list | pages trash: seed > 500 entries (`POST /api/blocks` top-level pages, then `DELETE /api/blocks/:id` each) | past the old `maxLimit` |
| list, `isPaged` | Queue Done (`--scroller` the sidebar) | exact count, leave and return, `loadMore` after the hidden tail |

- **Session-1 carry-overs:** `screenshot.ts` on the task list grouped by track and by origin, and on Pages Favorites; `events/e2e` `live-sources.ts` and `sources-verify.ts`.
- **Screenshots:** the notifications pane, the trash dialog, the gallery at 1280.
- **`./singularity check`:** in full (`type-check`, `plugins-doc-in-sync`, the resource facets, `config:overrides-authored`, the boundaries).

## Wrap-up
- **The parent doc:** append "As landed (session 2)", mark the oracle bullet resolved, and close the exit criteria.
- **Track header** (block-67eb04e7…): item 7 done, the next step, links.
- **Tasks to file:**
  - prune retired job names;
  - any leftover from the grouped table (3.2) or Queue Done (3.5);
  - the next track item (per the track instructions).

## Critical files
- `plugins/network/plugins/live/{core/internal/{live-collection,query-codec}.ts, web/internal/{use-live,use-pages,page-source}.ts, web/index.ts, server/internal/{serve-collection,serve-union}.ts, lint/visible-range-minter.ts}`
- `plugins/infra/plugins/query-resource/server/{internal/{spec,arm-plan,compile-window,compile-union-window}.ts, testing/compile-sql-golden.ts}`
- `plugins/primitives/plugins/data-view/{core/internal/types.ts, web/components/{data-view-body,section-body}.tsx, web/internal/{pages-viewport,live-data-source}.ts, web/testing/, e2e/live-pages-scroll.ts}`, plus the gallery, icons, list and table view plugins
- `plugins/debug/plugins/profiling/plugins/boot-bench/{shared/endpoints.ts, server/internal/{handle-run,aggregate}.ts}`
- `plugins/infra/plugins/jobs/core/resources.ts`, `plugins/debug/plugins/queue/{web/internal/job-rows.ts, e2e/done-paging.ts}`
- `op-store/core/internal/resources.ts`, `op-status/web/internal/use-worktree-op.ts`
- `plugins/apps/plugins/places/plugins/places-core/{core/internal/resources.ts, web/internal/hooks.ts}`
- `plugins/shell/plugins/notifications/{core/, shared/resources.ts, web/{panes.tsx, components/{bell-button,notifications-panel}.tsx}}`
- `plugins/apps/plugins/pages/plugins/trash/web/components/pages-trash.tsx`, `plugins/infra/plugins/trash/core/resources.ts`
- `plugins/build/core/resources.ts`, `plugins/framework/plugins/resource-runtime/core/runtime.ts`
