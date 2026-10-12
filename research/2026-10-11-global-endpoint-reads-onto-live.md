# Every web server read through `useLive`; `useEndpoint` deleted

Task: `task-1791560308-woqgfi`. Parent: `research/2026-10-09-global-live-structured-paged-values.md`.

## Context

The parent task built two pieces in `network/live`: typed-query and cursor-paged values, and the ratchet lint `live/no-endpoint-read`. Today that lint carries **96 debt files holding 109 reads**. They go through `useEndpoint`, `useEndpointResource`, or raw TanStack `useQuery` / `useInfiniteQuery` with `fetchEndpoint` in a `queryFn`. These reads have no change signal:
- most never refresh;
- three poll (`refetchInterval` in health-monitor, read-set and emit);
- seven depend on a mutation remembering to `invalidates:` them.

They also form a second read path beside `useLive`. That path keeps attracting new code because it is the easiest thing to type.

**Decisions (user, 2026-10-10/11)**
- **Delete the second read path entirely.** At the end there is no generic request/response read hook: `useEndpoint`, `useEndpointResource`, `hydrateEndpoint`, `useCursorPagination`, the `invalidates:` option and the exported `endpointQueryKey` all go. The reads that were going to be "sanctioned" (type-ahead search, self-inspection snapshots, binary bytes) each get an honest live form. A read that cannot go stale is then the only kind that can be written.
- **Grow `useLive`, don't add hooks.** New read capabilities are options on `liveValue` / `liveCollection`, read through `useLive`. A rule saying so goes into `network/live/CLAUDE.md` (P0.1).
- **Binary payloads are a `liveValue` form** (`bytes: true`, on-demand, served over HTTP as `octet-stream`), not a new hook.
- **"This file/answer is unavailable" is a `ResourceRefusal` with a typed reason code**, surfaced on the read's error arm. This replaces today's 400/403/404/413/415 status mapping.
- **Stats get interim `liveValue`s now.** Metrics P2/P3 (`research/2026-09-30-global-metrics-primitive.md`) will replace them later.
- **Mail search migrates fully:** ranked ids as a paged value, rows read live from the mirror.
- **One branch, staged pushes.** Batches land in order in this worktree. The user reviews and pushes after each batch, and each batch removes its own debt entries.

**Done means:**
- `./singularity exempt list --rule live/no-endpoint-read --debt` is empty.
- The rule has no sanctioned entries outside `network/live` itself.
- `useEndpoint`, `useEndpointResource`, `hydrateEndpoint` and `useCursorPagination` do not exist.
- The lint is a flat ban on TanStack read hooks and on `fetchEndpoint` GET reads in render/effect code outside the substrate.

## Findings that shape the design (verified in code)

- **Build artifacts are written after the run row closes.** `cli/.../build/cli/run.ts` runs `recorder.closeRun(buildId, 0)` *before* `writeBuildProfile` / `writeBuildLogs`. A `source: "db"` value keyed on `build_runs` would therefore recompute on closure and freeze on "no logs / no profile". Freshness has to come from the run's **terminal marker**, not the row.
- **`no-db-backed-notify` is lexical.** It scans `db.` inside the `serveValue(...)` call span, so a loader imported from another file escapes it. Several proposed "external" values actually read Postgres:
  - `stats/cost` `loadBundle` reads `_conversations`;
  - studio tables read `information_schema`;
  - deploy analytics' `resolveDeployment` reads Postgres;
  - `getPushFiles` reads `pushes`.

  Each needs an honest arm (below). The check itself gets the same fix in P0.
- **Read-set is per resource key, not per tuple.** A `db` value keyed by a table name (studio sample-rows / row-count) unions every table ever read into one read-set. A write to any of them recomputes every open tuple. That is acceptable with `throttleMs`, and the design records it.
- **The lint misses ~12 reads.**
  - Effect / async-state `fetchEndpoint`: log-viewer, plugin-health, events-test, bookmark preview, place-resolve, diff tokens / expand-lines, the screenshot 30 s poll.
  - Three NDJSON streams: timeline, slow-ops cluster, worktree-cleanup.
  - `review/plugin-changes` (excluded plugin, inline disable).
- **`useCursorPagination` has no callers.** Its scroll/footer UI (`useInfiniteScroll`, `InfiniteScrollFooter`) is fed by `useLive(...).loadMore` everywhere and stays.
- **Dead reads:** `getBuildProfiling` (the unsuffixed file is never written) and `debug/profiling/stats-section` (hardcoded `/api/stats/*` benchmark).

## P0: substrate (no site migrations except proofs)

### P0.1 Rule: grow `useLive`, don't add APIs
- Add a **Design rule** section at the top of `network/live/CLAUDE.md`:
  - "A new way to read server data is an option on `liveValue` / `liveCollection` that `useLive` reads (overloaded by the descriptor's type), never a new hook or a new read function.
  - A new hook needs a recorded reason in the research doc that introduced it ('`useLive` cannot express X because …').
  - Existing exceptions are listed: `useLiveRow` is pending unification into `useLive` (follow-up `task-1791751944-3ej507`, after this migration; `useLiveScroll` was removed by main's key-range paging, which reads every page through `useLive`); `optimistic-mutation`'s `useOptimisticResource` is a read+write hook."
- Mirror it as one line in the root `CLAUDE.md` "Live state is declared through `network/live`" bullet.

### P0.2 Widen the ratchet (before migrating, so the inventory is complete)
`live/no-endpoint-read` additionally flags, under `web/`:
- `fetchEndpoint(def, …)` whose `def` is a GET endpoint, when the call is inside a hook body, `useEffect` / `useLayoutEffect`, or an async-state setter path. Calls inside event handlers (`on*` props) and mutation functions stay allowed.
- `queryClient.invalidateQueries` / `refetchQueries` with an `endpointQueryKey(...)` key.
- NDJSON stream readers over endpoints (`infra/ndjson-stream` web reader).

Every new hit becomes a `debt` entry (same task id). `review/plugin-changes` keeps its inline disable, with the task id in its comment.

### P0.3 Declared freshness on external values (rung 2)
`serveValue(v, { source: "external", … })` gains a **required** `changes` discriminant:

| `changes` | Meaning | Allowed beside it |
|---|---|---|
| `"notified"` | Someone calls `served.notify(...)`, or `whileSubscribed` does | `whileSubscribed`, `notify` |
| `{ immutable: { reason } }` | A tuple's answer can never change (sha-keyed, a terminal run's artifact) | nothing; `notify` is a tsc error |
| `{ fixed: { reason } }` | Constant for the process lifetime (a contribution registry, a catalog fetched once) | nothing |
| `{ snapshot: { reason } }` | Re-measured only when a reader asks; implies `load: "on-demand"`, and every HTTP read runs the loader (no `revalidate`, no memo), so `useLive`'s `refetch()` *is* the Refresh button | nothing |

- Today about 70 external `serveValue` calls (51 files) have none of these. They get `changes: "notified"` in a mechanical sweep. Where a value has no notify caller at all, the sweep picks the honest one of `immutable` / `fixed`, e.g. `metrics.catalog` → `fixed`.
- The read-set debug pane and docs show the declared freshness per key.
- For `snapshot`, `useLive`'s result exposes `refresh()` (the on-demand refetch, typed only on snapshot values).
- Self-inspection snapshots (`/_debug`) filter their own key out of what they report. That is plugin-level and needs no runtime hook.

### P0.4 `bytes` values
- `liveValue(key, { params | query, bytes: true })` takes no `schema` and forces `load: "on-demand"`.
- tsc refuses `bytes` beside `load: "push"`, `preload`, `paged`, `source: "db"` and `origin: "central"`.
- **Server:** the HTTP read answers `application/octet-stream`, and `revalidate` / ETag work unchanged. `handleResourceHttp` (`resource-runtime/core/runtime.ts`) today wraps the value in a JSON envelope carrying `version` and `epoch`, which the client's stale-drop and cross-boot guards depend on. For bytes, those two move to response headers, and the client's HTTP read takes them from there. This is a framework (`resource-runtime`) change. `whileSubscribed` / `notify` work as for any external value, with `invalidate` frames only.
- **Client:** for bytes the read calls `arrayBuffer()` instead of parsing JSON. `useLive` returns `ResourceResult<ArrayBuffer>`.
- **Size:** a declared `maxBytes`, enforced server-side as a refusal (`too-large`).

### P0.5 Typed refusal reasons
- `ResourceRefusal` (`packages/resource-protocol`) gains `code: string`. A value declares `refusals: z.enum([...])` (or `["missing","denied","too-large","unsupported"]`).
- The loader throws `new ResourceRefusal(code, message)`, and tsc ties `code` to the declared enum through a `refuse(code, msg)` helper on the served value.
- **Wire:** HTTP `422 { reason: "refused", code, detail }`; WS `sub-error { reason: "refused", code, message }`.
- **Client:** the error arm's kind `refused` carries a typed `code`, so a component can branch `refused/missing` vs a real failure.
- An undeclared code from the server is `contract-mismatch`.
- This replaces every `HttpError(400/403/404/413/415)` on a migrated read (host-fs, code-api, studio tables, memory, events, boot-trace, analytics, file bytes).

### P0.6 Many tuples of one value through `useLive`
- `useLive(value, [p1, p2, …])` takes a params **array** and returns one result per tuple, in order. It is built on the internal `useResources` (which `useLiveScroll` / `useLivePages` used before main's key-range paging removed them).
- It serves dynamic sets such as the file-explorer's expanded folders and per-row folder peeks.
- An object-shaped params argument stays the single-tuple form, so the overload is unambiguous. A typed-query value takes an array of queries.

### P0.7 Shared change sources
- **Directory-watch hub** (`infra/file-watcher/server`): `acquireDirWatch(dir, onChange) → release`, refcounted over one `defineFileWatcher` declaration.
  - A child of an already-watched recursive root rides the parent watch (filtered by dirname).
  - It handles depth-1 listings on top of @parcel's recursive watch.
  - metrics `server/internal/source-watch.ts` and `conversation-view` edited-files rooms are refactored onto it.
- **Checkout watch hub** (`infra/git/server`): working tree plus git dir (HEAD / index / refs, `gitDirsOutside`) per checkout, on top of the dir hub. It is extracted from `file-explorer.git-status` and `conversation-view.edited-files`, which both re-implement it.
- **Plugin-tree change export** (`plugin-meta/plugin-tree/server`): `onPluginTreeChanged(cb) → off` plus `pluginTreeGeneration()` for `revalidate`. The watcher already exists in `structure-tree-cache.ts`.
- **Build-run terminal signal** (`build/server`): `onRunTerminal(listener)`, fired after the exit marker and every artifact are on disk (the reconciler's `readRunTerminal` covers runs that ended before a restart).
- **config_v2 exports:** `onConfigDirChange(cb)` and `configValuesServed` exported for `recomputeOn`.
- **`no-db-backed-notify` made real:** resolve the loader identifier to its definition (same-file or imported function) and scan that body, instead of scanning only the call span. A DB *write* (`insert` / `update` / `upsert`) inside an external loader is allowed; reads are not.

### P0.8 Cleanups
- Delete `useCursorPagination`, `cursorPageSchema` / `CursorPage`, and cursor-pagination's sanctioned entry.
- Delete the dead `getBuildProfiling` and the `debug/profiling` stats-section benchmark.

## Migration batches

Each batch:
- declares values in the owning plugin's `core/` (or `shared/` when plugin-private);
- serves them in `server/` with an honest `source` / `changes`;
- swaps the read to `useLive` / `useLiveRow`;
- deletes the GET endpoint and handler once no caller remains;
- removes the file's debt entry.

`Button` pending, `ResourceErrorInline` and the loading arm replace any hand-rolled `isLoading` handling. The full per-site inventory is in the appendix.

| # | Batch | Mechanism | Files |
|---|---|---|---|
| B1 | Fixed / immutable / plain `db` | P0.3, P0.5 | ~22 |
| B2 | Plugin tree | P0.7 plugin-tree | 10 |
| B3 | config_v2 + debug panes | P0.3 snapshot, P0.7 config, change producers | ~16 |
| B4 | Build artifacts | P0.7 run-terminal | 8 |
| B5 | Host filesystem + file viewer | P0.4, P0.6, P0.7 dir hub | ~13 |
| B6 | Checkout reads (code-api) | P0.7 checkout hub | ~6, plus hidden diff-token reads |
| B7 | Themes (read-your-write) | existing `optimistic-mutation` | 2 |
| B8 | Third-party | `query`, `paged`, `fixed`/`snapshot` | 5 |
| B9 | Stats interim values | `query` / `params`, `db` / external | 17 |
| B10 | Hidden reads from P0.2 + final deletion | all | ~12 + substrate |

### Per-batch decisions

- **B1:**
  - **`fixed`:** task-category registry (`boot-and-keep`), repo-info, `host-account` gains `home`, file-explorer main-checkout.
  - **`immutable`:** commit-info / commit-files keyed by `sha` (a linked worktree shares one object store; a gc'd sha → `refused/missing`), release logs of a terminal run.
  - **`db`:**
    - studio columns / FKs / indexes (`information_schema`; DDL only changes across restarts);
    - row-count and sample-rows (`throttleMs`, read-set union noted);
    - task-source-url (falls back to the editable `tasks.description`, so it is *not* immutable);
    - `attachments.by-owner`;
    - `claude-cli.calls-for`;
    - `events.run-events`;
    - history version (mutable in its merge window) and `history.versions` collection;
    - `page.block-locations` lookup collection;
    - `search.results` typed query;
    - `report-investigations.scope`;
    - boot-trace list (collection, metadata projection) and detail;
    - `build.chain-from` (`recomputeOn` `refHeadServed`).
- **B2:**
  - `plugin-view.tree` and `plugin-view.facets-tree` (on-demand; notify from `onPluginTreeChanged`; `revalidate` by generation) and `composition.data`.
  - plugin-link's private copy is folded into one reader.
  - Delete `getPluginTree`, `getPluginFacetsTree`, `getCompositionData`.
- **B3:**
  - `config-v2.raw-file` joins the per-document notify (`refreshEntry` → `notifyDocument`); conflict-diff and invalid-diff reuse it.
  - config-orphans (`onConfigDirChange`); broadcasts and memory (dir hub); emit status (the emitter notifies; removes a poll); health-monitor (sample listener; removes a poll).
  - **Snapshots:** heap, runtime profile and the three `/_debug` readers become one `resources.debug` snapshot value (removes the read-set poll).
  - `slow_ops` / `traces` become `defineChangeProducer` tables read as `db` collections. Every writer is in the serving backend (verify per A13). Change-feed `CLAUDE.md`'s "listSlowOps endpoint read" example is updated.
  - Boot profile: notify from `onWarmupRun`, then `fixed` after `drainWarmups`.
- **B4:**
  - One `build.run-logs` value (logs + fix share it), `build.run-profile` (shared with `debug/profiling/build-detail`), `build.run-termination`, `build.run-commits`.
  - Each is `"notified"` by `onRunTerminal` while the run is live, and immutable after.
  - `serve-status` uses a dir-hub watch on its marker.
- **B5:**
  - `host-fs.{list, peek, stat, text, volume (snapshot), image-sizes}` and `file-explorer.git-checkout`: dir hub, `refusals`.
  - listings / peek use `useLive(v, [...])`; folder-picker and image folder share `host-fs.list`.
  - `file-viewer.bytes` uses `bytes: true` with `refusals: missing | denied | too-large | unsupported`.
  - Delete `hostFsPeek` and the external `endpointQueryKey` use.
- **B6:** `code.file`, `code.file-diff`, `code.dir`, resolve-file, and the hidden `getFileContent` reads in diff-view (tokens, expand-lines): checkout hub, on-demand.
  - `code.push-files` is split: the web takes `baseSha` / `headSha` from the live `pushRows`, and the value is a pure-git range, immutable by `(base, head)`.
- **B7:** `saved-themes.list` (`db`, `boot-and-keep`) replaces `hydrateEndpoint` / `refreshSavedThemes`. Create-copy, rename and tweakcn adopt/import use the existing optimistic-mutation `ackTx` confirmation instead of `invalidates:`. Delete `hydrateEndpoint`.
- **B8:**
  - **Wallpaper (Openverse) and place search (Google Places):** `liveValue({ query })` with `changes: { fixed: "a third-party answer to one query; no change signal" }`. Place's billing session token rides in the query.
  - **tweakcn catalog:** `fixed`, on-demand.
  - **Deploy analytics:** typed query, `snapshot` (Refresh = `refresh()`). The deployment row is resolved outside the loader, or the value is `db`, so the arm is honest. Filter strings are bounded to fit `LIVE_QUERY_MAX_BYTES`.
  - **Mail hydrate:** `mail.message-body` `db` value with a pure read loader. Filling the body is a write job triggered on subscribe, and a failure is recorded on the row.
  - **Mail search:**
    - `mail.search` is `{ query, paged }`, external, with `changes: { fixed: … }` per query. Each page returns ranked **thread ids** plus Gmail's page token, and the loader upserts the envelopes it saw.
    - The list renders rows with `useLive(mailThreads, { ids })`, so read/starred flags stay live.
    - Folding a thread that appears on two pages happens over the live rows, which keyed dedupe handles.
- **B9: interim stats values** (deleted later by metrics P2/P3; the plan doc for P2 is updated to say so).
  - **cost:** one `stats.cost.*` value per chart over a shared memoized bundle, `"notified"` by `onPriceTableUpdated` and the transcript/archive watcher. The bundle **stops reading `_conversations`**: classification comes from the archive, and titles come from the live conversations lookup on the web. Cumulative and last-7 are derived client-side from the daily series where possible.
  - **commits:** `stats.commits.counts` / `.lines` typed query, `recomputeOn` `refHeadServed` plus the category-config edge, on-demand. Drop the manual `invalidateQueries`.
  - **pushes:** `db` over `op_log_ops`, typed `bucket` param.
  - **tasks:** `db`, one `stats-tasks.history` value.
- **B10:**
  - Migrate the P0.2 hidden reads: log channels (registry `subscribe`), plugin-health, bookmark preview (`fixed` per URL), place-resolve, events-test, screenshot (replace the poll).
  - The three NDJSON streams become paged or `"notified"` values, or are recorded as an explicit decision in this doc if a stream form is needed. In that case it is added to `useLive` per P0.1, not as a new hook.
  - Then delete `useEndpoint`, `useEndpointResource`, `query-result.ts`'s endpoint use, the `invalidates:` option, and the `endpointQueryKey` export.
  - The lint becomes a flat ban outside `network/live` / `live-state` internals. `useQueryResource` stays only for `exhibits`' local module loads, as its doc already says.

## Critical files

- `plugins/network/plugins/live/{CLAUDE.md, core/internal/live-value.ts, core/internal/query-value.ts, shared/compile-value.ts, server/internal/serve-value.ts, central/…serve-value, web/internal/use-live.ts, lint/no-endpoint-read.ts}`
- `plugins/packages/plugins/resource-protocol/core` (refusal `code`), `plugins/framework/plugins/resource-runtime/core/runtime.ts` (refusal code, snapshot = no revalidate, octet-stream read), `plugins/primitives/plugins/live-state/web/{use-resource.ts, resource-http-errors.ts, use-endpoint-resource.ts→deleted, hydrate-endpoint.ts→deleted}`
- `plugins/infra/plugins/endpoints/web/{internal/use-endpoint.ts→deleted, internal/use-endpoint-mutation.ts, index.ts}`
- `plugins/infra/plugins/file-watcher/server` (dir hub), `plugins/infra/plugins/git/server` (checkout hub), `plugins/plugin-meta/plugins/plugin-tree/server`, `plugins/build/server`, `plugins/config_v2/server`
- `plugins/framework/plugins/tooling/plugins/checks/plugins/no-db-backed-notify/check/scan.ts`
- `plugins/primitives/plugins/cursor-pagination/{web,core}`
- Each batch's sites: see the appendix.

## Verification (per batch, then at the end)

- **Unit tests** (`./singularity test plugins/network/plugins/live plugins/packages/plugins/resource-protocol plugins/framework/plugins/resource-runtime plugins/primitives/plugins/live-state` plus each touched plugin):
  - **`changes`:** `@ts-expect-error` for a missing `changes`, for `notify` on `immutable`/`fixed`/`snapshot`, and for `bytes` beside `push`/`preload`/`paged`/`db`.
  - **Snapshot:** a snapshot value's HTTP read always reruns the loader, and `refresh()` refetches.
  - **Bytes:** round-trip `ArrayBuffer`, 304 on unchanged `revalidate`, and a `too-large` refusal past `maxBytes`.
  - **Refusals:** a refusal's `code` reaches the error arm typed; an undeclared code is `contract-mismatch`.
  - **`useLive(v, [...])`:** order is preserved, and a growing / shrinking list keeps settled tuples.
  - **Dir hub:** refcount; a child under a watched root shares one watch; release on the last unsubscribe.
  - **`no-db-backed-notify`:** catches an imported loader that reads, and allows one that writes.
  - **Lint fixtures:** effect `fetchEndpoint`, `invalidateQueries`, an event-handler `fetchEndpoint` (allowed).
- **Per batch:**
  - `./singularity check` (type-check, eslint, exempt in-sync / unused, plugins-doc-in-sync, resource-vocabulary, no-db-backed-notify).
  - `./singularity build` (backgrounded), then at `http://<worktree>.localhost:9000`, `screenshot.ts` on each migrated surface.
  - For freshness, change the source while the pane is open and capture after:
    - write a file in a watched dir (B5);
    - edit a config (B3);
    - finish a build (B4);
    - commit in the checkout (B6);
    - add an attachment (B1).
  - The read-set debug pane lists every new key with its declared freshness.
- **End gates:**
  - `./singularity exempt list --rule live/no-endpoint-read --debt` returns nothing.
  - `rg "useEndpoint\b|useEndpointResource|hydrateEndpoint|useCursorPagination|invalidates:" plugins --glob '!*.md'` returns nothing.
  - `rg "@tanstack/react-query" plugins/**/web` matches only `network/live`, `live-state` and `infra/endpoints` (mutations).
  - `rg "refetchInterval" plugins` loses the three debt polls.

## Appendix: site inventory (from the read-only inventory workflow, 2026-10-10)

`→` is the target value; `[db]` / `[ext:…]` is the source and `changes`.

- **B1:**
  - `tasks/task-category/web/hooks.ts` → `task-category.registry` [ext:fixed, boot-and-keep]
  - `tasks/task-events/.../task-events.tsx` → `tasks.repo-info` [ext:fixed]
  - `tasks/task-source-url/.../use-attempt-source-url.ts` → `task-source-url.by-attempt` [db]
  - `tasks/task-attachments/.../task-attachments.tsx` → `attachments.by-owner` [db]
  - `tasks/reports-investigation/.../report-scope-section.tsx` → `report-investigations.scope` query [db]
  - `infra/claude-cli/.../use-claude-cli-calls.ts` → `claude-cli.calls-for` [db]
  - `apps/events/events-core/.../hooks.ts` → `events.run-events` [db]
  - `history/dialog/.../use-version-history.ts` → `history.versions` collection [db]
  - `apps/pages/history/.../page-version-preview.tsx` → `history.version` [db]
  - `apps/pages/page-tree/.../block-target.ts` → `page.block-locations` lookup collection
  - `search/quick-find/.../use-search.ts` → `search.results` query [db]
  - `code-explorer/commit-detail/{use-commit-info,use-commit-files}.ts` → `code.commit-info` / `code.commit-files` by sha [ext:immutable]
  - `build/deployment/.../use-chain-from.ts` → `build.chain-from` [ext, recomputeOn refHead]
  - `apps/studio/contributions/tables/{columns,foreign-keys,indexes,row-count,sample-rows}` → `studio.table-*` [db]
  - `apps/studio/compositions/release/release-logs` → `release.run-logs` [ext:immutable when terminal]
  - `debug/boot-profile/{list,detail}` → `debug.boot-traces` collection / `debug.boot-trace` [db]
  - `apps/file-explorer/places/web/internal/places.ts` (main checkout) → `file-explorer.main-checkout` [ext:fixed]
  - `host-path-source.ts` (home) → `host-account.home` [ext:fixed]
- **B2:**
  - `apps/studio/{explorer, contributions, compositions/closure-tree}`
  - `plugin-meta/plugin-view/{panes.tsx, file-tree}`
  - `plugin-meta/composition/.../hooks.ts`
  - `active-data/plugin-link/{use-plugin-claim.ts, panes.tsx}`
  - `config_v2/settings/config-nav.tsx`

  → `plugin-view.tree`, `plugin-view.facets-tree`, `composition.data`
- **B3:**
  - `config_v2/settings/{config-detail, conflict-diff, invalid-diff}` → `config-v2.raw-file`
  - `debug/config-orphans/{panel, stranded-notice}` → `config-orphans.report`
  - `debug/broadcasts` → `broadcasts.entries`
  - `debug/memory` → `memory.files` / `memory.file`
  - `debug/live-state-churn/emit` → `live-state-emit.status` + `resources.debug` [snapshot]
  - `debug/live-state-health/server-resources-section`, `debug/read-set` → `resources.debug` [snapshot]
  - `debug/heap-snapshot` → `heap.stats` [snapshot]
  - `debug/profiling/runtime` → `runtime-profiler.profile` [snapshot]
  - `debug/profiling/boot` → `profiling.boot`
  - `debug/health-monitor` → `health-monitor.series`
  - `debug/slow-ops/pane`, `debug/trace/pane/{events-view, trace-detail}` → producer-backed collections
  - `debug/profiling/{build-section, stats-section}` → delete
- **B4:**
  - `build/{build-logs, build-fix}` → `build.run-logs`
  - `build/build-profiling`, `debug/profiling/build/build-detail` → `build.run-profile`
  - `build/build-info` → `build.run-termination`
  - `build/build-commits` → `build.run-commits`
  - `build/serve-composition/.../use-serve-status.ts` → `build.serve-status`
- **B5:**
  - `apps/file-explorer/browser/{listings, folder-peek, preview-pane, host-path-source (volume)}`
  - `apps/file-explorer/places/{storage-meter, places (volume)}`
  - `apps/file-explorer/git/use-git.ts`
  - `primitives/file-viewer/{no-preview, use-file-text (host), use-file-bytes, image/use-folder-images}`
  - `primitives/folder-picker/use-host-dir.ts`

  → `host-fs.*`, `file-explorer.git-checkout`, `file-viewer.bytes`
- **B6:**
  - `primitives/diff-view/use-file-diff.ts`
  - `primitives/file-viewer/use-file-text.ts` (git)
  - `image/use-folder-images.ts` (git dir)
  - `code-explorer/file-resolve/use-resolved-file.ts`
  - `review/code-review/use-push-files.ts`

  → `code.*`
- **B7:** `ui/theme-engine/saved-themes/use-saved-themes.ts`, `ui/tweakcn/community-browser/catalog-source.ts`
- **B8:**
  - `apps-core/.../wallpaper/wallpaper-search-panel.tsx`
  - `page/place/place-search.tsx`
  - `apps/deploy/analytics/dashboard/use-deployment-analytics.ts`
  - `apps/mail/{reading-pane/use-hydrated-message.ts, search/use-mail-search.ts}`
- **B9:** `stats/cost/*` (8), `stats/commits/*` (4), `stats/pushes/*` (3), `stats/tasks/*` (2)
- **B10:** the P0.2 hidden reads (list above), then the substrate deletions.

## Result (P0)

Status: all P0 parts are in the working tree, and a review pass's findings are fixed (see *Review fixes* below). The unit tests of every touched plugin pass. Blocker 1 of the first pass (the `no-db-backed-notify` check failing on the excluded `review/plugin-changes`) is resolved: exemption manifests are now collected for every plugin on disk.

### What landed
- **P0.1:** the design rule ("grow `useLive`, don't add APIs") opens `network/live/CLAUDE.md`, with one mirrored line in the root `CLAUDE.md`.
- **P0.2:** `live/no-endpoint-read` is now type-aware. It also flags, in `web/`:
  - a GET `fetchEndpoint` that runs as a read: in an effect, memo, state initialiser, hook or component body, module top level, or a named function called from any of these;
  - GET `readNdjson` streams;
  - `invalidateQueries` / `refetchQueries` by `endpointQueryKey` or the raw `["endpoint", …]` key.

  The 13 new files are debt entries; the rule carries 110 exemptions, 107 of them debt. `review/plugin-changes` keeps its inline disable.
- **P0.3:** `changes` is required on every external `serveValue` and `compile*`/`register*` call: `"notified" | { immutable } | { fixed } | { snapshot }`.
  - Only `"notified"` admits `notify`, `whileSubscribed`, `recomputeOn` and `throttleMs`.
  - `liveValue({ load: "snapshot" })` sets a brand that pairs with `changes: { snapshot }` both ways. A snapshot takes no `revalidate`, `preload` or `paged`.
  - `useLive` exposes `refresh()` only on snapshot reads.
  - The read-set pane shows each key's declared freshness (Section D).
  - The sweep covered 49 sites. Three are `fixed`: `host-account`, icons `residentSprites` and `metrics.catalog`.
- **P0.4:** `liveValue({ params | query, bytes: true, maxBytes? })`.
  - The HTTP read answers `application/octet-stream`, with the version and epoch envelope in response headers (`resourceBytesHeaders` / `parseResourceBytesHeaders`).
  - The WS sub-ack carries no value; the client invalidates the tuple and reads it over HTTP.
  - `maxBytes` adds the `too-large` refusal.
  - tsc and runtime throws refuse `bytes` beside push, snapshot, preload, paged, central, a `schema`, or `source: "db"`.
- **P0.5:** refusals carry a typed code.
  - A value declares `refusals` (`z.enum` or a list), and its declaration's `refuse(code, msg)` builds the refusal. `ResourceRefusal(code, message)` comes from resource-protocol.
  - The runtime turns an undeclared code into `loader-failed`.
  - Wire: HTTP `422 { reason, code, detail }`; WS `sub-error { reason, code, message }`.
  - On the client, an undeclared or missing code is `contract-mismatch` (`skew`, `client-outdated`). `ResourceError<C>` and `ResourceResult<T, C>` type the code.
  - metrics declares `invalid-query`.
- **P0.6:** `useLive(value, [p1, p2, …])` reads many tuples, for param'd and typed-query values.
  - Results come back in order; duplicates are read once; a `null` entry is a skip.
  - `liveValue` refuses a typed-query schema that can be an array.
  - Fixed along the way: live-state's `useResources` shared results by position, so a kept tuple lost its `data` identity on reorder. It now shares them keyed by tuple.
- **P0.7:**
  - **refcount primitive:** `packages/refcount-hub` (`createRefcountHub`).
  - **dir hub:** `acquireDirWatch({ dir, scope: "subtree" | "children", onChange })` in `infra/file-watcher/server`.
  - **checkout hub:** `acquireCheckoutWatch` in the new `infra/git/plugins/checkout-watch/server`.
  - **moved onto the hubs:** file-explorer git-status, conversation-view edited-files and metrics `createSourceWatch`.
  - **plugin-tree:** `onPluginTreeChanged` and `pluginTreeGeneration()`, a `<bootUUID>:<n>` token.
  - **build:** `onRunTerminal`, which returns a `Promise` of the unsubscribe and resolves once its watcher is armed. It is fired from the exit marker, `closeBuildRow` and `onBuildEnded`, and may fire more than once per run.
  - **config_v2:** `onConfigDirChange`, plus the `configValuesServed` export.
  - **`no-db-backed-notify`:** now follows identifiers up to 3 levels, through same-file and imported definitions and `@plugins` barrels. DB writes are allowed. A feed exclusion also matches the table's SQL name.
- **P0.8:** deleted:
  - `useCursorPagination`, `cursorPageSchema` / `CursorPage` and the plugin's sanctioned entry;
  - `getBuildProfiling` and its build section;
  - the whole `debug/profiling/plugins/stats` plugin. `config/debug/profiling/section.jsonc` now drops the build and stats items.

### Review fixes
- **Refusal on the push path.** A push value whose loader refuses during a notify drain now broadcasts `sub-error { reason: "refused", code, message }` to every holder. The client then reads over HTTP and shows the typed refusal, with the last value as `stale`. Pinned in `runtime-refusal.test.ts`.
- **`useResources` / `useLive(v, [...])`.**
  - A per-tuple `refetch` now starts a new read even while one is in flight (`cancelRefetch: true`), matching `useResource`.
  - Each tuple's result object is cached by its `TupleState`, so an unchanged tuple keeps its result and `refetch` when another tuple changes.
  - `useValueList` caches its `refresh` wrapper by result object.
- **`no-db-backed-notify`:**
  - The follow-walk has no depth bound (the `seen` set ends it) and yields every ~10 ms.
  - A DB handle bound to another name (`conn = db`, `const tx = db`, a `db.transaction` callback parameter) counts as a read.
  - The receiver of a method call (`memo.get(id)`) is followed to its const.
  - New offenders became debt entries:
    - jsonl-viewer/subagents activity and transcript, on the new follow-up `task-1791766351-ziteb8` (conversation lookups in external loaders);
    - `tasks/automations` `automations.catalog`, on `task-1791766493-c5sz9f`.
  - The four first-pass conversation-lookup debts, and the new `review/plugin-changes` one, now point at `task-1791766351-ziteb8` instead of this task.
- **Exemptable set = scanned set.**
  - `defineCollectedDir(dir, { membership: "checkout" })` (collected-dir core) declares a registry that lists every plugin the checkout declares, excluded ones included. `exempt` is the only such dir.
  - `committedRegistryBundle(ctx, def)` (codegen) is the one answer both the generator and `plugins-registry-in-sync` render with.
  - `review/plugin-changes` therefore has a real `exempt/index.ts`, holding its `no-db-backed-notify` debt. Its inline `live/no-endpoint-read` disable moved into that manifest too (a deviation from P0.2's "keeps its inline disable": the reason for the inline disable is gone).
- **Dir hub.** A root opened above existing roots takes their watchers over. Each watcher is re-attached to the new root, and its old hold is released once that root is open, so there is no gap; a batch can arrive twice during the hand-over. A watcher whose own root opens after a root above it moves up when it goes live. Acquire order no longer matters.
- **allow-files** reads through `acquireDirWatch({ scope: "children" })` on the worktree root. Its private `conversation-view.allow-files` file-watcher declaration is deleted.
- **`live/no-endpoint-read`.** A function that leaves the code defining it is `unknown`, not a read:
  - returned, or an arrow's concise body;
  - an anonymous `export default`;
  - assigned to a non-`on*` target (the latest-ref `ref.current = fn`).

  The same function assigned to an `on*` property (`es.onmessage = fn`) is an action. All of this applies to named references too.
- **Resources facet.** An external `serveValue`'s `changes` is parsed (`"notified"` or the arm key; anything else throws) and rendered after the mode in the generated docs, e.g. `(push, fixed)` or `(invalidate, snapshot)`.

### Deviations
- `refuse()` is on the `liveValue` declaration, not the served value, which avoids a type parameter on every `serveValue` overload and a self-reference cycle. The undeclared-code check is enforced in `resource-runtime` for every resource.
- `fetchOverHttp` and `observe` now take a `ResourceRead` (`{ schema, refusals, bytes }`) instead of a bare schema.
- `maxBytes` is enforced in `network/live` (`boundedBytes`), not in the runtime.
- The checkout hub is a sub-plugin (`infra/git/plugins/checkout-watch`), because `infra/git` is an umbrella with no barrel. Its API takes an object with a required `scope`.
- The hubs changed some watch behaviour:
  - git-status's debounce went from 300/3000 ms to 200/2000 ms;
  - the hub declaration has no native ignore list, so `node_modules` and `.git/objects` events are filtered in JS (inotify behaviour is unverified);
  - edited-files now also recomputes on git-dir changes (`git add`, a merge-base move), and its failures are no longer swallowed.
- `getStructureTreeCached` and `getFacetsTreeCached` now await an armed watcher; before, the start was fire-and-forget.
- Edits under `plugins/framework/` (`resource-runtime`, the `no-db-backed-notify` check) were taken as approved by this plan. Small edits were made outside each implementer's scope: the docs facet `parse-resources.ts` (snapshot and bytes count as on-demand), the read-set pane, and doc prose in mail search, `infra/endpoints` and `infra/git`.
- New `no-db-backed-notify` offenders, outside B1–B10:
  - **sanctioned** (they read `graphile_worker`): `infra/jobs` `jobs-list` and `queue-health.pulse`;
  - **debt:** allow-monitor, conversation-view/code edited-files, jsonl-viewer events and background-shells output. Each looks a conversation up in Postgres before reading files, and needs a follow-up.

### Blockers / open
1. ~~`no-db-backed-notify` fails on `review/plugin-changes`~~ — resolved by `checkout`-membership exempt manifests (see *Review fixes*).
2. **The build-terminal signal misses hand-run builds.** An unsupervised `./singularity build` has no shim and no exit marker, so `onRunTerminal` never fires for it, and B4's "notified, then immutable" freshness does not hold for those runs. **Decided (2026-10-12):** B4 makes the step-logs file `build-logs-<id>.json` the terminal record for an unsupervised run (the CLI writes it last on every graceful ending, after the profile; run-ledger's settle already reads it that way). `onRunTerminal` fires on either the exit marker or that file.
3. **`network/live`'s own sanctioned `live/no-endpoint-read` entry (`web`) matches nothing.** It was not reported as unused; it was left alone.
4. **Not exercised live:** no production value uses `snapshot`, `bytes` or the list form yet. The first are B3/B8, B5 and B5 respectively.
5. **Lint blind spot:** a GET `fetchEndpoint` wrapper exported from one file and called from another file's effect is not flagged, and neither is a function stored in an object or class.

## Result (B1)

Integration verdicts: `./singularity check` is green except for `web-artifacts:map-in-sync`, which needs a build. `./singularity build` succeeded (build-1791789239-7cmjxc). Tests on every touched plugin plus `network/live`: 2624 bun:test tests pass, 4 fail, and every vitest test passes. The failures are listed under Open below, and none is caused by B1. In `GET /api/resources/_debug`, every new external key reports its declared freshness, and no external resource has a null freshness.

| Site | Value / collection | Source · freshness | Endpoint | Live evidence |
|---|---|---|---|---|
| task-category registry | `task-category.registry` (boot-and-keep) | external · fixed | `GET /api/tasks/categories` deleted | not opened (no screenshot shows a category-grouped task list) |
| task-events repo link | `tasks.repo-info` | external · snapshot (re-read per mount; see review fixes) | `GET /api/repo-info` deleted | task detail Pushes rows link the commit |
| task attachments | `attachments.by-owner` (`ownerType`, `id`; refuses `unknown-owner-type`) | db | `GET /api/attachments/by/:ownerType/:id` deleted | Attachments (3) render. **Freshness:** an open probe task gained the card 1.25 s after a PATCH linked an attachment, with no reload |
| report-investigations scope | `report-investigations.scope` (typed `{minCount}`) | db, throttle 1 s | deleted | not opened |
| claude-cli calls | `claude-cli.calls-for` (refuses `invalid-occurred-at`) | db | deleted | not opened |
| events run events | `events.run-events` (refuses `missing`) | db | deleted | not opened |
| version timeline | `history.versions` scroll collection, rendered as a DataView (`history.versions`) with a Restore item action | db (routed) | `GET …/versions` **kept** for e2e `crdt-restore-verify` | Version history dialog lists the timeline |
| version preview | `history.version` (refuses `missing`) | db | deleted | preview pane renders the selected version |
| block target | `page.block-locations` lookup-only collection (in `page/editor`) | db (routed) | `GET /api/blocks/:id/page` **kept** for e2e `page-link-verify` | not driven |
| quick-find | `search.results` (typed `{q, sources?}`) | db, throttle 1 s | `GET /api/search` **kept** for e2e (handler shares `runSearch`) | typing "plan" in the pages Search dialog lists highlighted results |
| commit detail | `code.commit-info`, `code.commit-files` (refuse `missing`, `no-checkout`) | external · immutable (the reason states what does not heal while subscribed) | both deleted | commit pane lists 265 files with +/- counts |
| deployment chain | `build.chain-from` (typed `{commit}`) | external · notified, `recomputeOn: [refHeadServed]` | deleted | not opened |
| release logs | `release.run-logs` (refuses `invalid-id`) | external · notified (dir watch on the run's transcript) | deleted | not opened |
| studio columns / FKs / indexes | `studio.table-{columns,foreign-keys,indexes}` | external · fixed (schema only changes at boot) | deleted | sections present (collapsed); contents not opened |
| studio row count | `studio.table-row-count` | external · snapshot | deleted | "5,195 rows (est.)" |
| studio sample rows | `studio.table-sample-rows` | external · snapshot (Refresh button) | deleted | section renders (collapsed) |
| boot profiles list | `debug.boot-traces` scroll collection | db (routed) | deleted (POST save kept) | list renders its empty state; this worktree has no saved traces |
| boot profile detail | `debug.boot-trace` lookup-only, `useLiveRow` | db (routed) | deleted | an unknown uuid renders "No saved boot trace with id …" |
| file-explorer main checkout | `file-explorer.main-checkout` | external · fixed | deleted | not opened |
| host home | `host-account.home` (sibling of `host-account`), read with `useLive(hostHome)` | external · fixed (`HOME_DIR` is `resolve()`d) | `hostFsStat` kept (B5 sites still use it) | not opened |

### Deviations (from the per-batch decisions)
- `tasks.repo-info` is a `snapshot`, not `fixed`, because `origin` can be re-pointed at runtime. (It was first `notified` by a watch on the common git dir; review moved it, see below.)
- `build.chain-from` is external `notified`, not `db`, because the loader only runs git.
- `release.run-logs` is one external `notified` value with a per-run dir-watch, not "immutable once terminal", because an external loader cannot read `release_runs`. A terminal run's file never changes, so its watch stays silent.
- Studio columns, FKs and indexes are external `fixed`, not `db`, because catalog views are not in the read-set. Row-count is a `snapshot` because `pg_stat_user_tables` has no change signal. Each of the four plugins has a sanctioned `no-db-backed-notify` exemption for catalog-only loaders.
- The boot-trace detail is a lookup-only collection read with `useLiveRow`, not a parameterised value.
- `task-source-url.by-attempt` was already a `db` live value before B1 (49b53b9eab); nothing to do.
- `host-account.home` is a sibling value, so the file explorer never waits on the full-name lookup.
- `page.block-locations` lives in `page/editor`, the plugin that owns `page_blocks`. `useBlockTarget` now makes one read instead of two.
- The commit `worktree` param resolves non-absolute worktrees in the shared object store. An unknown attempt id used to fail with a 404; a reaped attempt's commits now stay readable.
- `releaseTranscriptPath` now rejects ids that are not a single path segment, which closes a path-traversal hole.
- Integration fix: `commit-values.ts` declared `changes:` through a shared const, which the resources docs facet cannot read, so regen failed. The literal `{ immutable: { reason } }` is now inline at both call sites.

### Review fixes (B1)
- `release.run-logs`: the transcript watch is returned to the runtime (`whileSubscribed` → `Promise<StopFn>`), so a failed start is reported and paired instead of an unobserved rejection; a malformed id is refused `invalid-id` before anything is read or watched.
- `claude-cli.calls-for`: a malformed `occurredAt` is refused `invalid-occurred-at`. It stays a plain optional param: a typed param must be required.
- `HOME_DIR` is `resolve(homedir())` at its one definition, so `host-account.home` and every host-fs path share one spelling. `useHostHome` is deleted; the file explorer reads `useLive(hostHome)`.
- `code.commit-info` / `code.commit-files`: still `immutable`, and the reason now names what does not heal while subscribed (refusals, abbreviated shas). `commitFiles` answers with the full sha `rev-parse` resolved. Abbreviated shas stay accepted because the commit-link chip resolves the short sha an author typed.
- `studio.table-sample-rows`: an external `snapshot` with a Refresh button, not `db`. It samples any public relation, including views, rollups and change-feed-excluded tables, which would otherwise stay frozen while labelled fresh. Sanctioned `no-db-backed-notify` exemption.
- `tasks.repo-info`: a `snapshot` (re-read per mount). The `notified` form opened a native recursive watch on the shared common git dir.
- Version timeline: a DataView (`history.versions`, list view, authored config) over the now-`scroll: true` collection. Restore is an item action, and the newest version comes from a one-row read until the user picks one. `useVersionHistory` is deleted. A failed grow surfaces through the read's `error` arm (live has no separate grow error), which the DataView renders.
- Stale names fixed: `releaseLogsEndpoint` → `releaseRunLogs` (release CLAUDE.md), `getVersion` → `historyVersion`, `listClaudeCliCallsFor` → `claudeCliCallsFor`.
- Verification: `./singularity check` green; `./singularity build` green (build-1791794627-wirnrw). Tests on the touched plugins: 252 pass, 1 fail. The failure is `paths/legacy-layout` (`native → cache/signal-origin-native` has no declaration). No data-dir in the tree declares that row, and neither B1 nor the review touches it. Screenshots: Studio `entity_versions` Sample Rows renders 10 rows with Refresh. The pages Version history dialog lists the timeline as a DataView, with the newest selected and previewed.

### Open
- Three GET endpoints are kept only for e2e scripts that call them over HTTP: `…/versions`, `/api/blocks/:id/page` and `/api/search`. Move those scripts onto the live reads, or to a test helper, then delete the endpoints.
- The commit pane's per-file diffs still use the old per-worktree file-diff endpoint (B6).
- The startup-volume read in `places.ts` and `useRootVolumeName` in `host-path-source.ts` keep their narrowed `no-endpoint-read` debt entries (B5).
- Test failures not caused by B1:
  - `paths/legacy-layout`: the `native → cache/signal-origin-native` row has no declaration.
  - `tasks-core/tree-oracle` C39 fails even in isolation: the strict legacy conversation schema rejects the current row. B1 does not touch conversations.
  - `events-core/source-runs-oracle` and `page/editor/doc-rank` (seed 3) fail only when every file shares one bun process, because resource keys are registered twice (`events.source-runs`, `release.history`). The plugin-tree barrel import in `page/editor/core/markdown.test.ts` loads every server barrel. Both pass in isolation.
- Every headless run records a `browser-rejection` "Failed to fetch" crash from `debug.slow-ops` `flush`, unrelated to B1.
- Not driven live: report-investigations scope, claude-cli calls, run events, deployment chain, release logs, block-locations, file-explorer places and home, and the task-category registry. Each was checked through check/test/build and `_debug` only.

## Result (B2)

Three external values, each `"notified"` by plugin-tree's `onPluginTreeChanged` and `revalidate`d by `pluginTreeGeneration()`, so an unchanged tree answers 304. Every B2 reader now reads them through `useLive`. All three endpoints and their handlers are deleted.

| Site | Value | Outcome |
| --- | --- | --- |
| `plugin-meta/plugin-view/web/panes.tsx` (title + body) | `plugin-view.facets-tree` | `useLive`; Loading arm, `ResourceErrorInline`; debt manifest deleted |
| `plugin-view/plugins/file-tree/.../file-tree-section.tsx` | `plugin-view.facets-tree` | `useLive`; debt manifest deleted |
| `plugin-meta/composition/web/internal/hooks.ts` (4 hooks) | `composition.data` | `useLive`; graph deserialized once per value identity; debt manifest deleted |
| `apps/studio/explorer/.../explorer-view.tsx` | `plugin-view.tree` | `useLive`; debt manifest deleted |
| `apps/studio/contributions/.../contributions-view.tsx` | `plugin-view.facets-tree` | `useLive`; split into a loader view and an inner `ContributionsTables`; debt manifest deleted |
| `apps/studio/compositions/closure-tree/.../closure-tree-section.tsx` | `plugin-view.tree` | `useLive`; the `data!` assertion is gone; debt manifest deleted |
| `active-data/plugin-link/web/internal/use-plugin-claim.ts` | `plugin-view.tree` | `useLive`; pending → `claimPending()`, error → `declined(...)` as before |
| `active-data/plugin-link/web/panes.tsx` | `plugin-view.facets-tree` | already read the shared tree; its duplicate `findNode` and loading/error body are now folded into plugin-view's one reader, `PluginDetailForId` / `usePluginDisplayName` (review fix); debt manifest deleted |
| `config_v2/settings/web/components/config-nav.tsx` | `plugin-view.tree` | `useLive` feeding `foldResource`; path removed from the settings manifest (its other 3 paths are B3) |
| `getPluginTree`, `getPluginFacetsTree`, `getCompositionData` | — | deleted, with `tree-handler.ts`, `facets-handler.ts`, `data-handler.ts` and their `httpRoutes` |

### Deviations (B2)
- All three values carry `throttleMs: 2_000` (`plugin-view.tree` since the review fixes). Every edit under `plugins/` moves the generation, and each re-read rebuilds every facet, about 4.4 s per load in `_debug`'s `loaderStats.maxMs`.
- Contributions' tab and filter state now live in the inner component, so they reset if the read goes to its error arm and comes back.
- The error copy is `ResourceErrorInline`'s standard text with a retry, in place of the old `String(error)`.

### Verification (B2)
- `./singularity check` passed after the build. Its only failure before the build was `web-artifacts:map-in-sync` (stale dist).
- `./singularity build` passed (build-1791805365-zq8ji0).
- Tests on plugin-view, composition, plugin-tree, facets/exports, plugin-link, config_v2/settings, apps/studio and network/live: 577 bun and 100 vitest, 0 fail.
- Screenshots of the live deploy:
  - Studio Plugin explorer: the tree, 1376 plugins.
  - Studio Contributions: 1125 contributions, with every tab count filled.
  - Composition `agent-manager` with Closure expanded: the tree renders.
  - `plugin-meta.plugin-view` detail pane: facet counts shown (Depends on 104, Used by 53, Exports 15). With Files expanded, the file tree lists core, plugins, server, web and the root files.
  - Settings → Config nav: the plugin tree with config rows.
- Freshness, driven with the pane open and no reload (0 navigations): a dummy plugin folder `plugin-meta/plugins/zz-fresh-probe` was added and plugin-view's web barrel description edited.
  - Within 20 s the pane showed the new description (facets tree) and the tree listed `zz-fresh-probe` (structure tree).
  - After the revert both disappeared.
  - The tab re-read `plugin-view.tree`, `plugin-view.facets-tree` and `composition.data` on each change.
- `/api/resources/_debug`: all three keys report `policy: external`, `freshness: {kind: "notified"}`, `notifyStats.hand: 3`.

### Review fixes (B2)
- **Loading/failure/empty collapse in `useCompositionData`** (two findings): it now returns `{ data: ResourceResult<CompositionGraph>, manifests }` (`mapResource` over the read, deserialized once per value). `allIdsOf`, `graphFor`, `NO_IDS`, `isLoading`, `allIds: []` and `graph: null` are gone. `AppExclusions` gained a `failed` arm (`{error, refetch}`), as `CompositionInclusion` already had. Callers render each state: `graph-view` (Loading / `ResourceErrorInline` block), `entry-points-section` (Loading / inline error instead of an empty picker), `compositions-list` (Loading / block error), the explorer's `excluded-badge` (an icon error with Retry instead of a pending block that never ends), and `compositions/web/panes.tsx` (`data.status === "loading"`).
- **`plugin-view.tree` throttle**: `throttleMs: 2_000`, like the faceted values, so a build or a burst of saves re-ships the ~1.4k-node tree at most once per window per tab. The optional structural-hash `revalidate` was not done: it would need the structure build on every revalidate, which is what the loader already costs. The docs now say "an unchanged watcher *generation* answers 304" rather than "an unchanged tree".
- **Exemption manifests read stale after an edit**: `readManifest` moved to `facets/exemptions/facet/read-manifest.ts` and evicts `require.cache` before each `require`, so a rebuilt faceted tree sees an edited `exempt/index.ts` without a restart. New `read-manifest.test.ts` writes a manifest, reads it, rewrites it, and asserts the second read sees the edit.
- **Stale docs/comments naming deleted endpoints/files**: closure `CLAUDE.md` (the engine runs in the `plugin-view.tree` / `composition.data` loaders), plugin-tree `warmup.ts` (the cold `composition.data` / `plugin-view.facets-tree` read; the old slow-op name kept as historical), `manifest-map.ts` (`core/data.ts`'s schema), `hooks.ts` (the `compositionData` value), `use-plugin-claim.ts` ("a failed tree read").
- **plugin-link pane folding**: plugin-view/web exports one reader, `PluginDetailForId({pluginId})` (loading / `ResourceErrorInline` / `PluginDetail`) and `usePluginDisplayName(pluginId)`. Both `pluginViewPane` and plugin-link's `pluginConvSidePane` host it. The duplicate `findNode` and body are deleted.
- **`compositionDataSchema`** is no longer exported from composition's core barrel. It stays module-local in `core/data.ts`.
- Verification: `./singularity build` passed (build-1791806718-irzmtd, checks included; the first standalone check failed only on prettier, a `no-ready-negation` hit in the new hooks code (fixed with a per-arm switch), and generated/dist drift the build regenerates). Tests on exemptions, composition, plugin-view, plugin-tree, plugin-link and apps/studio: 52 bun pass, 0 fail. Re-screenshotted the live deploy: Plugin Graph focused on `plugin-meta.composition` (canvas renders, +396 hidden); the Compositions list; `agent-manager` with Entry points expanded (`agent-manager.**` chip, Add); the explorer (1376 plugins, Not-in-the-app badges on `render-diff` rows); and the `plugin-meta.plugin-view` detail pane through `PluginDetailForId` (Depends on 104, Used by 53, Exports 17).

### Open (B2)
- The plugin-link chip and pane were not driven live, because no conversation with a plugin chip was at hand. They are covered only by type-check and tests (17 pass).
- `./singularity exempt list --rule live/no-endpoint-read --debt`: **77** exemptions remain, all debt, and none of them is a B2 site.
