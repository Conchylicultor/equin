# A bound on every list `useLive` reads, whatever its source

Parent: `research/2026-10-11-global-endpoint-reads-onto-live.md` (B3). Plugin: `plugins/network/plugins/live`.

## Context

`network/live` promises that every read is bounded, but the promise holds only for reads served from the change feed:

1. **Paging a Postgres table is tied to the change feed.** `serveCollection`'s compiled SQL arm (the filter language, `$key` cuts, `:groups`, `:count`, joins) is registered only as a routed resource. A table outside the feed (`graphile_worker.*` behind `jobs-list`, any `ExcludeFromChangeFeed` table without a producer) has no bounded read. Its only form is a value loading the whole table.
2. **External values carry no bound rule.** `BoundArm` (`core/internal/compile-value.ts:200-216`) asks for `unbounded: { reason }` only on `source: "db"`, and only for a top-level array or record. Its comment says "an in-memory array is bounded by the process that holds it", which is false. Nested lists (`release.run-logs`) and hard caps nobody declared (`jobs-list`, 500 rows) slip through.

**Mental model.** A live read answers two independent questions:

- **Shape**: how much of the list the browser holds at once.
- **Freshness**: how the server learns that the answer changed.

The shape is declared once, on the declaration in `core/`, inside the schema, whatever the source. Every list is exactly one of:

- **paged**: key-range pages, as today;
- **capped**: a checked `max`;
- **whole**: loaded entire, with a written reason.

The freshness is the serve call's `changes`: the feed (the default for the SQL arm), `"notified"`, `{ fixed }`, `{ immutable }` or `{ snapshot }`. It never decides the shape. There is no new hook: the reader is `useLive`, unchanged.

**Outcome:** every list the browser reads loads a bounded window at a time or carries a written reason it loads whole. Declaring a list without a bound is refused at declaration, on every host (worktree, central, browser server).

## API

### Shape: markers in the schema

A new core-only package, `plugins/packages/plugins/list-bound/core`, depends on zod only. That lets an item schema in any plugin carry its bound without depending on `network/live`.

```ts
cappedList(item, { max: 500 })          // = z.array(item).max(500); a native .max(n) also qualifies
wholeList(item, { reason: "one config file's keys" })    // a z.array, tagged
cappedRecord(value, { max }) / wholeRecord(value, { reason })
listBoundsOf(schema): ListBound[]       // [{ path, max } | { path, reason }]; throws on a bare list
```

- **Where the tag lives.** It is stored in `_def.listBound`, not in a WeakMap. zod 3.25.76 clones `_def` on `.max()`, `.describe()` and `.optional()`, so the tag survives them and survives duplicate module copies across web artifacts.
- **The parse is unchanged.** The payload is already parsed on both ends:
  - on the server load (`resource-runtime/core/runtime.ts:2655`);
  - at the L2 gate;
  - at client hydration;
  - on every WS update, including after a patch.

  So a `.max` cap is enforced on the wire with no new code.

**The rule.** Every `ZodArray`, `ZodRecord`, `ZodMap` or `ZodSet` reachable from a `liveValue`'s `schema`, a paged `item`, or a paged `meta` must be capped or whole. The walk:

- goes through wrappers, objects, unions, `lazy` and effects;
- uses a seen-set for recursion;
- treats `unknown` / `any` as opaque.

`liveValue` throws at declaration on a bare list, naming the key and the path (`rows[].segments`). This runs at module evaluation, so it fires on every build's boot and in every test importing the `core/` barrel.

A cap that drops rows is applied by the loader with the same exported constant, plus a `truncated: boolean` in the payload. Overflowing the cap is then a bug, never a production event.

Before / after:

```ts
// before: nested list, nothing required
liveValue("release.run-logs", { schema: z.object({ lines: z.array(z.string()), … }) })
liveValue("jobs-list", { schema: z.object({ rows: z.array(JobRowSchema), counts }), load: "on-demand" })
serveValue(savedThemes, { source: "db", reads, unbounded: { reason: "…" }, loader })   // reason on the serve side

// after
liveValue("release.run-logs", { query: RunLogQ, paged: { item: LogLineSchema, id: "n", key: …, limit: 500, maxLimit: 2000 } })
liveValue("jobs-list", { schema: z.object({ rows: cappedList(JobRowSchema, { max: JOBS_LIST_MAX }), truncated: z.boolean(), counts }), … })
liveValue("saved-themes.list", { schema: wholeList(SavedThemeSchema, { reason: "…" }), … })        // reason next to the list
serveValue(savedThemes, { source: "db", reads, loader })                                          // `unbounded` deleted
```

On collections:

- `all: { unbounded: { reason } }` stays, and `all: { max }` is added beside it.
- `:rows` and lookup reads get `maxIds` (default `maxLimit`), refused at decode. Today the size of an id set is unbounded.

### Freshness: `changes` on every serve arm

- **The external collection arm** (`core/internal/serve-on.ts`, `ExternalCollectionBase` at `:361-371`) gains `whileSubscribed(notify)` and `throttleMs`, with `serveValue`'s semantics. They are wired to the held-tuple plumbing at `:727-748`; the runtime's `debounceMs` already works per keyed entry.
- **The SQL arm of `serveCollection`** gains an optional `changes: "notified" | { fixed } | { immutable }`. Absent, it is routed through the feed, as today. Present, the same compiled loaders are registered as an external keyed window and point:

  ```ts
  serveCollection(archive, {
    from: _archive,                          // an EntityTable, ExcludeFromChangeFeed'd by its owner
    changes: "notified",
    whileSubscribed: (notify) => onArchiveWrite(notify),
  });
  useLive(archive, { where }, { viewport });  // unchanged reader
  ```

  - **Why the loaders plug in unchanged.** An external keyed loader always runs with `ctx === undefined`, a full re-read diffed by key. That is `assembleWindow`'s `fullQuery` path.
  - **`:groups` and `:count`** become non-keyed externals with `reach.unfed`.
  - **Refused:** `columnScope`, exposures and unions, as on today's external arm.
- **`from` stays `EntitySource | EntityTable`, with no new brand.** The existing boot assertions cover both directions:
  - an off-feed `from` that the owner did not opt out is refused by `assertUnfedTablesOptedOut` (`change-feed/server/internal/route-coverage.ts:229`);
  - an opted-out table served routed is refused by A1′ (`assertRouteTablesCovered`).
- **`{ snapshot }` on collections is deferred.** No site needs it: Studio sample rows becomes a capped value.

## Implementation batches (each builds green)

**B0. The `list-bound` package.** `plugins/packages/plugins/list-bound/core/{index.ts, internal/markers.ts, internal/walk.ts}` plus a `CLAUDE.md`. Tests cover:

- the parse is transparent;
- `.max` rejects;
- the tag survives `.optional()`, `.nullable()`, `.describe()` and `.max()`;
- the walk handles nested lists, `lazy` recursion, unions, records, maps and sets.

**B1. Wire the walk in report mode.**

- `network/plugins/live/core/internal/live-value.ts` calls `listBoundsOf` beside `checkParamParsers` (plain, typed-query and paged paths). It throws only on a malformed marker, collects bare lists, and freezes `shape` on the descriptor.
- `shape` is emitted in the runtime `_debug` payload beside `freshness` (`runtime.ts:461-466`, `:898`), so the read-set pane shows it.
- The resources facet (`plugin-meta/plugins/facets/plugins/resources/facet/parse-resources.ts:410-461`) reads the markers instead of the serve call's `unbounded`.
- A report test imports every `core/` barrel (`plugin-meta/barrel-import`) and lists the bare lists. That list is B2's to-do.

**B2. Mark the existing values**, area by area, following the migration table below. The db values' reasons move word for word into `wholeList`; their serve-side `unbounded` stays until B5.

**B3. New paged values:**

- `release.run-logs`: by line number, memoized on (size, mtime); `release-log-section.tsx` reads `{ viewport }`. The precedent is `debug.logs.lines`.
- `subagent-transcript`: by seq, via `sliceRange`.
- `edited-files`: by path.

**B4. The external collection arm gains freshness hooks, and the queue moves onto it.**

- `serve-on.ts`: `whileSubscribed` and `throttleMs`.
- The `JobQueue` seam (`infra/plugins/jobs/server/internal/queue.ts`) gains `window` / `rows` / `groups`:
  - the Postgres implementation is in `machine/internal/jobs-list.ts`, keyset on `(run_at, id)`, with cut text equal to `keyText`;
  - the in-memory twin is `memory-queue.ts`.
- A new `jobs` collection is served external, `changes: "notified"`, with `whileSubscribed: onActivity`.
- Debug → Queue (`debug/plugins/queue/web/internal/job-rows.ts:153`) moves per decision 2 below.
- Until then, `jobs-list` is `cappedList(500)` with `truncated` (marked in B2).

**B5. Enforce.**

- The walk throws on a bare list.
- Delete `BoundArm`, `CollectionShaped` and every serve-side `unbounded`:
  - `compile-value.ts:146, 200-216, 293, 368, 768, 965-970, 1052, 1179`;
  - `serve-on.ts:189-191`;
  - the 16 db call sites.
- Move the type tests from `serve-value.test.ts:230-273` to `live-value.test.ts`.
- Docs:
  - `network/plugins/live/CLAUDE.md`: rewrite "The bound rule is a type" (`:1571-1574`), deleting the "bounded by the process" sentence; add a *Shape vs freshness* section near the top;
  - `server/index.ts:67` description;
  - regenerate the plugin docs.

**B6. The SQL arm off the feed (hole 1).**

- `infra/plugins/query-resource/server/internal/compile-window.ts`: split `assembleWindow` (`:164-264`) and `assemblePoint` (`:268-296`) into `{ loader, limitOf, familyOf | idsOf }` plus `scopePolicyOf` (`:135-155`). The routed path then composes the two, unchanged.
- New `network/plugins/live/server/internal/serve-off-feed.ts`, dispatched from `serve-collection.ts:1189` when `changes` is set, with overloads at `:1085`.
- The compiled projection adds `$columns: {}` as the external arm does.
- `resource-runtime/core/runtime.ts`:
  - `ExternalWindowPolicy` / `ExternalPointPolicy` (`:613`) accept `unfed`, stored as an unfed-only `RoutingRecord`. That way `readCovered` (`:2750`) accepts the loader's captured reads instead of flagging drift, which today happens for any notified external with no routing record.
  - `unfedResourceTables()` (`:7965`) returns them.
- `no-db-backed-notify/check/scan.ts:27`: add `serveCollection` to `NOTIFY_MARKERS`. A hand-SQL external collection escapes this check today.

**B7. Collection completeness.**

- `all: { max }`; external `all` stops passing `limit = null` (`serve-on.ts:~871`).
- `maxIds` on `:rows` and lookup decode.
- `jsonField({ schema })` schemas inside collection fields (22 files) are walked with the same markers.

**Critical files:**

- `network/plugins/live/core/internal/{live-value,compile-value,serve-on}.ts`
- `network/plugins/live/server/internal/serve-collection.ts`
- `infra/plugins/query-resource/server/internal/compile-window.ts`
- `framework/plugins/resource-runtime/core/runtime.ts`
- `database/plugins/change-feed/server/internal/route-coverage.ts`
- `infra/plugins/jobs/**`
- `debug/plugins/queue/web/internal/job-rows.ts`

## Migration table

From a sweep of about 118 external served values, plus the db values that declare `unbounded`. B1's report test is the authority; this table is the starting classification.

| Destination | Sites |
|---|---|
| Already paged (lists nested in the item get marked) | `debug.logs.lines`, `code.dir`, `host-fs.list`, `host-fs.image-sizes`, `jsonl-events` (item `segments` → whole: "one typed message's segments"), `mail.search`, `metrics.details` |
| Already capped (switch to a shared constant) | `queue-health.pulse`, `background.recent-runs`, `background.central-recent-runs`, `agent-browser.status`, `db-query-deadlines`, `deploy-analytics.report`, `host-fs.peek` (move `HOST_FS_PEEK_MAX_NAMES` into the schema) |
| New paged | `release.run-logs`, `subagent-transcript`, `edited-files` |
| New cap + `truncated` | `code.commit-files`, `code.push-files`, `file-explorer.git-status`, `jobs-list` (stopgap until B4) |
| New cap (top-N, range- or provider-bounded) | `health-monitor.series`, `heap.stats`, `stats.cost.{daily,sessions-daily,top-sessions}`, `stats.commits.{counts,counts-by-category,lines,lines-by-ext}`, `metrics.query`, `code.resolve-file`, `place.search`, `places.search`, `wallpaper.search`, `tweakcn.community-catalog`, `studio.table-sample-rows` (`rows` max 10 = the SQL `LIMIT`), `subagent-activity` |
| db loader already caps → a real cap | `search.results` (30), `browser-recents` (12), `events.run-events` (`RUN_EVENTS_LIMIT`) |
| Whole + reason (registries, handfuls) | `resources.debug`, `runtime-profiler.profile`, `profiling.boot`, `debug.logs.catalog`, `latency-ledger.summary`, `browser-recordings.runs`, `conversations.partial-message` ("one model turn"), `config-orphans.report`, `memory.files`, `broadcasts.entries`, `release.previews`, `deps.states`, `background.catalog`, `background.central-catalog`, `build.deployment`, `runtime-sdk.claude-usage`, `claude-code-status`, `claude-accounts`, `auth-state`, `stats.cost.distribution`, `mcp.catalog`, `plugin-view.tree`, `plugin-view.facets-tree`, `automations.catalog`, `prototypes.{list,statuses,picks,thumbnails}`, `model-provider.catalog`, `config-v2.{scopes,conflict-locations,modified-counts}`, `task-category.registry`, `icons.sprites`, `deploy.runs`, `data-view-custom-column-defs`, `studio.table-{indexes,columns,foreign-keys}`, `workspace.catalog`, `metrics.catalog`, `jsonl-events.prompts`, `code.commit-info` (parents, trailers); the db values with their current reasons (`saved-themes.list`, `active-data.bindings`, `agent-notes-authors`, `page-backlinks`, `event-triggers`, `attachments.by-owner`, `app-usage.summary`, `data-view-row-order`, `data-view-custom-values`, `mail-labels`, `mail-sync-state`, `sonata-track-view`, `stats.tasks.history`) |
| Classify on reading the schema | `conversationTurns`, `conversationArtifacts`, `conversationParentFacts`, `conversationTaskAggregate`, `conversationShellFacts`, the transcript-stats fold, `review.plugin-changes`, `review.push-plugin-changes`, `allow-files`, `composition.data`, `sentinel.machine-usage`, `runtime-sdk.agent-processes`, `prototypes.history`, `places.details` |
| Not a list (passes) | about 38 values, e.g. `background-shell-output` (a 64 KiB string tail), `code.file`, `memory.file`, the single-descriptor `config-v2` values |

Since the issue was written:

- `slow-ops.list` is gone (now the `slow-ops.ops` collection over a change producer).
- `traces` is producer-backed.

Neither is a hole any more.

## Decisions (recommended defaults; flagged for the user)

1. **Ship B6 (compiled SQL off the feed) with no production consumer?** Default: **yes**, as a small batch proven by a parity test (routed loader vs off-feed loader, same rows for a filter, a cut and a join). It is the API principle "the source decides only freshness". Otherwise hole 1 stays open in the API.
2. **Debug → Queue once the queue is windowed.** Today the client merges the whole queue with the whole runs ring. A window over two merged sources is not coherent: sorting and cuts span both, and a union cannot take an external arm. Default: **two windowed sources**, *Queue* (the external `jobs` window) and *History* (the `job_runs` collection as a window, retiring its `all`). A job leaves Queue for History when it finishes. The alternative is to keep one merged list, with the queue capped at 500 plus `truncated`: bounded, but not paged.
3. **Enforcement rung.** Default: **a throw at declaration** (rung 4, but on every boot and every test that imports the declaration) and no type brand in v1. A phantom brand plus a recursive `UndeclaredListPath<T>` would give a tsc error, but it spreads into domain types used outside live reads and risks tsc depth limits on transcript types.

## Verification

- **Tests:** `./equin test` over each of these paths:
  - `plugins/packages/plugins/list-bound`
  - `plugins/network/plugins/live`
  - `plugins/infra/plugins/query-resource`
  - `plugins/database/plugins/change-feed`
  - `plugins/infra/plugins/jobs`
  - `plugins/plugin-meta/plugins/facets/plugins/resources`
  - `plugins/release`
- **New test cases:**
  - the walk, and the tag surviving clones;
  - a cap overflow failing loudly with the key named;
  - compile-window parity between the routed and off-feed loaders;
  - `route-coverage`: an off-feed `from` that is not opted out is refused, and an opted-out one passes;
  - the drift guard accepts a declared `unfed` read;
  - the jobs keyset cut matches `keyText`;
  - `maxIds` refused at decode.
- **Checks:** `./equin check` (type-check, eslint, plugin-boundaries, boundary-rules, plugins-doc-in-sync, plugins-registry-in-sync, `no-db-backed-notify`). B1's report test must list zero bare lists before B5 lands.
- **Build:** `./equin build`. Because of B5, the build's boot is itself the full check.
- **Live, on my own build (`browser_*`):**
  - Debug → Queue: rows, counts, scrolling, and a job moving to History;
  - a release's log section: scroll back past page 0 while a run streams;
  - Studio sample rows;
  - the read-set pane shows `shape` per key.
  - Tail `~/.singularity/worktrees/<wt>/logs/` for zod cap errors after boot.
