# Composition-scoped release history (remove the cluster-wide 50-run window)

## Context

The Studio composition detail pane's **Release history** section renders a
composition's runs by client-filtering `releaseHistoryResource`
(`rows.filter(r => r.composition === name)`). That resource is server-windowed to
the **50 most-recent runs per worktree** across *all* compositions
(`plugins/release/server/internal/release-history-resource.ts`:
`ORDER BY started_at DESC LIMIT 50`, `recompute:{kind:"full"}`).

Consequence: a composition's older runs vanish from its history once 50 newer
runs exist for *any* composition in the worktree — a rarely-released app can show
"No releases yet" while its runs still sit in `release_runs`. The section admits
this in a caption ("Showing this composition's runs from the 50 most recent
overall") — honest, but not a fix.

**The bug is coupled to run-detail resolution.** The three release-detail
sub-panes each resolve their run by scanning that *same* 50-row window:

- `release-info` — `useResource(releaseHistoryResource).data.find(r => r.id === runId)`
- `release-logs` — same `.find`, needs `run.status` to pick live vs persisted logs
- `release-artifact` — same `.find`, needs `run.status` + `run.artifactPath`

So surfacing older runs in the list would produce rows whose detail pane 404s
("Run not found"). Any fix must therefore also fix by-id resolution. Today the
50-row `releaseHistoryResource` is a single ambient "recent runs" cache misused
for two different jobs — **listing** a composition's runs, and **resolving one
run by id**. This plan splits those into two purpose-built primitives and deletes
the ambient window.

Intended outcome: a composition's full run history is browsable (keyset infinite
scroll, no cap), and any run's detail resolves regardless of age — both live.

## Approach (chosen: full server-paginated redesign)

Mirror the established **all-conversations** precedent
(`plugins/conversations/plugins/all-conversations`), the canonical
server-delegated DataView (keyset pagination + scalar revision-tick liveness).

### Part 1 — Composition-scoped, keyset-paginated list

**`plugins/release/core/endpoints.ts`** — add `queryReleaseHistory`:
- `POST /api/release/history/query`, body
  `{ composition: string, sort: SortRule[], filter: FilterGroup | null, query: string, cursor: string | null, limit: number(max 200), dataViewId: string }`,
  response `{ items: ReleaseRun[], nextCursor: string | null, hasMore: boolean }`.
- Reuse `SortRuleSchema` + `FilterGroupSchema` exactly as
  `all-conversations/core/internal/endpoints.ts` declares them. `composition` is
  the one extra field over the conversations body.

**`plugins/release/core/resources.ts`** — add `releaseRunsRevisionResource`:
- `resourceDescriptor<{ rev: string }>("release.history-revision", z.object({rev:z.string()}), {rev:""})`.
  Not bootCritical (the section lives deep in a detail pane, not first paint) —
  matches `conversationsRevisionResource`.

**`plugins/release/server/internal/handle-history-query.ts`** (new) — mirror
`all-conversations/server/internal/handle-query.ts`:
- `where = and(eq(_releaseRuns.namespace, currentWorktreeName()), eq(_releaseRuns.composition, body.composition), searchWhere(query), compileWhere(filter, columnMap, resolver), seek)`.
- `COLUMN_MAP`: `target`, `status`, `platform`, `startedAt`, `finishedAt` →
  the matching `_releaseRuns` columns; `resolver = (t,o) => resolveFieldFilterSql(t,o) ?? null`.
- Keyset: `buildSortKeys(sort, columnMap, { col: _releaseRuns.id, fieldId: "id" })`
  (id tiebreaker), default order `started_at desc`. `decodeCursor` + `seekPredicate`,
  `.limit(limit + 1)` → `hasMore`, `encodeCursor(keyValuesOf(last, keys), sortSignature(sort))`.
- Include `augmentServerQuery({ dataViewId, rowKeyCol: _releaseRuns.id, sort, filter })`
  for custom-columns parity (same as all-conversations). **One divergence:**
  `release_runs` is a plain `pgTable`, not a `pgView`, so the base projection is
  the explicit wire-column select map (the same map
  `release-history-resource.ts` uses today, i.e. every column **except `pid`**) —
  not the `viewColumns(view)` symbol hack. Fold `aug.joins`/`aug.projection`,
  strip `aug` projection keys before returning (or rely on zod strip — do it
  explicitly to mirror precedent).

**`plugins/release/server/internal/history-revision-resource.ts`** (new) — mirror
`all-conversations/server/internal/revision-resource.ts`:
- `defineResource(releaseRunsRevisionResource, { mode:"push", debounceMs:250, loader })`.
- Coarse hash over `release_runs` scoped to `currentWorktreeName()`: per
  `(composition,status)` bucket counts + total + `max(started_at)` + `max(finished_at)`,
  sha1 → `{ rev }`. Reads only real-change facts so `mode:"push"` no-op
  suppression fires it only on genuine inserts/status-flips.

**`plugins/release/server/internal/tables.ts`** — add supporting index for the
composition-scoped keyset seek:
- `index("release_runs_ns_comp_started_idx").on(t.namespace, t.composition, t.startedAt.desc())`.

### Part 2 — Run-by-id live resource (detail-pane resolution)

**`plugins/release/core/resources.ts`** — add `releaseRunResource`:
- `resourceDescriptor<ReleaseRun | null, { id: string }>("release.run", ReleaseRunSchema.nullable(), null)`.
  Exact shape of `taskDetailResource`
  (`plugins/tasks/plugins/tasks-core/core/resources.ts:47`). Parameterized, not
  keyed, not bootCritical.
- **Remove** the `releaseHistoryResource` descriptor.

**`plugins/release/server/internal/release-run-resource.ts`** (new) — mirror
`taskDetailResource`'s server loader (`tasks-core/server/internal/resources.ts:246`):
- `defineResource(releaseRunResource, { mode:"push", loader: async ({id}) => { const [row] = await db.select(<wire cols, no pid>).from(_releaseRuns).where(eq(_releaseRuns.id, id)).limit(1); return row ?? null; } })`.
  `mode:"push"` + no `identityTable` → the change-feed recomputes active
  subscriptions when `release_runs` changes, so a status flip re-pushes (same as
  task-detail). Confirm liveness in verification.
- **Delete** `release-history-resource.ts`.

### Part 3 — UI rewrites

**`release-history-section.tsx`** — replace `useResource(releaseHistoryResource)`
+ client `.filter` + `matchResource` + caption with a server-delegated DataView
(mirror `all-conversations/web/panes.tsx`):
```tsx
const name = useManifestItems().find(it => it.id === id)?.name;
const tick = useResource(releaseRunsRevisionResource);
const changeTick = matchResource(tick, { pending: () => null, ready: d => d.rev });
// fields become static (no longer derived from loaded rows) — see note below.
<DataView<ReleaseRun>
  storageKey={RELEASE_HISTORY_VIEW}
  rows={[]}
  fields={fields}
  rowKey={r => r.id}
  views={["list", "table"]}
  defaultView="list"
  selectedRowId={selectedRunId}
  onRowActivate={r => openPane(releaseDetailPane, { runId: r.id }, { mode: "push" })}
  emptyState={<>No releases yet.</>}
  dataSource={name ? {
    changeTick,
    fetchPage: (args) => fetchEndpoint(queryReleaseHistory, {}, { body: { ...args, composition: name } }),
  } : undefined}
/>
```
- Drop the caption and the `RELEASE_TARGETS`-derived nothing changes; keep the
  field schema (target/status/platform/startedAt/finishedAt).
- **Minor:** the `platform` enum filter options are today derived from the loaded
  rows; under server pagination `rows` is only the loaded window, so its filter
  options would be partial. Acceptable — keep `platform` sortable and drop its
  ad-hoc enum `options` (or leave them window-derived). Not load-bearing.
- `name === undefined` (manifest not yet resolved) → `dataSource={undefined}`,
  DataView renders the empty state briefly until the manifest settles.

**`release-info.tsx` / `release-log-section.tsx` / `release-artifact.tsx`** —
replace `useResource(releaseHistoryResource)` + `.data.find(r => r.id === runId)`
with `const result = useResource(releaseRunResource, { id: runId })`:
- info: `if (result.pending) return <Loading/>; const run = result.data; if (!run) return "Run not found";`
- logs: `if (result.pending) return <LiveLogs/>; const run = result.data; if (run?.status === "running") return <LiveLogs/>; return <PersistedLogs runId={runId}/>;`
- artifact: `const run = result.data;` (single `ReleaseRun | null`; keep the
  `previewStateResource` subscription as-is).

This is strictly *simpler* than the current code (no client scan).

### Part 4 — Cleanup & docs

- `plugins/release/core/index.ts` — drop the `releaseHistoryResource` export; add
  `queryReleaseHistory`, `releaseRunResource`, `releaseRunsRevisionResource`.
- `plugins/release/server/index.ts` — drop the `release-history-resource` import
  + `Resource.Declare(releaseHistoryResource)`; add
  `Resource.Declare(releaseRunResource)`, `Resource.Declare(releaseRunsRevisionResource)`,
  and the `[queryReleaseHistory.route]: handleHistoryQuery` route.
- `plugins/infra/plugins/paths/server/internal/prune-artifacts.ts` — update the
  comment that references `releaseHistoryResource`'s 50-window (the artifact-prune
  retention policy is its own constant; only the comment's premise changes).
- `plugins/release/CLAUDE.md` (hand-written line ~55) and
  `plugins/apps/plugins/studio/plugins/compositions/plugins/release/CLAUDE.md`
  ("The history is windowed, and says so") — rewrite to describe the
  composition-scoped paginated query + run-by-id resource. The autogen blocks
  regenerate via `./equin build`.

## Critical files

- **New:** `plugins/release/server/internal/handle-history-query.ts`,
  `history-revision-resource.ts`, `release-run-resource.ts`.
- **Delete:** `plugins/release/server/internal/release-history-resource.ts`.
- **Edit (core):** `plugins/release/core/{endpoints.ts,resources.ts,index.ts}`.
- **Edit (server):** `plugins/release/server/index.ts`,
  `plugins/release/server/internal/tables.ts`.
- **Edit (UI):**
  `.../compositions/plugins/release/web/components/release-history-section.tsx`,
  `.../plugins/release-info/web/components/release-info.tsx`,
  `.../plugins/release-logs/web/components/release-log-section.tsx`,
  `.../plugins/release-artifact/web/components/release-artifact.tsx`.

## Reuse (do not reinvent)

- Server keyset: `@plugins/primitives/plugins/data-view/plugins/server-query/{server,core}`
  — `augmentServerQuery`, `buildSortKeys`, `compileWhere`, `seekPredicate`,
  `keyValuesOf`, `orderByClauses`, `decodeCursor`, `encodeCursor`, `sortSignature`,
  `OperatorSqlResolver`.
- Filter SQL: `@plugins/fields/plugins/server-capabilities/server` → `resolveFieldFilterSql`.
- Web source: `<DataView dataSource={{ changeTick, fetchPage }}>` → `useServerDataSource`
  (already wired inside DataView).
- Worktree scoping: `currentWorktreeName()` (as `release-history-resource.ts` uses today).
- Precedents to copy shape byte-for-byte: `all-conversations` (list + revision tick),
  `taskDetailResource` (run-by-id live resource).

## Verification

1. `./equin build` (regenerates migrations for the new index, facets/docs,
   registry). Confirm the new migration for `release_runs_ns_comp_started_idx` is
   generated and committed.
2. **Endpoint / pagination:** with existing `release_runs` rows (query via
   `query_db` to see them), POST `queryReleaseHistory` for a composition and
   confirm it returns only that composition's runs, `hasMore`/`nextCursor` page
   correctly, and older runs (beyond any 50-overall window) are reachable by
   paging. `query_db` is read-only, so use it to *observe* rows; drive real
   releases (Run button) to create them.
3. **UI (Playwright, `e2e/screenshot.mjs`):** open a composition detail →
   Release history; confirm rows load, infinite-scroll paginates, and the list is
   scoped to that composition. Click an **old** run row → the detail pane opens
   and info/logs/artifact all resolve (no "Run not found").
4. **Liveness:** start a release; confirm (a) the list refetches its window when
   the revision tick pulses (new row appears, status flips), and (b) the open
   run-detail pane's status badge / logs / artifact update live via
   `releaseRunResource` — without a manual refresh.
5. `./equin check` (boundaries, migrations-in-sync, type-check,
   plugins-doc-in-sync, data-views-in-sync).
