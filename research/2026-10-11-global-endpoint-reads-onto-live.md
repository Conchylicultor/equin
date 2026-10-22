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
  - Effect / async-state `fetchEndpoint`: log-viewer, plugin-health, events-test, bookmark preview (done in B8), place-resolve (done in B8), diff tokens / expand-lines, the screenshot 30 s poll.
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
  - `slow_ops` / `traces` become `defineChangeProducer` tables read as `db` collections. Every writer is in the serving backend (verify per A13). Change-feed `CLAUDE.md`'s "listSlowOps endpoint read" example is updated. *(For `slow_ops`: first taken as option (b) in Open (B3) item 1 — an external snapshot value, no producer; since replaced by option (a), see "slow_ops follow-up".)*
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
  - Migrate the P0.2 hidden reads: log channels (registry `subscribe`), plugin-health, bookmark preview (done in B8), place-resolve (done in B8), events-test, screenshot (replace the poll).
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

## Result (B3)

`./singularity check` passed apart from the two failures a build clears (`plugins-doc-in-sync`, `web-artifacts:map-in-sync`). `./singularity build` passed (build-1791816653-skqoqo). Tests on every touched plugin plus `network/live`, `database/change-feed`, studio sample-rows and launcher: 905 bun:test and 100 vitest pass, 0 fail. In `GET /api/resources/_debug` every new external key reports its declared freshness (below), and no external resource has a null freshness.

| Site | Value / collection | Source · freshness (`_debug`) | Endpoint | Live evidence |
|---|---|---|---|---|
| `config_v2/settings` config-detail raw view, conflict-diff, invalid-diff | `config-v2.raw-file` (`path`, `scopeId?`; refuses `missing`) | external · notified (per-document `notifyDocument` + a git-layer watch while subscribed) | `GET /api/config-v2/raw-file` deleted | Raw file of `apps/chord/piano` shows all four layers. **Freshness:** with the raw view open, appending a comment to the git origin (`config/…/config.origin.jsonc`) and to the user override showed both lines within 2.8 s, and reverting removed them within 2.1 s, with 0 navigations. No descriptor in this worktree is in conflict or invalid, so the two diffs were not opened |
| `debug/config-orphans` panel + stranded notice | `config-orphans.report` | external · notified (`onConfigDirChange`, throttle 1 s) | `GET /api/debug/config-orphans` deleted | Panel lists 8 orphans (2 stranded user data, 6 noise). The notice "2 saved settings no longer apply" shows above Settings → Config |
| `debug/broadcasts` | `broadcasts.entries` (refuses `malformed`) | external · notified (dir hub on the file's folder) | GET deleted (PUT kept) | Renders "No active broadcasts" and the path `plugins/framework/plugins/cli/broadcasts.json` (the file holds `[]`). Freshness not driven: the file lives in the main checkout and the CLI reads it |
| `debug/memory` list + content | `memory.files`, `memory.file` (`name`; refuses `missing`, `invalid-name`) | external · notified (dir hub, children scope) | both GETs deleted | **Freshness:** with the pane open, a probe `.md` written to the empty memory dir appeared in the list and its content rendered within 1.7 s. Deleting it went back to "No memory files found" within 1.4 s. 0 navigations, and a window marker survived. A `missing` refusal (422) was logged when the selected file was deleted |
| `debug/profiling/boot` | `profiling.boot` | external · snapshot (reason recorded) | `GET /api/debug/profiling/boot` **kept** (cold-start e2e; shares `readBootProfile`) | Memory phase table, per-phase deltas and the boot Gantt (13.8 s) render |
| `debug/profiling/runtime` | `runtime-profiler.profile` | external · snapshot | `GET /api/debug/profiling/runtime` **kept** (`get_runtime_profile` MCP tool) | The "Runtime — recent max · 1h window" table renders with rows, Refresh and Reset window (tall screenshot; Refresh not clicked) |
| `debug/heap-snapshot` | `heap.stats` | external · snapshot | `GET /api/debug/heap-stats` deleted | **Refresh:** "433 MB footprint · 1,190,539 objects" changed to "465 MB · 1,332,025 objects" after a click (a new measurement) |
| `debug/live-state-health` server resources, `debug/read-set`, emit dropdown | `resources.debug` (owned by `debug/read-set`, which gained `core/` + `server/`) | external · snapshot | `GET /api/resources/_debug` **kept** (runtime-owned) | Live State lists 279 server resources with subs/fan/rate. Read-set lists notify provenance, and every B3 external value appears there (`broadcasts.entries`, `config-orphans.report`, `config-v2.raw-file`, `memory.*` …) |
| `debug/live-state-churn/emit` status | `live-state-emit.status` | external · notified (`onEmitStatusChange`, throttle 1 s) | `GET …/live-state-emit/status` **kept** (`window.__liveStateEmit`) | The pane renders: status "Idle.", the resource picker and Refresh (the first load took 10 s on a loaded host). No session was started |
| `debug/health-monitor` | `health-monitor.series` | external · notified (dir-hub subtree watch of the worktrees root, filtered to `health` / `health-host` / `slow-op-markers` `.jsonl` and worktree dirs; throttle 10 s; async loader) | `GET /api/debug/health-monitor` deleted | Host charts plus 10 backends with per-backend lag, memory, heap and self-cost charts |
| `debug/trace/pane` events-view | `debug.traces` window collection (default `createdAt desc`, limit 200, max 500) | db · routed via the new `tracesProducer` (volatile, coalesced 2 s) | `GET /api/traces` deleted | **Producer freshness:** with Slow Events open, a `POST /api/debug/trace/test-trigger` row (`loader b3-probe-…`, 50 ms) appeared at the top within 2.4 s. The window marker survived (no reload) |
| `debug/trace/pane` trace-detail | `debug.trace` lookup-only (`debug.trace:rows`) | db · routed | `GET /api/traces/:id` deleted | The minted trace's detail renders "Also in this window (9)", the 10 s window Gantt, the gates strip and 97 spans |
| `debug/slow-ops/pane` (Slow Events → Aggregates) | `slow-ops.list` (`slowOpsValue` in slow-ops `core`; the endpoint's rows unchanged: every `slow_ops` row, `totalMs desc`, no params so no refusals) | external · snapshot (reason recorded; decision (b) of Open item 1) | `GET /api/slow-ops` (`listSlowOps` + handler) deleted, no other caller | The Aggregates tab renders the ranked table with callers, waits and trace chips. **Refresh** (toolbar, `onClick` awaits `refresh()`) issued one `GET /api/resources/slow-ops.list` and the `midi-folders:reconcile` row went from ×461 / 2,342,645 ms to ×462 / 2,344,904 ms (a new read). Build build-1791868788-8ssbxp |
| `debug/profiling/{build-section, stats-section}` | — | — | — | already absent from the tree before B3 |

### Deviations (B3)
- **Boot profile** is a `snapshot`, not "notified by `onWarmupRun`, then fixed". The profile keeps growing after serving starts (onReady / onAllReady spans, the closing `drainWarmups` span, the gateway report), and none of these has a change signal.
- **`resources.debug`** gets its payload by calling server-core's `handleResourceHttp` in-process at `_debug`. The cleaner shape is for the runtime to return the object; that is a framework change, tracked as task-1791822660-w6qvkd (also cited above `measureResources`).
- **Diffs now follow the selected scope:** `ConflictDiff` / `InvalidDiff` pass `scopeId`. Before, a scoped banner diffed the Base files.
- **Broadcasts path fix:** the server read `<main>/cli/broadcasts.json`, which has not existed since the `cli/` move. It now reads `plugins/framework/plugins/cli/broadcasts.json`, the file the CLI's op-runtime reads.
- **Bad files are refused, not shown empty:** a malformed broadcasts file is refused `malformed`. Broadcasts and memory became DataViews with authored configs.
- **Health:** the value carries `readAtMs` in place of the client's `dataUpdatedAt`, and its window is fixed at 2 h. The loader reads the JSONL files asynchronously (see Review fixes).
- `TraceListItem` moved to engine `core`, and its `createdAt` is now a `Date`.
- **Integration fixes:**
  - `change-feed:producer-writes` could not name `tracesProducer`'s table, because `_traces = traces.table` is a `defineEntity` table. The scan now resolves `defineEntity("<name>", …)` and `<entity>.table` bindings, both for table naming and for in-file write scope. A test covers it.
  - Six `live-state/no-ready-negation` / `no-pending-data-collapse` hits (broadcasts, heap, emit ×2, live-state-health, runtime) were rewritten with `foldResource` / `matchResource`, so each arm is named.
  - Two stale comments were fixed: `launcher/bin/launch.ts` named `getRawFileContent`, and the sample-rows comment listed `traces` as `ExcludeFromChangeFeed`.

### Review fixes (B3)
Eleven verified review findings were all applied. None was skipped.
- **Health loader is async** (`read-health-files.ts`). It uses `listWorktreeDirsAsync` (infra/paths) and `readChannelJsonAsync` (log-channels, an async tail read) and reads one worktree after another, so the flush path never does synchronous IO.
- **Health freshness is now truly notified** (`health-series.ts`). While the value is subscribed, one dir-hub subtree watch of the worktrees root fires on `<wt>/logs/{health,health-host,slow-op-markers}.jsonl` and on a worktree directory being created or reaped. The sampler hooks are gone. The watch has a closing `notify()` and a 10 s throttle. The 2 h window slides with the clock, but every live backend appends every 10 s, so the watch fires at least that often.
- **The orphan audit is async** (`config_v2/server/internal/orphan-audit.ts`). It walks the directory with `fs/promises` `readdir`/`stat`, and the loader awaits it.
- **Memory never creates folders**. `watchMemoryDir` takes a subtree watch of the nearest existing ancestor of `memory/` and filters to the folder and its direct entries. A project with no memory yet answers `{ files: [] }` and still hears its first file arrive.
- **The config watcher gap is closed**. `configWatcherArmed()` (config_v2) resolves once `initConfigWatcher` is live, or rejects if it failed. The `whileSubscribed` of `config-orphans.report` and `config-v2.raw-file` awaits it and then calls `notify()` once.
- **The change-feed `CLAUDE.md` remedy is corrected**. It no longer suggests the `listSlowOps` endpoint read. It points at the external `snapshot` form and names both precedents (sample-rows and slow-ops); only sample-rows needs the `no-db-backed-notify` exemption.
- **The trace point read is guarded on the server**. A point set's pk predicate is `anyOf(pk, ids, { invalid: "absent" })` (`query-resource/arm-plan.ts`), so an id the pk cannot hold reads as absent, never as a cast error. `UUID_RE` is deleted from `trace-detail.tsx`. This applies to every point read: a text pk now renders `= ANY($n::text[])` instead of `in (...)`. That is equivalent SQL. The compile-SQL golden was regenerated, the point SQL expectations in `compile-window.test.ts` and the fake db in `compile-window-runtime.test.ts` were updated, and a new uuid case pins the `pg_input_is_valid` filter.
- **The `resources.debug` debt is tracked** as task-1791822660-w6qvkd, cited in Deviations and above `measureResources`.
- **`resources.debug` uses one schema**. `resourcesDebugSchema` is exported from read-set `core` and used to parse the payload, and the local duplicate is deleted.
- **The memory server description** now covers only the server half, so the generated docs no longer repeat the sentence.

### Open (B3)
- ~~**`slow_ops` is not migrated.**~~ **Resolved with option (b)** (see the table and "slow_ops follow-up" below). `recordSlowOpBatch` runs one transaction per batch, with an upsert plus a JS read-modify-write merge under the row lock. A producer's `mutate` is one autocommit statement, so a direct conversion loses either the per-batch transaction (the 2026-09-02 incident fix) or merge safety across hot-swap backends. A decision is needed between two options:
  - (a) Redesign the recording funnel (CAS retry, or merges moved into SQL) as its own task.
  - (b) Keep `slow_ops` excluded from the change feed and make the pane an external `snapshot` value with Refresh, plus a sanctioned `no-db-backed-notify` exemption (the B1 sample-rows precedent). (The exemption turned out unnecessary — see slow_ops follow-up.)

  Option (b) was taken. `slow_ops` stays `ExcludeFromChangeFeed`, and the pane reads the external `snapshot` value `slow-ops.list` with a Refresh button. The pane's `live/no-endpoint-read` debt entry is deleted, and so is its `exempt/index.ts`.
- Four GET endpoints are kept for non-web callers: boot profile (cold-start e2e), runtime profile (MCP tool), emit status (`window.__liveStateEmit`) and `/_debug`.
- ~~Boot gap~~: closed in review. config_v2 exposes `configWatcherArmed()`, and both `config-orphans.report` and `config-v2.raw-file` re-read once it resolves (see Review fixes).
- Not driven live: the conflict / invalid diffs (none present), broadcasts freshness, an emit session, and runtime-profile Refresh.
- Observed and not caused by B3: Read-set labels every hand-notified external value "read-set gap", including the B2 values. The raw view shows "Resolved origin (build pending)" for any config whose git origin carries comments, because the user origin is stored without them.
- `./singularity exempt list --rule live/no-endpoint-read --debt`: **60** exemptions remain (77 after B2), all debt. No B3 site remains.

### slow_ops follow-up (B3)
- **Superseded (2026-10-13) by option (a):** `research/2026-10-13-debug-slow-ops-live-collection-v2.md`. The recorder folds each batch and writes ONE upsert per table with every merge in SQL, so `slow_ops` (and the new `slow_op_callers`, one row per op × caller) are change-producer tables read as live collections: the slim `slow-ops.ops` scroll window, the `slow-ops.op` lookup and the scoped `slow-ops.callers` window. `slow-ops.list` and its Refresh button are deleted. The bullets below record the interim option (b).
- **Value:** `slow-ops.list` (`liveValue`, `load: "snapshot"`) lives in slow-ops `core/resources.ts`, so the pane sub-plugin and the server both import it. The server serves it in `server/internal/slow-ops-served.ts` with `source: "external"` and the snapshot reason "slow_ops is excluded from the change feed — batch recording is a read-modify-write transaction a change producer cannot express; re-measured on open / Refresh". The loader is the old handler's query unchanged: `select * from slow_ops order by total_ms desc`. Like the endpoint, it has no limit. It is unbounded: a full-table read held back only by retention (one row per distinct operation, swept 30 days after its last recurrence). sql-column's measurement puts the whole read at about 19 MB / 5,130 rows, so bounding it is still open, as before.
- **No `no-db-backed-notify` exemption.** The planned sanctioned exemption was added, and the check failed it as dead ("suppressed nothing"). The check already admits a read that names a table the serving plugin itself excludes (`ExcludeFromChangeFeed({ table: _slowOps })` in the same plugin). The exemption was removed. The change-feed `CLAUDE.md` remedy now names both precedents and says which one needs the exemption.
- **Re-read on every mount** (review fix). The deleted endpoint read used `refetchOnMount: "always"`; a snapshot `useLive` read did not, so a remount within the 30 s subscription keep-alive showed the cached read (`staleTime: Infinity`) as `ready` without asking. network/live's `useSnapshotRead` now re-measures once on a mount that finds a cached read (the cached read stays on screen meanwhile), so every plain snapshot value reader — not only this pane — measures on mount. The list read (`useLive(value, [...])`) is unchanged.
- **Pane:** `useLive(slowOpsValue)` through `matchResource`. Loading shows `<Loading />` and an error shows `ResourceErrorInline` (block, with retry). When ready, the existing DataView is unchanged and gets the Refresh button through its `actions` toolbar slot.
- **Verdicts:** `./singularity check` failed only `no-db-backed-notify` (the dead exemption, fixed) and `web-artifacts:map-in-sync` (cleared by the build). `./singularity test plugins/debug/plugins/slow-ops plugins/network/plugins/live`: 534 bun:test and 100 vitest pass, 0 fail. `./singularity build` succeeded (build-1791868788-8ssbxp), with its checks included.

## Result (B5)

Batch B5 covers the host filesystem and the file viewer. Every B5 reader in scope now reads through `useLive`, except the git/workspace halves of two file-viewer hooks, which wait for B6. Verdicts:

- **Check:** `./singularity check` before the first build failed three checks: `web-artifacts:map-in-sync`, `web-artifacts:no-vendored-state-inlined` (both threw because `.generated/composition-modules/config-layer.singularity.ts` did not exist yet) and `layout-geometry`. None of them was caused by B5. All three passed once this checkout had been built.
- **Test:** `./singularity test` over file-explorer, host-fs, network/live, file-viewer and folder-picker gave 768 bun:test and 107 vitest passes, 0 fail. After the integration edits, file-explorer + host-fs gave 133 passes, 0 fail.
- **Build:** `./singularity build` is green, checks included (build-1792511406-5yaqj3).

### Per site

| Site | Value key | Source / changes | Endpoint | Debt entry |
|---|---|---|---|---|
| file-explorer `listings.tsx` (was `.ts`) | `host-fs.list` + `:meta` | external, notified (`watchHostDir`, 1 s throttle) | **`hostFsList` deleted** (integration) | removed |
| file-explorer `folder-peek.ts` (deleted) | `host-fs.peek` | external, notified | **`hostFsPeek` deleted** | removed |
| file-explorer `file-browser.tsx` (root crumb name; `useRootVolumeName` in `host-path-source.ts` deleted, which now takes `rootName`) | `host-fs.volume` `{path:"/"}` | external, snapshot | **`hostFsVolume` deleted** | removed |
| file-explorer `preview-pane.tsx` | `host-fs.stat` | external, notified (`watchHostPath`) | `hostFsStat` kept: imperative `fetchEndpoint` in `host-path-source.ts` (path-bar validate) and `places/favorites.ts` | removed |
| places `storage-meter.tsx`, `places.ts` | `host-fs.volume` `{path:"/"}` | external, snapshot | (deleted above) | removed (manifest deleted) |
| file-explorer/git `use-git.ts` | `file-explorer.git-checkout` | external, snapshot (re-asked on mount) | **`fileExplorerGitCheckout` deleted** | removed |
| file-viewer `use-file-bytes.ts` | `file-viewer.bytes` | external, notified, `bytes: true`, 64 MiB | raw GET routes kept (URL builders) | removed |
| file-viewer `no-preview.tsx` | `host-fs.stat` | notified | — | removed |
| file-viewer `use-file-text.ts` (host half) | `host-fs.text` | notified, ≤ 2 MiB | **`hostFsText` deleted** (integration) | **kept**: the workspace half is B6 |
| image `use-folder-images.ts` (host half) | `host-fs.list` + `host-fs.image-sizes` | notified | **`hostFsImageSizes` deleted** (integration) | **kept**: the workspace half is B6 |
| folder-picker (`use-host-dir.ts` deleted) | `host-fs.list` + `:meta` | notified, 500-entry pages with Show more | — | removed (manifest deleted) |

### Integration fixes
- **Deleted endpoints with no reader left:**
  - `hostFsText` and its handler, route and table row. `readHostPathText` / `HostFsTextResult` stay for the machine read.
  - `hostFsImageSizes`, with its handler, `imageSizesIn`, `HostFsImageSizesResult(Schema)` and route. `sizeOf` stays. The resize test now checks `sizeOf` per file instead of `imageSizesIn`.
  - `hostFsList`, with its handler and route (its last references were dead `invalidates:`), plus the unused `PathQuery`.
- **Dead `invalidates:` removed** from `ExtractAction` (`row-actions.tsx`) and `useMoveInto` (`move-into.ts`). No surface holds an endpoint listing any more; every listing, peek and stat is pushed.
- **A no-longer-needed debt exemption removed:** `boundaries/no-platform-api` on `host-fs/image/server/internal/sizes.ts` (flagged `unused-exemption`).
- Docs (host-fs, host-fs/image `CLAUDE.md`) were updated, and the generated registries, exempt registry and docs were regenerated.

### Live evidence
Every check below ran on `http://att-1791598784-yegtlr.localhost:9000`, against the test folder `/private/tmp/b5-fe`. Shots are in `/tmp/live-migration-shots/B5-*`.

- **Listing, peek, text preview, stat, storage meter and startup volume** (`B5-text-before.png`):
  - The listing shows 4 rows: sub-a, sub-b, notes.txt, pic.png.
  - The Size column shows the peek counts: "2 items" and "0 items".
  - The text preview shows notes.txt's two lines.
  - The preview meta (from stat) reads "/private/tmp/b5-fe · 23 B · Today".
  - The sidebar meter reads "692 GB free of 995 GB", and the Locations place is named "Macintosh HD".
- **Image preview** (`B5-image-before.png`): pic.png renders, with the meta "21 KB · Today".
- **Folder picker** (`B5-picker-open.png`, Settings → Config → sonata midi folders → Browse folders):
  - The breadcrumb reads Users › epot › __A__ › midi.
  - Three subfolders are listed (beethoven, chopin, lessons).
  - The validity check is green, and the "Select this folder" button is shown.
- **`/api/resources/_debug`:** every new key is `external` with the declared freshness:
  - `notified`: host-fs.list, list:meta, peek, stat, text, image-sizes and file-viewer.bytes.
  - `snapshot`, with its reason: host-fs.volume and file-explorer.git-checkout.
- **Freshness — verified** after `fseventsd` was restarted (0–12 % CPU, 13 MB RSS; load average ~12). Build `build-1792517674-xgryp4`, with the file-watcher fix below. A temporary e2e script (since deleted) opened `/files/at/<folder>` on a fresh `/private/tmp/b5-fresh-*` folder (`sub/a.txt`, `notes.txt`) and changed the disk with node `fs`. No reload happened: a `window` sentinel set after boot was still there at the end. The only route change was the `/notes.txt` pushState from clicking the file. Shots are in `/tmp/live-migration-shots/B5-fresh-*`. 9 of 9 checks passed; timings are from the last of three runs, and the earlier two were within ~0.3 s of them.
  - **Create in the open folder** (`B5-fresh-2-created.png`): the `created.txt` row appears in 1.4 s (1.3–1.6 s across runs). That is consistent with the 1 s listing throttle plus the 200 ms watcher debounce.
  - **Delete it** (`B5-fresh-3-deleted.png`): the row goes in 1.1 s (1.1–1.4 s).
  - **Expanded subfolder** (`B5-fresh-4-subfolder.png`): `b.txt` written into an expanded `sub` shows as a row in 1.3 s. The `sub` row's count was "1 item" before. It reads "2 items" in `B5-fresh-6-preview-after.png`. The script's 7 ms timing for the count is not meaningful: in shot 4 the hovered row's Size cell is covered by its hover actions.
  - **Text preview** (`B5-fresh-5-preview-before.png` → `B5-fresh-6-preview-after.png`): `notes.txt` was rewritten on disk. The preview shows the new line in 0.3 s, and the stat meta follows (27 B → 34 B).
  - **The open folder removed** (`B5-fresh-7-folder-removed.png`): with `rm -rf` on the open folder, the explorer shows "“/private/tmp/b5-fresh-…” does not exist." with Try again in 0.36 s, and no stale rows remain. The preview pane shows "File not found." and its meta reads "no longer exists". The 422 responses logged at that moment are the runtime's typed refusals from the re-reads of `host-fs.list`, `list:meta`, `stat` and `text` (not errors).
  - `./singularity test` over file-watcher + host-fs: 125 pass, 0 fail. This includes the three suites that wait for a real FSEvents delivery.

### Deviations (from the implementers, accepted)
- `useLive(v, [...])` does not take paged values. The explorer mounts one `<ListingReader>` per open folder, each reporting up through an effect. Peek is one `useLive` per visible Size cell, not the list form (only the cell knows it is on screen).
- network/live: paged values may be `needsMachine` (an `NM` type argument on `LivePagedValue`). data-view's `useLivePagedValuePaging` does not take it yet.
- Pages arrive in code-point order. Readers re-sort by name — since the review fixes through host-fs core's one `compareHostFsNames`.
- `file-explorer.git-checkout` is a `snapshot` value (`changes: { snapshot }`, `load: "snapshot"`), not pushed from the dir hub as the per-batch decision said. Reason: what it answers — is this folder inside a git checkout, and which — moves when a `.git` appears or goes in ANY ancestor of the folder, which a children-scope watch of the folder never hears; a dir-hub notify would need a watch of every ancestor. Cost: one `git rev-parse` per mount of a reader (the explorer re-asks on mount).
- Folder listings in the explorer and the image viewer read one window of `HOST_FS_PEEK_MAX_NAMES` (10 000). Past that the root says "N items not listed"; an expanded subfolder is cut off silently.
- `file-viewer.bytes` refuses workspace `FileRef`s as `unsupported`. Its only reader (MIDI preview) already got that.

### Review fixes (B5)

Nineteen review findings, all judged applicable; every one applied, two of them in their reviewer-offered alternative form (marked). Verdicts after the fixes: `./singularity build` green, checks included (build-1792514440-ntjevl); `./singularity test` over file-watcher, host-fs, file-explorer, tree, data-view, file-viewer, folder-picker and code-explorer: 611 bun:test + 300 vitest pass, 3 fail — the three that wait for a real FSEvents delivery, on a wedged `fseventsd`. After the file-watcher fix below and the `fseventsd` restart, file-watcher + host-fs give 125 pass, 0 fail (see *Freshness — verified*). Re-shot: `/tmp/live-migration-shots/B5-review-before.png` (the listing, the peeks "2 items" / "0 items", the storage meter "690 GB free of 995 GB") and `B5-review-preview-before.png` (notes.txt's text, its stat meta "/private/tmp/b5-fe · 12 B · Today", the Open with default app button enabled once the stat landed).

- **No recursive watch for a listing (high).** The dir hub never opens a NEW recursive root for a `children` request: with no root above it, it opens a single-directory watch of the folder (refcounted per dir), so `~` and `/` cost one handle. file-watcher's engine gains `depth: "children"` (one `fs.watch` without `recursive` per dir; a `rename` is classified by a stat as `create` / `delete`, the dir itself going — removed, moved, replaced, or the watch erroring — reported as a `delete` of the dir), declared as `file-watcher.dir-entries` (backend `fs-watch` in Background activity), and `createDirWatchHub` takes both starts (`{ subtree, children }`). A children request still rides a recursive root already open above it; a single-directory watch is never a root and never moves. `watcher-safety/no-raw-fs-watch` is exempted for `shared/engine.ts` (sanctioned).
- **No arm-time re-read.** The runtime awaits `whileSubscribed` before a tuple's first read (pages and meta included), so the watch is live before anything is read: `watchHostDir` / `watchHostPath` no longer call `onChange` when armed, which re-listed every folder and re-fetched every text (2 MiB) and bytes (64 MiB) read right after its first load. A real change to a watched entry now notifies once, after the re-arm (not twice). The `revalidate` alternative was not needed.
- **Peek bounded again:** `dirPeek` runs under a module `createSemaphore(8)` — a scroll costs at most 8 concurrent `readdir`s, as the batched endpoint did.
- **Archive membership is a state.** `useIsInArchive` → `useArchiveMembership(path)`: `loading` / `known { inArchive }` / `unknown { message }`. The fallback renderer's Open button and the preview pane's icon button render disabled while loading, are hidden for an archive member and when unknown (findings 4 and 14).
- **A failed refresh keeps the folder.** `ListingReader`: an `error` read (not a refusal) with `stale` rows and meta reports `ok` with `refreshError`; the explorer shows an inline notice above the kept rows. A refusal (the folder gone or unreadable) still replaces it — that is the server's answer, not a failed refresh.
- **Re-arm failure is reported and retried.** One `rearmable` (`host-fs/machine/internal/watch-entry.ts`) for every re-arming watch: each re-arm chains from a settled base; a failure is reported once (`console.error` + `reportServerError`), the watch keeps what it held, and the next event tries again.
- **Collapsed folders let go.** The tree's lazy-children contract gains `onOpenChange(open)` (primitives/tree, through data-view's hierarchy): the set of open, visible nodes, each time it changes. The explorer reads a folder while it is open; a collapsed one unmounts its reader (subscription, held listing, watch), keeps its last listing for an instant re-open, and a re-opened folder shows it until its new read lands.
- **Child-folder metadata (partial, by the reviewer's alternative).** A depth-2 watch (or a `subtree` acquire) would reintroduce the recursive watch the high finding removes, so the listing does not claim it: `watchHostDir`'s doc and host-fs's CLAUDE.md now say a child folder's modified time and size are as of the folder's last read. A folder's OWN stat (`host-fs.stat`) does follow its entries now: `watchHostPath` adds a children-scope watch of a folder it is asked about.
- **Symlinks watched where they point.** `watchHostPath` also watches the target's entry (`realpath`) when the path is a link, re-resolving when the link entry changes. Listings document that a symlinked child row's target is not live.
- **Missing folders are waited for.** `watchEntryOver` climbs to the nearest existing ancestor and moves down one level each time the next missing folder appears (reading again once re-armed); `watchHostPath` always returns a live release (`HostPathWatch` / `no-folder` deleted), and the callers in `reads.ts`, `bytes.ts`, `version.ts` and code-explorer's `file-version.ts` lost their no-op arm.
- **Docs:** host-fs CLAUDE.md's intro and *Live reads* rewritten (no `useEndpoint(hostFsList…)`, stat the only read with both forms, the watch semantics); `core/internal/live.ts`'s header and `endpoints.ts`'s path comment no longer name deleted endpoints; file-viewer's CLAUDE.md and web description say `useFileBytes` reads host files only until B6.
- **File-watcher fix: a single-directory watch hears its folder go, and is live before it is trusted.** Measured on macOS with Bun 1.4.3: Bun's `fs.watch` of a dir reports nothing when that dir is removed or moved away (no event, no error, no close). An open listing of a deleted folder therefore stayed stale. Fixes:
  - The engine's `depth: "children"` (`watchChildren` in `shared/engine.ts`) also holds a single-directory watch of the PARENT, filtered to the dir's own name. An inode check turns a `rename` there into a `delete` of the dir (removed, moved, or replaced). A watch error reports the same `delete`. `/` has no parent.
  - The hub keys each shallow watch by `dir` + generation and retires one that reported its dir gone. The holder's re-arm then opens a fresh watch of whatever now sits at the path, instead of joining the dead one.
  - The hub's `acquire` doc and file-watcher's CLAUDE.md (new section *`depth: "children"`*) record two Bun behaviours. First, a single-directory watch goes live a moment after it resolves, so a change in that gap is lost. Second, every directory watch of the process shares one FSEvents stream, restarted from "now" on each open/close (72 of 300 writes missed under constant churn).
  - The real-engine tests in `dir-hub.test.ts` wait for a probe entry (`untilLive`) before writing.
  - The verified freshness run above is the live evidence.
- **One name order:** `compareHostFsNames` (host-fs core) — `entry.ts`'s `byName`, folder-picker, the image viewer's folder and the explorer tree use it (the tree's `sensitivity: "base"` copy dropped; case now breaks ties instead of input order).
- **One machine feature:** `HOST_FS_MACHINE` (host-fs core), used by `hostFsFolderImageSizes`.
- **Plan doc:** the git-checkout snapshot is a recorded deviation; the volume row names `file-browser.tsx`.
- **Debt (the reviewer's alternative):** `peek.ts` / `volume.ts` / image `sizeOf` stay in `server/` — reason under Open; `listHostPath` moved from the server barrel to the machine barrel.

### Open (B5)
- **List form for paged values** (`useLive(paged, [...])`), so the explorer's per-folder reader components go away. Also: `useLivePagedValuePaging` does not accept `needsMachine`.
- **Subfolder listings past 10 000 entries** are truncated with no notice.
- **Workspace bytes for `file-viewer.bytes`** need a code-explorer workspace byte read (B6).
- **`peek.ts` / `volume.ts` stay in host-fs `server/internal/`** (and image's `sizeOf` in `image/server/internal/sizes.ts`) under the `boundaries/no-platform-api` debt entry, though only `machine/` reads them now. Moving them splits the suites that test them beside the other server reads (`host-fs.test.ts`, `archive.test.ts`, image `resize.test.ts`) across two folders — `server/` tests may not import `machine/` — for two files of a debt task (task-1792338443-riwqev) that splits the whole `server/internal`. `listHostPath` is now exported by the machine barrel (its only cross-plugin reader is image's machine half), not the server barrel.
- **`hostFsStat` is still a GET endpoint**, called imperatively (`fetchEndpoint`) by path-bar validation and favorites. It is not flagged by `live/no-endpoint-read`. It could become a one-shot read of `host-fs.stat`.
- **`file-explorer/e2e/item-count-verify.ts` uses a stale selector** (`[data-aligned-cell=size]`, which nothing renders any more). It fails at its first Size read, so it needs a new way to aim at the Size cell. Found during the freshness run; not run since.
- **Observed and not caused by B5:**
  - The health dot shows attention while slow-op reports accumulate on the loaded host.
  - Settings shows "5 saved settings no longer apply".
- `./singularity exempt list --rule live/no-endpoint-read --debt`: **49** exemptions remain (60 before B5), all debt. The two B5-adjacent ones left (`file-viewer/use-file-text.ts`, `file-viewer/image/use-folder-images.ts`) are their B6 workspace halves.

## Result (B6)

Batch B6 covers checkout reads (code-api). Every B6 reader now reads through `useLive`. All five checkout GET endpoints are deleted: file, diff, list, push, and resolve. The review's plugin-changes endpoint is deleted too. `code.file-version` is also gone: it had no reader left once the file viewer moved to `code.file`. Verdicts:

- **Check:** after `regen-generated` and `format`, `./singularity check` failed one check, `web-artifacts:map-in-sync`. The deployed dist predated the tree (the demo browser host artifact was missing), and a build fixes that, so this was not a code failure. Every other check passed, including type-check and the repo lint rules over the B6 files.
- **Test:** `./singularity test` over code-explorer (code-api and file-resolve included), diff-view, file-viewer, review, the sonata MIDI file-preview, conversation-view/code/file-pane and network/live: 669 bun:test and 107 vitest passes, 0 fail.
- **Build:** `./singularity build` is green, checks included (build-1792542048-dcg4j1).

### Per site

| Site | Value key | Source / changes | Endpoint | Debt entry |
|---|---|---|---|---|
| diff-view `use-file-diff.ts` (deleted; `DiffView` reads directly) | `code.file-diff` | external, notified (checkout watch: git dir, plus the file and `from` on the working tree; 500 ms throttle; a sha pair holds no watch) | **`getFileDiff` deleted** | removed |
| diff-view `use-diff-tokens.ts` (hidden `fetchEndpoint(getFileContent)` pair) | `code.file` ×2 (list form) | external, notified; a refused side counts as no text | **`getFileContent` deleted** | removed |
| diff-view `diff-view.tsx` expand-lines (hidden `fetchEndpoint` ×2) | `code.file` (the old side, the same tuple as the tokens) | same | (as above) | removed (manifest deleted) |
| file-viewer `use-file-text.ts` (workspace half) | `code.file` | external, notified (a watch of the file on disk; the git dir for a named ref; nothing for a sha) | (as above) | removed (manifest deleted); `use-file-revision.ts` deleted |
| file-viewer image `use-folder-images.ts` (workspace half) | `code.dir` (paged, one 10 000 window) | external, notified (a watch of the folder's entries; git dir for a named ref; 1 s throttle) | **`listCodeDir` deleted** | removed (manifest deleted) |
| sonata MIDI `file-preview/supports.ts` | `file-viewer.bytes` (workspace arm new) | notified (`watchWorkspaceFile`); `reads: workspaceRootReads` | — | — |
| review/code-review `use-push-files.ts` (deleted; `PushBody` reads directly) | `code.push-files` `{worktree, first, last}` | external, immutable (sha range) | **`getPushFiles` deleted** | removed (manifest deleted) |
| review/plugin-changes `use-plugin-changes.ts` | `review.push-plugin-changes` `{first, last}` | external, immutable | **`getPluginChanges` deleted** | removed |
| file-resolve `use-resolved-file.ts` | `code.resolve-file` (top 200 matches + `total`) | external, notified (checkout watch + a watch of the named file; 1 s throttle) | **`resolveFile` deleted**, with file-resolve's whole `server/` (logic moved to `machine/`) | removed (manifest deleted) |

### Live evidence

Everything below ran on `http://att-1791598784-yegtlr.localhost:9000`, in conversation `conv-1791598784-2rzmxq` (this attempt, 6 pushes in its forked DB), driving the `browser_*` session. Shots are in `/tmp/live-migration-shots/B6-*`. The host was loaded the whole time: the build waited about 15 min for a CPU grant and was held for "host under duress" three times, and one pane sat on "Resolving…" behind a "Live updates stalled" toast for about 15 s before it rendered.

- **Review pane, Working tree** (`B6-fresh-diff-before.png`): Code Review lists 105 files, with the scratch file `b6-scratch.txt` as "new +2 −0". Its diff shows the two added lines.
- **Diff highlighting** (`B6-diff-highlighted.png`): `plugins/code-explorer/machine/index.ts` shows as a split diff with shiki tokens on both sides (keywords and strings coloured). The tokens come from the `code.file` pair.
- **Push files** (`B6-push-files.png`): the B3 push tab shows 207 files (+3388 −2094). The `code.push-files` tuple is `{first = last = d9a446a1…}`, a single-commit push.
- **Sha-pinned diff and expand** (`B6-push-diff-sha.png` → `B6-push-diff-expanded.png`): `plugins/config_v2/core/index.ts` in that push first shows its hunk between "↓10 ↓5 25 lines 5↑ 10↑" controls. Clicking "25 lines" shows lines 1–25, highlighted.
- **Commit detail** (`/commit/main/8ed1f4fd28`; `B6-commit-files.png`, `B6-commit-diff.png`): 114 files (+3834 −1406). The expanded `file-explorer/CLAUDE.md` diff renders with its expand controls.
- **File peek, exact path** (`B6-fresh-text-before.png`): `b6-scratch.txt` shows in the Code tab.
- **File peek, Code and Diff tabs** (`B6-file-code.png`, `B6-file-diff-tab.png`): `plugins/code-explorer/machine/index.ts` shows its listing, and the Diff tab (file-viewer's diff renderer → `DiffView`) shows the working-tree diff.
- **Resolved-file link** (`B6-resolved-file.png`): `file/<wt>/file-values.ts` resolves to `machine/internal/file-values.ts`; the breadcrumb is folded and the right content is shown.
- **Ambiguous link** (`B6-resolve-ambiguous.png`): `index.ts` reads "Multiple files match index.ts — the best 200 of 2941 shown", followed by the list.
- **Workspace image and its folder** (`B6-image.png`, `B6-image-folder-before.png`): `b6-imgs/a.png` renders through the workspace image route. Clicking it opens the full-screen viewer reading "1 / 2", which comes from `code.dir`.
- **Plugin changes: not verified live.** `review.plugin-changes.**` is excluded from this composition (`config/plugin-meta/composition/compositions.origin.jsonc`, unchanged here), so neither the section nor `review.push-plugin-changes` is served. Only its tests ran.
- **Freshness (verified, no reload).** For each check, a `window` sentinel was set before the disk change and was still there after it. The scratch files were created under the worktree and deleted afterwards; no tracked file was touched.
  - **Working-tree diff** (`B6-fresh-diff-before.png` → `B6-fresh-diff-after.png`): with the scratch file's diff open, the file was rewritten to three lines ("line two EDITED", "line three"). Within 4 s the diff shows the three added lines. `_debug` shows that `code.file-diff` tuple at version 2. The row header later reads +3 −0.
  - **Code view** (`B6-fresh-text-before.png` → `B6-fresh-text-after.png`): with the file open in the Code tab, it was rewritten to "line one / FRESH VIEW EDIT". Within 3 s the view shows the two new lines and "line three" is gone.
  - **Image folder:** with the viewer open, adding `c.png` made the counter read "1 / 3" within 4 s. Deleting it made it read "1 / 2" again (`B6-image-folder-after-delete.png`; the sentinel set before the delete was kept).
  - **Sha-pinned views do not refetch.** After a later scratch edit and 20 s, the open push diff's tuples were unchanged: `code.file-diff {base 164ecb11…, head d9a446a1…}` and both `code.file` sha tuples stayed at version 1, and the loader counts did not move (file 5, diff 4).
  - **Not driven:** "commit in the checkout" (a named-ref git-dir notify). The integrator may not change the index.
- **`/api/resources/_debug`:** every new key is `external`, with its declared freshness:
  - `notified`: `code.file`, `code.file-diff`, `code.dir`, `code.dir:meta`, `code.resolve-file` and `file-viewer.bytes`. Both `file-viewer.bytes` and `code.resolve-file` carry the `attempts` route (`workspaceRootReads`).
  - `immutable`, with its reason: `code.push-files`.
  - `review.push-plugin-changes` is absent because its plugin is excluded (above).
- **Console:** the only error was one 422, when the scratch file's diff opened. That is the typed `missing` refusal of `code.file` at `ref: main` for a file that is new. It is not a failure, as with B5's 422s.

### Deviations (from the implementers, accepted)
- **One value per read, not a separate value for sha refs.** `code.file`, `code.file-diff` and `code.dir` are `notified`; a tuple pinned to shas just opens no watch, which the run above confirms. (`code.push-files` and `review.push-plugin-changes` were `immutable` until the review fixes; they are now notified through their `pushes` reads.)
- **`code.dir` resolves the workspace in `whileSubscribed`**, because a paged value cannot declare `reads`. The root is held per subscription, and a page read with no holder throws.
- **`code.push-files` and `review.push-plugin-changes` take the push id** (they took `first` / `last` from the client's push window until the review fixes below). A root commit is the `no-base` refusal, where the endpoints returned a 500 / 400.
- **`code.resolve-file` caps matches at 200 and adds `total`;** `FileDisambiguation` says so.
- **Highlighter load failures now surface** (an unhandled rejection) instead of silently leaving the diff unhighlighted. Expansions are tied to the hunks and old-side text they came from, so a live change drops them.
- **A workspace image folder that is missing** shows the file alone; the old 404 threw.
- `supportsMidi` now offers the MIDI tab for workspace `.mid` files (`file-viewer.bytes` reads them).
- **Listing code split** into its own file (`list-dir.ts`), to get past a `no-db-backed-notify` false positive. The scanner matched a parameter `wtPath` to a same-named local in the handler (filed as task-1792544776-e7m6ec). The file first sat in `server/internal/` under the `boundaries/no-platform-api` debt entry; the review moved it to `machine/internal/` (below), so it adds no debt.

### Review fixes (B6)

Thirteen review findings, all applied:

- **Scratch workspaces resolve again** (high). `code.resolve-file` resolves any workspace kind: a non-checkout root answers `exact` for an existing file, otherwise `not-found`, and skips `ls-files`. `not-a-checkout` is gone from its refusals. Its watch is the entry alone when the root is not a checkout. A scratch conversation's file links open the file again, where they used to show an error block.
- **The push range is resolved on the server, from all of a push's rows, by ancestry** (high). `code.push-files` is now `{ worktree, pushId }` and `review.push-plugin-changes` is `{ pushId }`. Both go through code-explorer's `resolvePushRange` (server barrel): every `pushes` row of the push is read straight from the table (no window, no `ensureFresh`, see below), the tip is `git merge-base --independent`, which must be one commit, the earliest is `merge-base --octopus`, and the base is the earliest commit's first parent. A push with more than 100 commits and commits sharing a committer second both get the right range. A commit with no ledger row in the middle of the push still forms one chain. Both values are pushed, `notified` through their declared reads (`pushRangeReads`: the `pushes` table). They are no longer `immutable`, because a row of the push landing moves the range. The review's `Source` and `groupPushes` drop `first` / `last`. The read skips `ensureFresh` because the memo-miss reconcile reads `conversations` (among others), and declaring those would recompute every open push diff on every conversation write. The push id comes from the same table's live collection, so the rows behind it are already there.
- **Reads as of a ref no longer hear the index** (medium). `refChange` (machine `workspace.ts`) keeps HEAD and refs and drops `index` / `index.lock`. It now backs `code.file` and `file-viewer.bytes` at a named ref (through `watchWorkspaceFile`) and `code.dir` at a ref. `code.file-diff` and `code.resolve-file` keep the index. `code.file` gets `throttleMs: 500`.
- **An attempts-table write costs a 304** (low). `code.file` and `file-viewer.bytes` declare `revalidate`. The workspace arm uses `workspaceFileSignature` (machine barrel): the root plus host-fs's `hostPathVersion` stamp on disk, or the blob sha `rev-parse <ref>:<path>` at a ref. The host arm uses `hostPathVersion`. The HTTP path probes the signature before the loader, so the tag is never newer than the bytes.
- **The watch follows the loader's root** (low). All four values' watches open through `watchWorkspaceRoot`. A workspace with no row yet parks its watch until a load (`loadWorkspaceRoot`, which every loader now uses) sees the row, then opens it and notifies once. `workspaceRootReads.reason` now says what moves: the row appearing or going.
- **`.gitignore` edits re-resolve** (medium). `code.resolve-file`'s checkout watch keeps `update`s to `.gitignore`.
- **Platform code out of `server/` debt** (medium). `list-dir.ts`, `get-file-content.ts` and `get-file-diff.ts` moved to `code-explorer/machine/internal/`, and the `/file` tests moved with them (`get-file-content.test.ts`). Their three paths are gone from the `no-platform-api` debt entry.
- **`listPushesByPushId` deleted** (low), with its barrel export.
- **`code.resolve-file` is `load: "on-demand"`** (low), as the B6 decision said.
- **Docs** (low): file-resolve's CLAUDE.md no longer names the deleted `/file` route. `code-values.ts` no longer describes the deleted `file` / `list` routes. code-explorer's CLAUDE.md says `code.resolve-file` is declared in `file-resolve/shared`, and its table states the new push-files addressing, the ref watches and the ETag.
- **Retry on a failed resolve** (low). `ResolvedFileState`'s `error` arm carries the `useLive` read itself, so `file-peek-pane` passes its `refetch`.
- **Scanner false positive filed** (low) as task-1792544776-e7m6ec. It bit again during this review: `watchCheckout`'s `root` parameter matched a `root` local holding a DB read in `loadWorkspaceRoot`, so those locals are now named otherwise, with a comment pointing at the task.
- **Unused barrel exports dropped** (low): `DiffTexts` (diff-view web), `WorkspaceRoot` (code-explorer server), `WorkspaceBytesResult` (code-explorer machine). `resolveParentSha` left the server barrel too, because its only cross-plugin caller now uses `resolvePushRange`.

Verified after the fixes. The check (all checks, after `format`), the tests (code-explorer, file-viewer, diff-view, review, file-pane, tasks-core: 188 pass, 0 fail; code-explorer alone, new files included: 32 pass) and the build (build-1792546196-wldt1g, checks included) are green. Live, in the review pane of `conv-1791598784-2rzmxq`, the B1 push tab lists its files by `pushId`. The two-commit P0 push (`00700d8b…`: rows `9113b3ba` and `fede4366`) lists **270 files +9978 −1856**. That matches `git diff 9113b3ba^ fede4366` (270 files): the range starts at the push's earliest commit, as ancestry orders it.

Tests: `push-range.test.ts` is new. Its commits all share one committer second, its rows come in any order, and it covers a single-commit push, a root push, a missing commit and a gap. The push-files case left `code-values.test.ts`: it now needs the DB, and `pushRangeOf` covers the git half.

**Freshness re-checked after the fixes** on build-1792546196-wldt1g (`build-status.json` ok, no source change since its start). A temporary e2e script under `code-explorer/e2e/` (since deleted) drove `conv-1791598784-2rzmxq` in one headless session. Each step had its own page, booted once, with a `window` marker set after boot; every marker was still there at the end of its step, so nothing reloaded. Scratch files sat under the worktree and were deleted at the end. Shots: `/tmp/live-migration-shots/B6-recheck-*.png`.

1. **Working-tree diff, PASS** (`1-diff-before` → `1-diff-after`). In the review pane, `b6r-scratch.txt` was expanded ("line one / line two"). The file was rewritten to three lines and the diff showed "line two EDITED / line three" **2.6 s** later. One 422 was logged: the typed `missing` refusal of the old side (`code.file` at `HEAD`) for a new file.
2. **Code view, PASS** (`2-code-before` → `2-code-after`). The rewrite showed "FRESH RECHECK EDIT" in **1.7 s**, with "line three" gone. The page made two requests after the change: `code.file` and `code.resolve-file` for that path.
3. **Image folder, PASS** (`3-images-before` / `-added` / `-deleted`). The full-window viewer on `b6r-imgs/a.png` read "1 / 2". Adding `c.png` changed it to "1 / 3" in 1.6 s. Deleting it changed it back to "1 / 2" in 1.3 s.
4. **Resolved file, PASS** (`4-resolved-before` → `4-resolved-after-delete`). The fuzzy name `b6r-fuzzy.txt` resolved to `b6r-dir/deep/b6r-fuzzy.txt`: the breadcrumb read `b6r-dir › deep › b6r-fuzzy.txt` and the text showed. After the folder was deleted, the peek read "File not found." 1.2 s later.
5. **Index writes, PASS: 0 `code.file` requests.** The file was `plugins/code-explorer/machine/index.ts` in its Diff tab, which reads `code.file` at `ref=HEAD` plus the working tree and `code.file-diff`. A plain `git status` on this tree does **not** rewrite the index, because there is nothing to refresh; its mtime did not move. So before each of 4 rounds of `git status` + `git diff --stat`, a clean tracked file's mtime was bumped, without changing its content (`research/2026-07-02-…adr….md`). Each `git status` then rewrote `.git/worktrees/…/index`: **4 index writes**. Over the 11.7 s window, `/api/resources/code.file` got **0** requests. As a positive control, the index-sensitive values did refetch: `code.file-diff` ×4 and `code.resolve-file` ×4, one per write, as designed.
6. **Sha-pinned push diff, PASS: 0 refetches in 20 s** (`6-push-before` → `6-push-after`). The B5 push tab was open on `…/agent-manager/plugins/demo/bin/browser-host.generated.ts`, with tuples `code.file-diff {worktree main, base 1e34f231…, head 8ed1f4fd…}` and the two `code.file` sha tuples. After a scratch edit and 20 s, there were 0 `code.*` requests. Caveat: those tuples name `worktree=main`, while the scratch edit was in this worktree. This shows only that nothing refetched; it does not show that a sha tuple ignores changes in its own checkout.

### Open (B6)
- **`code.push-files` returns the whole file list unpaged** (one fixed answer per push). A very large push makes it big.
- **`needs-machine` wording** for workspace text reuses host-fs's "Browsing this computer's files".
- **Plugin changes** cannot be verified live while `review.plugin-changes.**` is excluded from the composition.
- **No tests cover the watches** behind `code.file` / `code.dir` / `code.resolve-file`, `code.dir`'s held root, or `watchWorkspaceRoot`'s parked watch. Freshness was verified live only.
- **`resolvePushRange`'s DB read has no test** (only `pushRangeOf`, its git half).
- `./singularity exempt list --rule live/no-endpoint-read --debt`: **41** exemptions remain (49 before B6), all debt.

## Result (B7)

Batch B7 covers themes, where a write has to show up in the list the same user is looking at. The saved-theme list and the tweakcn community catalog are now live values read through `useLive`. Every saved-theme write (create, edit, rename, delete, tweakcn import, catalog adopt) answers with its commit's ack token. The caller waits for `saved-themes.list` to confirm that commit before it selects, closes or reports anything; `invalidates:`, `refreshSavedThemes` and the manual `invalidateQueries` are gone. `hydrateEndpoint` and its only helper `hydrateQuery` are deleted from live-state. Verdicts:

- **Check:** after `regen-generated` and `format`, `./singularity check` failed one check, `web-artifacts:map-in-sync`. The deployed dist predated the tree (7 artifacts missing), and a build fixes that. Every other check passed, including type-check, the boundary checks and the plugin docs.
- **Test:** `./singularity test` over theme-engine (saved-themes and theme-gallery included), tweakcn, live-state, infra/endpoints and network/live gave 767 bun:test passes and 249 vitest passes (28 files), with 0 fail.
- **Build:** `./singularity build` is green, checks included (build-1792599258-xjk914).
- **Integrator fix:** `theme-gallery/web/components/rename-theme-dialog.tsx` was the one remaining type error, as both implementers noted. It no longer imports `listSavedThemes` or passes `invalidates:`. It now runs `const { watermark } = await rename.mutateAsync(…); await awaitSavedThemesWrite(watermark);` before `onClose()`. The integrator also fixed theme-engine `CLAUDE.md`, which still named `useEndpointResource` for a source's hook; it now says `useLive`.

### Per site

| Site | Value key | Source / changes | Endpoint | Debt entry |
|---|---|---|---|---|
| saved-themes `web/internal/use-saved-themes.ts` (the resident `ThemeSource`) | `saved-themes.list` (whole list, `unbounded` with a reason, `preload: "boot-and-keep"`) | `db`, routed on `saved_themes` (full map) | **`listSavedThemes` (`GET /api/saved-themes`) deleted** | removed |
| saved-themes `web/boot.ts` (the `Core.Boot` `hydrateEndpoint` task) | (same: boot snapshot via `preload`) | — | — | file deleted |
| saved-themes `web/use-edit-theme.ts` (copy and patch, `invalidates:`) | waits on `saved-themes.list` through `awaitSavedThemesWrite` | — | writes answer `SavedThemeWrite` `{theme, watermark}` | removed |
| saved-themes `web/remove-saved-theme.ts` / `refresh-saved-themes.ts` | `whenNoScopeSelects`, then `awaitSavedThemesWrite` | — | delete answers `{reassigned, watermark}` | `refresh-saved-themes.ts` deleted |
| tweakcn community-browser `web/internal/catalog-source.ts` | `tweakcn.community-catalog` (whole catalog, 522 themes, about 2.1 MB) | external, `fixed` ("a JSON snapshot bundled with the code…") | **`getCatalog` (`GET /api/tweakcn/community/catalog`) deleted**, along with `handle-get-catalog.ts` | removed (manifest deleted) |
| tweakcn `import-by-url.tsx` and catalog `adoptCatalogTheme` | wait on `saved-themes.list` | — | `importTweakcnTheme` / `applyCatalogTheme` answer `SavedThemeWrite` | — |
| theme-gallery `rename-theme-dialog.tsx` (integrator) | waits on `saved-themes.list` | — | `renameSavedTheme` answers `SavedThemeWrite` | — |
| live-state `web/hydrate-endpoint.ts` | — | — | primitive deleted (no caller left) | — |

### Live evidence

Everything below ran on `http://att-1791598784-yegtlr.localhost:9000` (build-1792599258-xjk914), using the `browser_*` session and the screenshot harness. Shots are in `/tmp/live-migration-shots/B7-*`.

- **Gallery, My themes** (`B7-gallery-community-before.png`, `B7-gallery-mythemes-saved.png`). The customizer's Theme section lists the 10 code themes, then every saved tweakcn theme: the 9 rows from the fork, plus the ones adopted during this run. Each has its palette preview. The selected one (Elegant Luxury, "tweakcn · Settings") is outlined.
- **Gallery, Community** (`B7-gallery-community-after.png`). After clicking Community, the cards are Amber Minimal…Clean Slate (saved, marked `tweakcn`) and then catalog entries marked `community`: Cosmic Night, Cyberpunk, Doom 64, Elegant Luxury, Graphite and on. The page text listed about 40 entries in the first rows. The shot shows only the first row; the rest was read from the page text.
- **Quick-theme popover** (`B7-quick-theme-popover.png`). Opened from the action bar's Theme button (clicked through JS, because the collapsed floating bar intercepts pointer clicks; the harness `--click "Theme"` failed for that reason). The My themes / Community tabs and the theme rows are present. The visible rows run Mist…Sonata; the popover text also lists every saved theme through Graphite.
- **Adopting a Community entry selects and paints it, with no missing-theme frame.** "Customize for Settings" was on, so the Settings app has its own scope. Starting from Cyberpunk, clicking the Community "Elegant Luxury" card was sampled every animation frame (1057 frames over 10 s) on `:root`'s `--primary` / `--background`. There were exactly two states: Cyberpunk (`oklch(0.67 0.29 341.41)`) until 1191 ms, then Elegant Luxury (`oklch(0.51 0.19 27.52)`), with no Default frame between them. The `saved-themes.list` ack was noted at 1106 ms, before the paint. The console had no messages.
  - Earlier, with the Settings scope off, adopting Cyberpunk and Graphite saved them and set the selection (`apply` 200 → ack 80 ms later → `config-v2/set-field` 204), but `:root` kept Default. That was **not caused by B7**: selecting the code theme Ink in the same state did not repaint either, and the server-rendered head also painted Default. See Open.
- **Freshness, external writer (verified, no reload).** With My themes open, a `POST /api/saved-themes` (custom, "B7 Fresh Copy", extending Elegant Luxury) was sent from page JS. The card appeared in the gallery **210 ms** after the request started, with no navigation.
- **Read-your-write, rename dialog (verified).** Through the UI's Rename theme → "B7 Renamed Live" → Rename: the dialog closed after **144 ms**, and at that moment the gallery already showed the new label and not the old one.
- **Read-your-write, delete (verified).** Through the UI's Delete theme → confirm ("Neither the desktop nor any app uses it."): the dialog closed and the card was gone at the same moment (**155 ms**).
- **Ack plumbing (verified directly).** Importing the live-state web barrel in the page through its import map, a `POST /api/tweakcn/community/apply {doom-64}` returned watermark `37478794`. Within 4 s `txAcks.has("saved-themes.list", undefined, "37478794")` was true, and the list's floor was `37478795`.
- **Cold load (boot-and-keep).** `GET /api/resources/boot-snapshot` carries `saved-themes.list` with all 13 saved themes. The server-rendered head for `/settings/theme-customizer` paints Elegant Luxury's palette (`--primary: oklch(0.51 0.19 27.52)` in `.dark`). On a cold harness load (`B7-gallery-cold-before.png`, "painted after 1099ms") the page is in Elegant Luxury and the Theme summary reads "Elegant Luxury". The console had no theme or missing warnings. **Not verified:** a frame-by-frame trace from navigation start. The no-flash claim rests on the boot snapshot holding the list and the server head painting the right theme.
- **`/api/resources/_debug`:** `saved-themes.list` is `push`, `policy: routed` (route `saved_themes`, full map, with its reason), `persisted: true`, `subscribers` 1 while the gallery is open, and notify `feed: 1` after a write. `tweakcn.community-catalog` is `external`, freshness `{kind: "fixed", reason: "the catalog is a JSON snapshot bundled with the code: it changes only when the fetch script is re-run and the server redeployed"}`.
- **State left behind.** The worktree's theme config was put back to the base theme `default` / `system`, with the Settings scope removed. Four saved tweakcn themes adopted during the run stay in this worktree's DB: Cyberpunk, Doom 64, Graphite and Elegant Luxury. The custom copy was deleted.

### Deviations (from the implementers, accepted)
- **`awaitSavedThemesWrite` was a local helper** in saved-themes/web, applying optimistic-mutation's Rule A by hand. `useOptimisticResource` can't serve it: it is a per-hook overlay, and its callers (adopt, the painter's resident source) are not React. Lifted in review (see *Review fixes (B7)*): it is now a one-line binding of optimistic-mutation's generic `awaitResourceWrite`.
- **Delete with reassign** no longer holds the list back until every scope has moved off the theme. Ordering holds in practice, because the config reassign notifies in-process before the delete's transaction. It is no longer guaranteed, and a lagging config push would show one `missing-theme` frame (task-1792600740-e0u219).
- **The wait has no timeout.** If the list's subscription is not held, or the ack for a write that changed nothing is lost to the ack cap, the wait lasts until the next full frame. The painter holds the subscription at the root. A read that fails rejects the wait (review fix).
- **`tweakcn.community-catalog` ships the whole catalog (about 2.1 MB) with full `cssVars`.** The old endpoint sent the same payload. A window would change theme-engine's browse `ThemeSource` contract.
- `CatalogThemeSchema` moved to community-browser `shared/resources.ts`, and `CatalogTheme` is now `z.infer` of it.

### Review fixes (B7)
- **The write wait now rejects instead of hanging (fixed).** It is lifted into optimistic-mutation as the generic `awaitResourceWrite(value, [params,] watermark)` (`web/internal/await-resource-write.ts`, exported from the barrel). It confirms with the same Rule A ack / strictly-past-floor test as `useOptimisticResource`, keyed through `resolveOptimisticSource` and `queryKeyFor` rather than a hand-written `[key]`. It rejects with the tuple's query error when the read is failed already or fails before confirming. saved-themes' `awaitSavedThemesWrite` is now a one-line binding of it on `saved-themes.list`, so callers' existing `catch` blocks (rename dialog `setError`, adopt's rejection) report the failure. A lost resubscribe still waits; there is no push signal for that, and a timer would be polling. 6 jsdom tests pin the arms in `optimistic-mutation/web/__tests__/await-resource-write.test.ts`: already reflected, standalone ack, floor equal vs strictly past, params-keyed ack, read fails while waiting, read already failed. `live-state/web` now also exports the `LiveRegistries` type.
- **Delete-with-reassign ordering (comment fixed, structural fix filed).** The `remove-saved-theme.ts` doc comment now says the ordering is assumed, not guaranteed, and that a lagging config push shows one missing-theme frame. task-1792600740-e0u219 tracks it. A server-guaranteed cross-resource order, or a painter that knows about just-deleted ids, is a design change bigger than this batch.
- **Stale docs (fixed):** the theme SKILL's resident-source line now points at `preload: "boot-and-keep"` + `useLive` (`savedThemesList`, `use-saved-themes.ts`), not the deleted `web/boot.ts` / `hydrateEndpoint`. The theme-engine `theme-options.ts` comment no longer says resident sources hydrate via `Core.Boot`. live-state `CLAUDE.md`'s legacy example uses a placeholder instead of the deleted `getCatalog`. optimistic-mutation `CLAUDE.md` gained an *Awaiting a write without an overlay* section.
- **Open items now have task ids:** Settings-scope repaint task-1792600735-hafa9r, catalog payload task-1792600737-rstmby, delete ordering task-1792600740-e0u219. The lift and the test are done, so they need no task.
- **Verdicts:** `./singularity check` before the build failed only the regen/dist checks (`plugins-doc-in-sync`, `plugins-registry-in-sync`, `web-artifacts:map-in-sync`); type-check, the boundaries and lint passed. `./singularity test` over optimistic-mutation, theme-engine and tweakcn gave 51 vitest passes, 0 fail. `./singularity build` is green with checks (build-1792601138-av8ora). Live on that build, a tweakcn `apply {doom-64}` for an already-saved theme returned watermark `37509452`, and `awaitSavedThemesWrite` (now through `awaitResourceWrite`) resolved 163 ms after the response. A screenshot of the customizer gallery (`/tmp/live-migration-shots/B7-review-gallery-before.png`) renders as before; no UI changed.

### Open (B7)
- **Shrink the catalog payload:** compute the palette preview on the server, or page the browse source, instead of shipping 2.1 MB of `cssVars` (task-1792600737-rstmby).
- ~~Lift `awaitSavedThemesWrite`~~ — done in review: optimistic-mutation `awaitResourceWrite`.
- **Base (desktop) selection does not repaint the Settings app when "Customize for Settings" is off.** Seen for a saved theme and for the code theme Ink, both live and in the server head. B7 did not cause it, since the code-theme path is untouched (task-1792600735-hafa9r).
- **Delete-with-reassign ordering** between the config push and the list push is assumed, not guaranteed (task-1792600740-e0u219).
- ~~No automated test covers `awaitSavedThemesWrite`~~ — done in review: `optimistic-mutation/web/__tests__/await-resource-write.test.ts`.
- `./singularity exempt list --rule live/no-endpoint-read --debt`: **38** exemptions remain (41 before B7), all debt.

## Result (B8)

Batch B8 covers third-party lookups: the wallpaper search, the place search and resolve, the bookmark link preview, the deploy analytics report, and mail search and message body. Each now reads through `useLive`. The five GET endpoints (`GET /api/wallpaper/search`, `GET /api/place/search`, `GET /api/place/resolve`, `GET /api/link-preview`, `GET /api/mail/search`), the analytics POST and their handlers are deleted. Mail's hydrate POST stays, but only as the Retry write. Verdicts:

- **Check:** after `regen-generated` and `format` (6 files reformatted), `./singularity check` failed three checks:
  - `migrations-in-sync`: the new `mail_messages.body_fetch_error` column needed a migration.
  - `web-artifacts:map-in-sync`: the deployed dist was stale.
  - `no-db-backed-notify`: the deploy-analytics sanctioned exemption suppressed nothing (see Integration fixes).

  The build fixed the first two.
- **Test:** `./singularity test` over wallpaper, place, bookmark, the deploy-analytics dashboard, mail and network/live gave 725 bun:test passes and 1 fail, plus 165 vitest passes (16 files).
  - The one failure is `mail-core/server/internal/account.test.ts`: "`database.migration-source` has no provider".
  - **B8 did not cause it.** The file is untouched, and it passes alone (4/4). It fails only inside the multi-file run: host-service state leaks between files in one bun process. `places-all.test.ts`, which uses the same `runMigrations` fixture, also passes alone.
- **Build:** green with checks. The first green build (build-1792604494-rdq9ef) generated migration `20261021_174208_76c9b60e__mail_body_fetch_error.sql` (expand: `ADD COLUMN "body_fetch_error" text`). The final build after the Openverse fix is build-1792606114-ucks4l.

### Per site

| Site | Value key | Source / changes | Endpoint | Debt entry |
|---|---|---|---|---|
| wallpaper `web/components/wallpaper-search-panel.tsx` | `wallpaper.search` `{provider, q}` (one provider page, at most 20) | external, `fixed` | `GET /api/wallpaper/search` deleted | removed |
| place `web/components/place-search.tsx` | `place.search` `{providerId, q, session}` (at most 5 suggestions) | external, `fixed` | `GET /api/place/search` deleted | removed (manifest deleted) |
| place `web/internal/use-place-resolve.ts` | `place.resolve` `{providerId, placeId, session}` | external, `fixed` | `GET /api/place/resolve` deleted | removed |
| bookmark `web/components/bookmark-block.tsx` | `bookmark.link-preview` `{url}` | external, `fixed` | `GET /api/link-preview` deleted (`/api/link-meta` kept: an event-handler read for url-paste) | removed (manifest deleted) |
| deploy analytics `web/internal/use-deployment-analytics.ts` (deleted) | `deploy-analytics.report` `{deploymentId, query}` | external, `snapshot` | `POST /api/deploy/analytics/query` deleted | removed |
| mail reading-pane `web/internal/use-hydrated-message.ts` (deleted) | `mail.message-body` `["messageId"]` (`fetching` / `failed` / `ready`) | `db`, routed on `mail_messages` + `mail_attachments`; `whileSubscribed` enqueues `mail.hydrate` | `POST /api/mail/hydrate` kept as the Retry write | removed (manifest deleted) |
| mail search `web/internal/use-mail-search.ts` (deleted) | `mail.search` paged `{q, accountId}` (50 per page, `maxLimit` 300; at most 1000 hits per question, 32 questions held) | external, `fixed` (true only while the question stays in the server's LRU) | `GET /api/mail/search` deleted | removed (manifest deleted) |

### Integration fixes

- **The deploy-analytics `no-db-backed-notify` exemption was dead, so it is removed.** The plugin's `exempt/index.ts` is deleted, and the stale references in `server/internal/served.ts` and the plugin's `CLAUDE.md` are fixed. The loader does read Postgres (the deployment row, then `resolveServerSshTarget`), but the scan cannot see it. `resolveDeployment` reaches the loader as an injected dependency (`queryAnalyticsOverSsh({ resolveDeployment, sshRun }, …)`), not as a call the scan follows. So the exemption suppressed nothing, and the check required deleting it. The `CLAUDE.md` now records why the read is invisible. This is a blind spot in the scan (see Open).
- **Openverse `PAGE_SIZE` changed from 30 to 20. This bug predates B8; the code at HEAD already asked for 30.** Openverse answers `page_size=30` from an anonymous client with `401 {"detail":"page_size may not exceed 20 for anonymous requests"}`, which a curl confirmed. The provider maps 401 to the `rate-limited` refusal. So the picker always said "Openverse is rate-limiting anonymous requests…", and no search had ever worked. The `wallpaper.search` doc comment now says 20.

### Live evidence

Everything below ran on `http://att-1791598784-yegtlr.localhost:9000`, using the `browser_*` session. Shots are in `/tmp/live-migration-shots/B8-*`.

- **Place search (verified, happy path).** Google Maps is configured in this worktree. In a new page, a `/place` block was added and "Louvre Museum" typed into it (`B8-place-search.png`). The list showed five suggestions: Louvre Museum (Paris, France), Louvre Abu Dhabi, Japon Louvre Sculpture Museum, The Museum of Fine Arts Houston, and Museum Café Louvre. The network log has one `GET /api/resources/place.search?providerId=google&q=Louvre+Museum&session=…`, so the debounce held.
- **Place resolve (verified).** Picking the first suggestion made one `GET /api/resources/place.resolve?…placeId=ChIJD3uTd9hx5kcR1IQvGfr8dbk&session=<same>`. The block shows "Louvre Museum · Art museum · 75001 Paris, France" with the museum icon (`B8-place-resolved.png`). There was no second resolve after the session rotated.
- **Bookmark preview (verified).** A `/bookmark` block was given `https://github.com/anthropics/claude-code` and made one `GET /api/resources/bookmark.link-preview?url=…`. The card shows the GitHub favicon and site name, the title "GitHub - anthropics/claude-code: Claude Code is an agentic coding tool…", the description, `github.com`, and the og:image (`B8-bookmark-preview.png`). The `blocked` refusal was checked by curl: `url=http://127.0.0.1/` returns `{"reason":"refused","code":"blocked","detail":"URL host is not allowed: 127.0.0.1"}`.
- **Fixed lookups do not refetch on remount (verified for place and bookmark).** The network log was cleared, then the page was navigated away from and back to. After 5 s it showed zero `place.*` or `bookmark.link-preview` requests, and both blocks rendered from their copied data (`B8-page-remount.png`).
- **Deploy analytics (verified: the read and Refresh; the report itself did not render).** Expanding Analytics on `/deploy/dep/dpl-1785501087837-xkt5u5` made one `GET /api/resources/deploy-analytics.report?q={deploymentId, query:{compare:true, filters:[], range:"30d"}}`. The SSH read reached the box. The answer is the `unreadable-answer` arm: "The site answered, but not with an analytics report. Not an analytics result: report.rows.event_prop: Required" (`B8-deploy-analytics.png`).
  - **B8 did not cause this.** `event_prop` came in 888f81ccce (2026-10-20, collect plugin, untouched by B8), and the deployed site predates it.
  - Clicking Refresh (↻) made exactly one new `GET` of the same key after 12 s. A snapshot re-reads when asked.
  - The happy path (charts drawn) was **not exercised**.
- **Mail: only the refusal and missing UI were exercised. The Gmail happy path was not.** The worktree's Gmail token is unavailable: the banner says "Gmail token unavailable: Unable to connect…", and `mail_messages` has 0 rows (the corpus is left out of forks).
  - `/mail/search`, searching "invoice", gives a DataView chrome (Results tab, search, filter, sort) and "Couldn't load: Connect Gmail to search your mailbox." This is the `not-connected` refusal, with no Retry (`B8-mail-search-not-connected.png`).
  - `/mail/search/m/msg-doesnotexist` shows "This message is not in the local mailbox." (`B8-mail-message-missing.png`). It is rendered by the `threadMessages` row lookup's not-found branch (`mail-message-reader.tsx`); the `mail.message-body` `missing` refusal is unreachable from this pane (its only reader mounts only when the row is found) and was not exercised.
  - **Not verified:** a search returning threads, page 2 on scroll, opening a message body (`fetching` → `ready`), and starred/read toggles updating a result row without a re-search.
- **Wallpaper search: the happy path was not exercised.**
  - Before the `PAGE_SIZE` fix, typing "mountain lake" in the Openverse tab gave "Couldn't load: Openverse is rate-limiting anonymous requests right now…" with no Retry (`B8-wallpaper-ratelimited.png`), which is the 401 above.
  - After the fix, the read failed with "Couldn't load: Resource wallpaper.search fetch failed: 500 (loader-failed)" plus a Retry button, and a "loader failed for wallpaper.search: The operation timed out" crash toast (`B8-wallpaper-timeout.png`).
  - Openverse itself was not answering from this host: three direct curls with `page_size=20` each timed out at 25 s.
  - The `unknown-provider` refusal was checked by curl (`provider=nope` returns `{"reason":"refused","code":"unknown-provider",…}`).
- **Freshness.** Every new external value is `fixed` (no change signal), except deploy analytics, which is `snapshot` (re-read on Refresh, verified above). `mail.message-body` is `db`-routed. The planned live freshness check, a `fetching` → `ready` push when the hydrate job writes the body, needs a Gmail connection and **was not driven**.
- **`/api/resources/_debug`** (verified): every new key is present, with its declared freshness:
  - `wallpaper.search`, `place.search`, `place.resolve` and `bookmark.link-preview`: `policy: external`, `externalSource: true`, freshness `{kind: "fixed", reason: …}`.
  - `mail.search`: `mode: keyed`, external, `fixed`.
  - `deploy-analytics.report`: external, freshness `{kind: "snapshot", reason: "the deployed site's report, read over SSH…"}`.
  - `mail.message-body`: `mode: push`, `policy: routed`, routes `mail_messages` and `mail_attachments` (full map, with a reason).
- **State left behind:** a scratch page `block-14311e05-b7a6-4fc9-9ed2-00eb8d986bd7` ("Untitled") in this worktree's DB, holding the Louvre place block and the github bookmark block.

### Deviations (from the implementers, accepted)

- Place resolve and bookmark preview are `fixed`, not snapshot + refresh. Place has three new refusals (`not-configured`, `quota`, `not-found`), which used to arrive as 500s. When search is refused `not-configured`, it renders the provider's `AccessAction`.
- Deploy analytics keeps its Postgres read inside the external snapshot loader. The SSH key and the pinned host key may only be read server-side at SSH time. The core file is renamed `endpoints.ts` → `analytics.ts`. Questions are bounded by `FILTERS_MAX_BYTES` (1536) and `MAX_FILTERS` (8).
- Mail search rows are now thread-level (`ThreadRow` over `useLive(mailThreads, { ids })`). The per-row label chips and the matched-count pill are gone. The question carries `accountId`. The search loader upserts the envelopes it sees, under a **sanctioned** `no-db-backed-notify` exemption in `mail/sync/exempt/index.ts`: the write helper's `recomputeThread` re-reads message rows, but the answer itself comes only from Gmail. The search body keeps the previous rows on screen while the id set changes.
- New column `mail_messages.body_fetch_error`, and a new `mail.hydrate` job (one attempt).
- **Bookmark preview and place resolve were pulled forward from B10** (the P0.2 hidden reads), since they are third-party lookups like the rest of B8.
- **Mail search does not follow the planned page-token design.** The plan said each page returns ranked thread ids plus Gmail's page token, and a thread on two pages is folded on the client over the live rows. Instead `remote-search.ts` holds each question's answer server-side in an in-process LRU (32 × at most 1000 hits), cuts pages by a synthetic zero-padded `rank` (a key-range page needs a position to cut at, which Gmail's opaque forward-only token is not), folds a thread on two Gmail pages on the server (the `seen` set, ranked where it first appeared), and never exposes the page token. Caveat as landed: `fixed` held only while the question stayed in that process's LRU — after an eviction or a restart a later page re-walked Gmail and ranks could shift. The review fixes scope the held answer to a per-search `round` and refuse an evicted round's later page `expired` (see Review fixes (B8)).

### Review fixes (B8)

All 15 verified findings were applied. None was skipped. The two duplicates (the `openverse-panel.tsx` comment) were fixed once.

- **Throttling is a failure, not a refusal.** The Openverse 401/429 and the Google Places 429 now throw a plain Error, so the read's error offers Retry. Before, they were refusals: never retried, cached as refused, and drawn with no Retry. `rate-limited` is dropped from `wallpaper.search`'s refusals, and `quota` from `PLACE_LOOKUP_REFUSALS`. Place now has two new refusals (`not-configured`, `not-found`), not three as the Deviations above say. Trade-off: Openverse's message no longer reaches the reader, since only `loader-failed` crosses the wire, and a throttle is reported as a server failure (task-1792607427-a4c7li).
- **Place `not-configured` always shows its message.** `place-search.tsx` draws `ResourceErrorInline` with the provider's `AccessAction` beside it, never in its place. `MapsAccessAction` draws nothing while the client believes Places ready, which used to leave the refusal invisible.
- **`mail.search` is scoped to a search round.** `MailSearchQuery` gains `round`, a token `SearchResults` mints with `crypto.randomUUID()` on mount and on "Search again". It is part of the server's `questionKey`, so the same query typed again is a new tuple and asks Gmail again. The deleted endpoint asked on every call, and the round restores that; before this fix a held answer was served until restart or LRU eviction. The `fixed` reason now says the answer is held per round.
- **An evicted round's later page is refused `expired`.** It is no longer silently re-ranked: `answerFor(key, after)` throws when `after` is set and the round is no longer held. `expired` is a new declared refusal.
- **Mail search refusals with a fix get their fix.** `not-connected` renders the server's message, `GmailAccessAction reconnect` and "Search again". `expired` renders the message and "Search again". `SearchResults` is also keyed on `useGmailAccess().ready`, so a reconnect that flips it starts a new round. `invalid-cut` stays the list's error.
- **One body-state component.** The new `mail/sync/web` barrel exports `MessageBodyState({ messageId, loadingLabel?, ready })`: the `mail.message-body` loading, fetching and failed (Retry) states. The reading pane's `MessageBody` and the search reader's `MessageText` both render through it, and both copies of `FetchFailed` are deleted.
- **Typed token error.** `GmailTokenUnavailableError` lives in `mail-core/core`, so the pure `classify-error.ts` can import it without the server barrel. `requireGmailToken` throws it. `classify-error.ts` and `remote-search.ts` test it with `instanceof` instead of matching the message prefix, and the test builds one.
- **Deploy analytics' undeclared read.** No exemption can be restored until the check follows injected dependencies (task-1792607417-zpzsb4). The `served.ts` comment now says the read is undeclared, that only `snapshot` keeps it honest, not to copy the loader into a `fixed` value, and points to the task.
- **Doc fixes:**
  - "four GET endpoints" is now the five, named.
  - Bookmark preview and place resolve are marked "done in B8" in P0.2 and B10, with a Deviations line.
  - The mail-search page-token deviation is recorded (server-held answer, rank-cut paging, server-side thread fold, and the caveat as landed).
  - The "not in the local mailbox" hedge is resolved: it is the `threadMessages` row lookup's not-found branch, and the `missing` refusal is unreachable from that pane.
  - Each Open item cites its task.
  - The `openverse-panel.tsx` comment names the `wallpaperSearch` live read.
- **Verdicts:**
  - **Build:** the first build failed `type-check`: `SearchResults` typed `accountId` as `string` instead of the branded id, and `switch-exhaustiveness-check` caught a `default`. After fixing both, the build is green with checks (build-1792607789-eik0rn). A standalone `./singularity check` run after the doc edits failed only `web-artifacts:map-in-sync` (stale dist). The final rebuild, build-1792608479-obyvop, is green with checks.
  - **Check:** the standalone `./singularity check` is green after the first green build, and green again inside the final build.
  - **Test:** `./singularity test` over mail, wallpaper, place and the deploy-analytics dashboard gave 108 bun:test passes and 1 fail, plus 58 vitest passes (6 files).
    - The one failure is the known `mail-core/account.test.ts` multi-file isolation failure ("`database.migration-source` has no provider"). It passes alone (4/4) (task-1792607424-fx037r).
- **Live:**
  - `/mail/search` with "invoice", on this worktree's unavailable Gmail token, now shows "Connect Gmail to search your mailbox." with Grant Gmail access and Search again (`B8-review-mail-search-not-connected.png`).
  - The read carries `round` (`GET /api/resources/mail.search?q={accountId,q:"invoice",round:"2eb2…"}` returns 422). Clicking Search again issued a new GET with another round (`52f2…`).
  - Wallpaper search: Openverse still times out from this host (a direct curl timed out at 25 s), so `wallpaper.search` answers 500 `loader-failed`, which is the Retry arm. The throttle path itself was not exercised.
  - Place search with a `not-configured` refusal was not exercised: Maps is configured here.

### Open (B8)

- **`no-db-backed-notify` cannot see a DB read reached through an injected dependency** (deploy-analytics `resolveDeployment` passed as `{ resolveDeployment, sshRun }`). The read is honest here, but the scan has a blind spot. It should follow a function passed by reference as a property, or the value should declare its reads (task-1792607417-zpzsb4; `served.ts` points to it).
- **Openverse:** the happy path is still unverified (Openverse timed out from this host). The provider still treats any 401 as throttling (now a failure, not the `rate-limited` refusal — see Review fixes). That is wrong for other 401 causes, such as a missing User-Agent or this page-size cap (task-1792607422-4xya4k).
- **Gmail happy paths unverified:** search results and paging, the message body, and freshness on starred/read toggles. They need a connected Gmail account.
- **Deploy analytics:** the deployed site's collect predates `event_prop`, so the report is `unreadable-answer` until the site is redeployed.
- **`useLive(c, { ids })` should keep the previous rows itself** while the id set changes. Mail search does it by hand for now (task-1792607420-9mxb97; the hold in `mail-search-body.tsx` points to it).
- **The `mail-core/account.test.ts` isolation failure** in a multi-file bun run: host-service state leaks across files. B8 did not cause it (task-1792607424-fx037r).
- `./singularity exempt list --rule live/no-endpoint-read --debt`: **31** exemptions remain (38 before B8), all debt.

## Result (B9)

Batch B9 covers the interim Stats values: Cost (8 sites), Commits (4), Pushes (3) and Tasks (2). All 17 sites now read through `useLive`; their 17 GET endpoints, handlers and `shared/endpoints.ts` files are deleted, and so are the `exempt/` manifests of commits, pushes and tasks (cost keeps its manifest for the unrelated `boundaries/no-platform-api` debt). Verdicts:

- **Check:** after `regen-generated` and `format` (16 files reformatted), `./singularity check` failed only `web-artifacts:map-in-sync` (the deployed dist was stale). The build fixed it.
- **Test:** `./singularity test plugins/stats plugins/conversations/plugins/conversation-category plugins/network/plugins/live` gave 701 bun:test passes, 1 fail and 107 vitest passes (10 files). A re-run of `plugins/stats` after the integration fixes gave 71 passes and the same 1 fail.
  - The failure is `stats/cost/server/internal/price-table.test.ts` › "every baseline model resolves by exact key": the vendored `litellm-fallback.json` has no exact key for one baseline model. **B9 did not cause it**: the test and the JSON are untouched since the merge-base, and nothing B9 changed is on its path.
- **Build:** green with checks (build-1792631420-89m8i0). The builds after the integration fixes are also green with checks: build-1792634367-0amwn9, then build-1792635198-tdhtcv (final).

### Per site

| Site(s) | Value key | Source / changes | Endpoint | Debt |
|---|---|---|---|---|
| cost: `daily-cost-chart`, `token-mix-chart`, `cumulative-cost-chart`, `cost-kpis` | `stats.cost.daily` `{scope}` | external `notified` (transcript dir watch coalesced to one notify per 30 s, `onPriceTableUpdated`, capture) | `/daily`, `/token-mix`, `/cumulative`, `/totals` deleted | removed |
| cost: `model-usage-chart`, `avg-cost-per-conversation-chart` | `stats.cost.sessions-daily` `{scope}` | same | `/daily-by-family`, `/avg-per-conversation` deleted | removed |
| cost: `cost-distribution-chart` | `stats.cost.distribution` `{scope}` | same | `/distribution` deleted | removed |
| cost: `top-conversations-table` | `stats.cost.top-sessions` `{scope}` (top 50), plus the lookup collection `stats.cost.session-conversations:rows` | same; the lookup is routed (identity) on `conversations` | `/sessions` deleted | removed |
| commits: `cumulative-chart`, `rate-chart` | `stats.commits.counts` (typed query `{series, dedup}`, on-demand, `needsMachine`) | external `notified`, `recomputeOn: [refHeadServed]` | `GET /api/stats/commits/cumulative`, `/rate` deleted | removed (manifest deleted) |
| commits: `commits-category-charts` | `stats.commits.counts-by-category` (`+ categoryId`) | same, plus `reads: conversation_categories` (full) and a category-config watch | (same endpoints) | removed |
| commits: `lines-charts` (4 charts) | `stats.commits.lines`, `stats.commits.lines-by-ext` | same, plus a commits-config watch (excluded paths); the manual `invalidateQueries` is gone | `/lines/cumulative`, `/lines/rate` deleted | removed |
| pushes: `wait-time-chart`, `throughput-chart`, `step-breakdown-chart` | `stats.pushes.wait-time` / `.throughput` / `.step-breakdown` `{bucket}` (`needsMachine`, served from `machine/`) | `db`, routed `full` on `op_log_ops`, `throttleMs: 5000` | 3 GETs deleted | removed (manifest deleted) |
| tasks: `tasks-cumulative-chart`, `tasks-velocity-chart` | `stats.tasks.history` (one row per UTC day, `unbounded` with a reason) | `db`, relation read `tasks_v` (bases: tasks, attempts, attempt_deliveries, conversations, pushes, task_dependencies), `throttleMs: 1000` | `/cumulative`, `/daily` deleted | removed (manifest deleted) |

### Integration fixes

- **Cost rebuilt its bundle about 18 times a minute; now about once per 30 s.** The implementer bounded the rebuild with `throttleMs: 30_000` on the four cost values. But the runtime's `debounceMs` (which `throttleMs` compiles to) is drained early by any other entry's flush (`drainEntry`'s piggyback, documented on `debounceMs`). On a busy server that happens constantly, so the throttle bounded nothing.
  - Measured on the first build: `stats.cost.daily` had 135 loads in about 7.5 min (`ratePerMin` 18.1) and 267 hand notifies; the slowest load took 6.4 s.
  - Each holder's dir-watch callback also bumped the generation on its own, so one transcript write invalidated the memo once per subscribed value.
  - **Fix** (`cost/server/internal/load-usage.ts`): transcript writes are coalesced at the source. Every holder's watch callback lands in one `transcriptsWritten()`, which marks the corpus index dirty and arms one trailing 30 s window. When the window ends, the generation bumps once and every holder is notified. The window is cleared at the last unsubscribe. The `throttleMs` is removed from `served.ts`, and the comments and the plugin's `CLAUDE.md` say why.
  - **After the fix:** 2 hand notifies and 3 loads in 2.5 min (`ratePerMin` 0.9) while agents were writing transcripts.
- **The Tasks velocity bars had vanished; they are visible again.** Each bar was 0.033 px wide: about 157 days on an 800 px axis gives a 5.08 px band, and recharts' default 4 px gap between the two bar groups then leaves each bar `(5.08 − 2·0.51 − 4) / 2` px. Recharts drops the gap only once it no longer fits at all. Main's old chart was saved by chance: its 167 days give a 4.78 px band, which is past that threshold, so its bars draw at 1 px. The fix is `barGap={1}` on the velocity `ComposedChart`; bars now draw at 1 px, as on main.
- **Out-of-scope edit accepted:** the commits implementer exported `conversationCategoriesEntity` from `conversations/conversation-category/server` so the by-category value can declare `reads`. It is a one-line barrel export with no other consumer.

### Live evidence

Everything below ran on `http://att-1791598784-yegtlr.localhost:9000/agents/stats`, using the `browser_*` session. Shots are in `/tmp/live-migration-shots/B9-*`. Before main's endpoints were touched, its old answers were captured by curl into `/tmp/b9-main/`.

- **Cost (verified, numbers equal main).** The KPI cards under "Singularity only" show Total spent $27,196.91, Total tokens 36.9B (2,139 sessions), Last 7 days $2,433.33, Avg / active day $251.82 over 108 days, Input 4.4M, Output 111.2M, Cache creation 967.8M and Cache read 35.9B. These are byte-equal to main's `GET /api/stats/cost/totals?scope=singularity`.
  - The distribution buckets are identical to main's, all 16 (for example `< $0.01` 96, `$2–5` 405, `$500–1k` 1).
  - The top table's first rows match main's `/sessions`: $951.67, $279.64, $252.68, each with its title and status.
  - The daily-by-model, sessions-per-family, cumulative, token-mix and average-per-conversation charts all render with data (`B9-cost-kpis-daily-cumulative.png`, `B9-cost-tokenmix-avg.png`, `B9-cost-distribution-top.png`).
- **Commits (verified, numbers equal main up to today's new commits).** The cumulative series has 171 days, identical to main's `/commits/cumulative` except 2026-10-22: 4,942 here against main's 4,939, because 3 commits landed on main between the two captures.
  - Lines cumulative on 2026-10-21 is +2,562,925 / −823,826 on both.
  - Shots: `B9-commits.png` (over time and per day), `B9-commits-by-category.png` (Type and Category stacked areas, the per-period stack) and `B9-lines.png`.
  - The first load showed "Loading…" for over 20 s. Its four HTTP reads answered **502** at the gateway, and the client's retry succeeded. `loaderStats.maxMs` was 91 s for `git log` under host duress (see Open).
- **Pushes (verified, numbers equal main on every shared day).** Throughput, wait time and step breakdown with `bucket=day` equal main's old endpoints on all 29 shared days except today (3 newer pushes) (`B9-pushes.png`). The worktree also holds 2026-09-09 → 09-21, which main's 30-day retention has already pruned (see Open).
- **Tasks (verified, day counts equal main before the fork).** The values equal main's old `/tasks/daily` on 153 of 155 shared days. The two that differ, 2026-10-09 and 10-10, are at the fork boundary: tasks completed on main after this DB was forked.
  - Totals: 5,198 added, 3,608 completed, 1,202 dropped.
  - Shots: `B9-tasks.png` (before the velocity fix, bars invisible), `B9-tasks-velocity-fixed.png` (after), and main's chart for reference in `B9-main-tasks-reference.png`.
- **Freshness:**
  - **Tasks (driven, verified in the UI).** With Stats open, a task was created in a second tab (`task-1792635028-w9tk95`, "Untitled"). Without a reload, both charts' x axis moved from ending 2026-10-12 to ending 2026-10-22 (`B9-tasks-after-create.png`). `_debug` showed `stats-tasks.history` with `feed: 1` and version 1 → 2.
  - **Commits, config edge (driven, verified).** Toggling the `research/` excluded-path chip off re-read both lines tuples without a reload: the cumulative axis moved 2.7M → 3.2M, and added on 2026-10-21 went 2,562,925 → 3,000,346 (`B9-lines-after-config-toggle.png`). The chip was toggled back.
  - **Commits, ref advance (inferred, not seen in the UI).** `stats.commits.counts` reached version 2 on its two tuples while main advanced (ecc26a7716). It has no other change source, so the bump came from its only edge, `git-watcher.refHead`. No advance happened while the final build's page was open.
  - **Cost (verified through `_debug`).** With agents writing transcripts, the four values took 2 hand notifies in 2.5 min (versions 1 → 3). The singularity-scope numbers do not move between captures, because a new session is classified by the archive, which is captured daily. This was already true before B9: main's old endpoint shows the same frozen total. The `all` scope moves: today's cost went 158.12 → 170.99 between two reads.
  - **Pushes (verified through `_debug`).** `routed`, route `op_log_ops` (`full`, with its reason), 14 feed notifies and versions 1 → 14 while pushes landed.
- **`/api/resources/_debug` (verified).** Every new key is present with its declared freshness:
  - `stats.cost.{daily,sessions-daily,distribution,top-sessions}`: `push`, external, `{kind: "notified"}`.
  - `stats.cost.session-conversations:rows`: `keyed`, routed, identity on `conversations`.
  - `stats.commits.{counts,counts-by-category,lines,lines-by-ext}`: `invalidate` (on-demand), external, `notified`, `dependsOn: ["git-watcher.refHead"]`. By-category also has `full` on `conversation_categories`.
  - `stats-pushes.*`: `push`, routed, `full` on `op_log_ops`.
  - `stats-tasks.history`: `push`, routed, relation read `tasks_v` with its six bases.
- **State left behind:** the "Untitled" task `task-1792635028-w9tk95` in this worktree's DB.

### Deviations (from the implementers, accepted)

- **Cost:**
  - It is 4 values plus a lookup collection, not one value per chart.
  - Titles come from a new lookup collection keyed by `claudeSessionId`.
  - Cumulative, KPI and 7-day averages are derived in the browser (`shared/derive.ts`).
  - `scope` is now required.
  - It stays in `server/` rather than `machine/` (existing split debt task-1792338443-riwqev).
  - The metrics P2 doc says P2 deletes these keys.
- **Commits:**
  - It is 4 typed-query values, not 2.
  - Point keys are `x`.
  - Serving moved to a new `machine/` folder (`server/` only registers the config).
  - The `git log` cache is keyed by HEAD sha and excluded paths.
  - `git log` failures are loud (`spawnExpectOk`).
  - A bug that predates B9 is fixed: `deduplicateByPushId` wrote rebase-filtered sums back into the cached parse.
- **Pushes:**
  - Served from `machine/` (`server/` deleted).
  - `bucket` is a required typed param.
  - A new 5 s throttle.
- **Tasks:** the cumulative chart is now one point per day (it was one per minute). The end-of-day totals equal the old chart's. This is deliberate, and the `tasksHistory` doc says so.
- **Integration:** the cost throttle is replaced by the source-side coalescing above.

### Open (B9)

- **`throttleMs` is no rate limit on a busy server** (task-1792636104-uyhq3k). The runtime drains a throttled entry whenever any other entry flushes. Cost now coalesces at the source. The pushes (5 s), tasks (1 s) and commits-by-category (2 s) throttles have the same weakness; their loaders are cheap (≤ 300 ms), so it costs little there.
- **Commits under host duress:** a cold `git log` parse took 91 s, and the gateway answered the first on-demand HTTP reads with 502 before the client's retry succeeded. The old endpoint paid the same parse, but behind a 30 s TTL. A memo warmed on ref advance would keep the first read from paying for it (task-1792636107-t4nqnp).
- **Cost "Singularity only" freshness is daily:** classification comes from the archive capture. This predates B9.
- **The `price-table.test.ts` baseline failure** predates B9 and is unrelated to it.
- `./singularity exempt list --rule live/no-endpoint-read --debt`: **14** exemptions remain (31 before B9), all debt.

### Review fixes (B9)

The review's 15 findings were all applied. Verdicts after the fixes:

- **Check:** `./singularity check` green.
- **Test:** `./singularity test plugins/stats plugins/infra/plugins/corpus-index plugins/debug/plugins/health-monitor` gave 97 passes and 1 fail across 12 files. The fail is the same `price-table.test.ts` › "every baseline model resolves by exact key", which predates B9. A new corpus-index test covers `onChange` / `watching()`.
- **Build:** green with checks (build-1792636798-sgqfv0). The first build failed on two things this review introduced: the seeded DataView config, and a `status === "ready"` collapse that `no-ready-negation` / `no-pending-data-collapse` rejected. Both were fixed.
- **Screenshot:** `/tmp/live-migration-shots/B9-review-top-dataview.png` shows Top conversations as a DataView table. Its first rows are $951.67, $279.64 and $252.68, the same as before. With the page open for 45 s, every Stats chart rendered with no "Loading…" and no error. The KPIs read Total $27,202.98 and Last 7 days $2,439.40.
  - The headless `screenshot.ts` run failed on its network-idle wait: the four commits reads were still on the cold `git log` parse just after the restart (task-1792636107-t4nqnp). The page itself was then checked through the `browser_*` session.

What changed, per finding:

- **Tasks are now one point per day.** This is kept, and written down as a deliberate shape change in the `tasksHistory` doc (`tasks/shared/values.ts`) and under Deviations.
- **The Cost "Last 7 days" window moves with the date.** `cost-kpis.tsx` now reads `useUtcDay()` (new, `cost/web/components/use-utc-day.ts`). It is UTC midnight, re-armed by one timer at the next UTC midnight. Before, the cutoff was frozen when the card mounted.
- **A failed cost build drops only its own memo entry.** `buildReadBundle` clears the memo only when it still holds its own entry (`memo === self()`), so a newer generation's build is kept.
- **One corpus watch per process on main.** `infra/corpus-index` gains `watching()` and `onChange(listener)`. A listener fires after any `ensureFresh` whose delta moved a file. While the index's watcher runs, `watchCostInputs` subscribes to that instead of opening a second recursive dir-hub watch. Worktrees, and main before its warm-up, still use `acquireDirWatch`.
- **The first-subscriber gap is closed.** Once the watches are open, if this holder was the first and a load ran since the bump (`memo.generation === generation`), the index is marked dirty and every holder is notified. A write landing while the watches were opening is no longer missed.
- **The price table is now tracked on every backend; the archive is documented.**
  - A backend other than the host singleton now watches `price-table.json` (dir hub, `children` scope on the cost-usage dir). When it changes, the backend reloads the table and notifies.
  - The read-path block in `load-usage.ts` states that a worktree's archive is fixed for the life of the process. Main's later captures do not reach it.
- **The metrics plan doc is corrected.** The P2 row now deletes the interim values: `stats.tasks.history`, `stats.commits.*` and `stats.cost.*`. The old endpoints are already gone. The interim row lists every key per sub-plugin. P3 deletes `stats.pushes.*`. Each row has a "no key remains" acceptance criterion.
- **Top conversations is a DataView.** It uses `defineDataView("stats.cost.top-sessions")`, a table view authored in `config/stats/cost/stats.cost.top-sessions.jsonc` (sorted by cost, descending), `readiness` = the conversations lookup, and `rowActivation` = a link to the conversation pane.
- **There is one Stats chart frame.**
  - `LiveChart` (exported from `stats/commits/web`) takes `read`, `subject`, `isEmpty?`, `emptyText` and `size`. It is now used by all 17 sites and by Responsiveness.
  - `ChartState` lost its dead `error` / `loading` props. It is now an empty gate with a required `emptyText`; `LiveChart` and health-monitor use it. The empty text is per chart ("No pushes yet.", "No tasks yet.", "No cost recorded yet.", …), which fixes "No commits yet." on the Cost and Tasks charts.
  - `PushChartFrame` no longer frames the read itself. It is the title plus the gap fill over `LiveChart`.
- **No more duplicate scope types.** `Scope` is deleted from `load-usage.ts`, and `use-scope.ts` is typed with `CostScope`.
- **Stale comments are fixed.** `archive.ts` no longer names `ConvMeta`, and `load-usage.ts` says "a value loader", not "a request handler".
- **The pushes bound text is corrected.** It now says one point per bucket within the op store's retention sweep, with no exact maximum (a fork lags its own sweep). This was fixed in `shared/values.ts` and the plugin's CLAUDE.md, and the item is removed from Open.
- **The new debt is tracked.** The `throttleMs` drain is task-1792636104-uyhq3k and the commits cold parse is task-1792636107-t4nqnp. Both are cited in Open.
- **The keys and modules are consistent.** The keys are now `stats.pushes.*` and `stats.tasks.history`; the span labels follow. The value modules are `shared/values.ts` in all four sub-plugins (cost's `live.ts` and tasks' `history.ts` were renamed).
- **The commits parse cache is bounded.** A read at a new HEAD drops every parse taken at another HEAD. At most 2 excluded-path combinations are kept (least recently read dropped first), plus the unfiltered parse.
