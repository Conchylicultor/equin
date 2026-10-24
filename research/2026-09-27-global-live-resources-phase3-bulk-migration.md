# Live resources, phase 3: the bulk migration to `liveValue` / `liveCollection`

## Context

The unified live-resource API (`plugins/network/plugins/live`) is complete for everything
phase 3 needs:

- values: `liveValue` / `serveValue` / `useLive(value)`, plus the migration contract's options
  (`throttleMs`, `recomputeOn`, `whileSubscribed`, `revalidate`, `origin: "central"`);
- collections: `liveCollection` / `serveCollection` / `useLive` / `useLiveRow`, including
  lookup-only collections and column wire codecs.

Almost every resource still goes through the old spellings:

- `resourceDescriptor`, `keyedResourceDescriptor`, `queryResourceDescriptor`,
  `windowQueryResourceDescriptor`, `pointQueryResourceDescriptor`;
- served by `defineResource`, `defineExternalResource`, `queryResource`, `windowQueryResource`;
- read by `useResource`, `usePointResource(s)`, `useWindowResource`.

As long as they have callers:

- the 12-spelling duplication stays;
- the old `defineResource` still defaults `mode` to `invalidate`;
- a Postgres-backed array value can still grow without a stated bound;
- `resource-vocabulary` cannot shrink.

This is phase 3 of `research/2026-09-25-global-unified-live-resource-api.md` (Resources page
item 5). **The contract is `research/2026-09-26-global-live-values-migration-contract.md`**
(and its Result).

**Rules held:**
- No wrapper layer: call sites migrate directly, and a factory goes once nothing calls it.
- A new hook, entry point or option is added only when a real call site needs it.

**Out of scope** (Resources page items 3 / 7 / 9):

- **Tree:** `tasks`, `attempts`, `conversations-active` / `-system` / `-gone`, `agent-launches`,
  `pages`, `page-links`, and `task-categories` (the tasks tree DataView groups by it). Also the
  reader-less `pushes` carrier, which anchors the `attempts` `rel()` edge.
- **Revision ticks:** `runs.revision`, `conversations-revision`, `events.revision`,
  `events.runs-revision`, `deploy.runs-revision`, `mail-threads-revision`,
  `release.history-revision`, `reports.revision`, `latency-ledger.revision`.
- **Config (item 9):** `config-v2.values`, `config-v2.scopes`, and — decided below — `config-v2.conflicts`,
  `config-v2.tiers`.

**Census:** a read-only workflow over every old call site at `fa4eeb02a`, then an adversarial
review of this plan against the code (16 findings confirmed, all folded in). The 107 resources
split as follows:

- **75 handled here:**
  - 44 values;
  - 14 lookup-only collections;
  - 15 windowed collections;
  - 1 resource replaced by an endpoint;
  - 1 folded away.
- **9 already migrated.** The census does not count `notifications` / `.unread` or `auth-state`.
- **23 out of scope.**

## Decisions

**Decided by the user (2026-09-27):**

- **Framework changes are approved as needed** (`plugins/framework/CLAUDE.md`). Every framework file is listed below.
- **Delivery: one branch, in waves.** Build and checks run after each wave. One review and one push at the end.
- **Absent ids: `useLiveRow(c, id: string | null)`.** A `null` id returns `{ pending: false, found: false }` on the first render.
  - **Implementation (no new `useResource` option):** it reads `c.rows` at `point.encode([])`, i.e. `{ ids: "" }`. That is one shared, refcounted tuple per collection, which the server answers with `[]` and no query.
  - **Why not a skip option:** an `enabled` option on `useResource` would be a public skip that any value reader could use. It would also have to disarm the pending-mount count and the cold-start prime.
  - **Values get no new option.** The value sentinel follow-up is listed below.
  - **Real call sites:** the four Sonata override observers and `useGroove`.
- **Sonata library: whole-table values until item 7.**
  - `sonata-songs`, `sonata-playback-history` and `sonata-song-midi` become `liveValue` + `unbounded: { reason }`, each reason naming item 7.
  - **Recorded on the Resources page under item 7** (Wave 0), with the three blockers: joined side-table sort columns, host rows in data-view's `FieldExtensionProps`, and live-window paging in DataView.
- **`config-v2.conflicts` / `.tiers` wait for item 9.** Their `{ path, scopeId? }` optional param has no `liveValue` spelling, and `config-v2.values` has the same shape and is notified in lock-step. **Recorded on the Resources page under item 9** (Wave 0).

**Decided here (technical):**

- **The `pushes` key.** The new collection over the `pushes` table takes the key `"pushes"`, as the contract spells it.
  - The reader-less carrier that anchors the tree `attempts` edge moves server-only, under the key `"pushes.attempts-cascade"`, as a flat `defineResource` in `tasks-core/server` (allowlisted until item 3).
  - `rel()` binds the `Resource` object, not the key.
  - The carrier is neither preloaded nor persisted.
  - The cascade is verified explicitly (Wave 4) and recorded under item 3.
- **`prompt-task-origins` folds into `prompt-block-tasks`' `:rows`** (`useLiveRow(promptBlockTasks, taskId)`), which deletes a whole-table keyed resource at no API cost. It is not on the task's out-of-scope list; the contract added it only because it was "tied to tasks".
- **Push becomes the default for** `chord.curriculum`, `chord.progress`, `event-emissions`, `event-triggers` and `dead-jobs`. No stated reason for invalidate exists (audit §5).
  - `jobs-list` keeps `load: "on-demand"`: a 500-row graphile join, Debug-only, kept out of the shared flush.
- **`slow-ops` becomes a GET endpoint read with `useEndpoint`, and the resource is deleted.**
  - `slow_ops` is `ExcludeFromChangeFeed`, so the "live" resource never updates. A `source: "db"` value would claim freshness it never gets.
  - The pane loads on open, exactly as today.
- **`mail-thread-messages`: the default window is the newest 100** (`internalDate desc`). The pane reverses it for display, and `loadMore` pages older messages.
  - **Accepted change:** in a thread longer than 100, NULL-dated messages (rare) sort last under `desc NULLS LAST`, so they appear only after `loadMore`. Today they render first.
- **Declare only what readers use.**
  - `browser-bookmarks` gets `filterable: { url }` (the star's per-url lookup must not scan a window). This deviates from the contract's `{}`.
  - `deploy.deployments` gets `{ serverId }`.
  - `conversation-summaries` gets `{ conversationId }` (no reader filters by `phase`).
  - `claude-cli-calls` moves its source / model-tier filters server-side: `where` + `groupBy`, with the tier as an `in` over that tier's model ids.
- **Payload wrappers.** A value that stays a value is unwrapped from `{ rows: T[] }` to `T[]` (`event-triggers`), so the tsc bound rule (`CollectionShaped`) sees the array.
- **Timestamps.** Row fields that were ISO strings become `z.coerce.date()` where a collection binds a timestamp column:
  - `deploy.deployments` `createdAt` / `updatedAt`;
  - `dead-jobs` `diedAt` / `archivedAt`.

  The endpoints that share those schemas are updated with them.
- **Sentinel params (`?? ""`).**
  - **Removed without new API** where a split child renders the read only once the id is known:
    - the review pane and code-review summary push reads;
    - the commits-graph body and chip.
  - **Left as they are and recorded as a finding-G follow-up for values:**
    - `active-data.bindings` (`use-active-data-binding.ts:52-57`);
    - `jsonl-events` (`workflow-node-pane.tsx:24`);
    - `subagent-activity` (`use-subagent-statuses.ts:119/121`);
    - `config-v2.secret-meta` (the apple wizard's `{ path: "" }`).
- **Accepted behaviour changes:**
  - `build.history` is no longer L2-persisted (bounded windows never are). Boot loads its 50 rows fresh.
  - Point resources' wire keys gain `:rows` (they are never preloaded or persisted).
  - The bookmarks bar and the debug lists (`event-emissions`, `dead-jobs`, `claude-cli-calls`) show a default window with `loadMore`.
  - A Sonata song switch waits one round trip for that song's overrides, and nothing plays or renders with the previous song's settings (Wave 5).
  - The mail NULL-date ordering above.

## The end state for the old spellings

| Old spelling | After phase 3 |
|---|---|
| `usePointResource`, `usePointResources` | **Deleted at the Wave 3 barrier.** Their last callers migrate there, and plugin-boundaries R13 fails a public name whose only importer is a test. `useLiveRow` stops using `usePointResource` in Wave 0. |
| `useWindowResource` (`window-hooks.ts`) | **Deleted at the Wave 4 barrier** (last callers: `starred`, `agent-origin`). |
| `useOptimisticResource` legacy object form (`initialData` base) | **Deleted in Wave 6**, when `page-blocks` migrates. Its test cases are ported, not dropped. |
| `windowQueryResourceDescriptor`, `pointQueryResourceDescriptor` | **Moved into `network/live/core/internal/`** (Wave 7) and un-exported from `query-resource/core`. Their contract types stay in `query-resource/core`, which `windowQueryResource` consumes. `resource-vocabulary` drops both entries. |
| `resourceDescriptor`, `keyedResourceDescriptor`, `queryResourceDescriptor`, `defineResource`, `defineExternalResource`, `queryResource`, `windowQueryResource`, `useResource` | **Stay**, reachable only from the substrate and the tree / tick / config files. The lint below enforces this, and each allowlist entry names the item that removes it. |
| `mode` default `"invalidate"` (`runtime.ts` :636 and :2104) | **Removed** (Wave 7): `mode` is required on every non-keyed old form. Every production call already writes it. |
| `initialData` on `ResourceDescriptor` | **Stays** — a recorded deviation from contract §7. It is still seeded by the window / point / groups descriptors (`[]`) and by the tree (`[]`), tick (`{ rev }`) and config (`{}`) descriptors. It goes with items 3 / 7 / 9 and the plugin consolidation. |
| Dead code | **Deleted:** the `rowIdentity` scope arm (no caller since `todo-block-task` / `page-block-doc`), `live-state/web`'s unused re-exports of `resourceDescriptor` / `keyedResourceDescriptor`, and `no-pending-data-collapse`'s `usePointResource` nullish branch. |

The runtime `debounceMs` → `throttleMs` rename waits: `release.history-revision` (a tick) still passes `debounceMs`.

## The guard: `network/live` lint `no-legacy-resource-spelling`

A rule contributed by the new `plugins/network/plugins/live/lint/`. Contributed rules apply repo-wide.

- **What it flags:** calls to, and imports of, every old spelling in the "Stay" and "Deleted" rows above, `useResource` included.
- **Allowlist:** its `ignores` list uses the burndown precedent in `live-state/lint/index.ts`.
  - **Permanent substrate globs:** `network/live`, `infra/query-resource`, `primitives/live-state`, `primitives/optimistic-mutation`, `framework/resource-runtime`, `server-core`, `central-core`.
  - **Initial list:** every other file that calls or imports an old spelling today.
- **Burndown:** each wave's barrier deletes its files from the list. The final list is the substrate globs plus the tree / tick / config files, each commented with item 3, 7 or 9. It is the living inventory of what is left.
- **Tests:**
  - RuleTester covers the flagged call and the flagged import.
  - The allowlist is tested through `buildLintConfig` (`framework/tooling/lint/core/build-lint-config.ts`), because RuleTester runs only the rule module and cannot see `ignores`.

## Waves

Each wave runs as one Workflow (see Execution), then build (checks included) and the wave's e2e.

Target shorthand used in the tables:

- **V-db**: `serveValue({ source: "db" })`.
- **V-db∞**: the same, plus `unbounded: { reason }`.
- **V-ext**: `serveValue({ source: "external" })`, whose `notify` replaces the old `resource.notify()`.
- **Lookup**: `liveCollection(key, { row, id })` + `serveCollection(c, { from })`, read with `useLiveRow`.
- **Window**: a full `liveCollection` + `serveCollection`, read with `useLive(c, query)`.

`params`, `preload` and `load` are **declaration** fields, written on `liveValue(...)`. They are never `serveValue` options: `load` there is a tsc error.

Every migration also does the following:

- **Declaration and serving:**
  - delete the `initialData` placeholder;
  - drop `identityTable` on plain values;
  - collapse the flat server form's restated key and schema into the one declaration;
  - spread `...served.declare` into `contributions`;
  - drop server-barrel re-exports that nothing imports.
- **Readers and docs:**
  - fix each reader's pending handling rather than collapsing it;
  - rewrite the plugin's `CLAUDE.md` prose;
  - re-point tests that mock `live-state/web` `useResource` to `useLive`.

### Wave 0 — guards and bookkeeping

**Resources page first.** Using `edit_page` inside the agent status card `block-f6465fff-…`, add sub-bullets under the items they belong to:

- **Item 5:** phase 3 started (plan link).
- **Item 7:**
  - the Sonata library values (`sonata-songs`, `-playback-history`, `-song-midi`) wait for joined side-table sort columns, host rows in `FieldExtensionProps`, and live-window paging in DataView;
  - the value-params sentinel follow-up (finding G for values) and its four sites.
- **Item 9:** `config-v2.conflicts` / `.tiers` wait with `config-v2.values` for the optional-param spelling.
- **Item 3:**
  - the `pushes` carrier's new key, `pushes.attempts-cascade`, and that the new `pushes` collection is its future anchor;
  - the `prompt-task-origins` fold.
- **Constraint:** Wave 7's status rewrite keeps these sub-bullets verbatim.

**Guards and API:**

- **The lint:** `no-legacy-resource-spelling` (above), with the full initial allowlist.
- **`useLiveRow(c, id: string | null)`:**
  - rebuilt on `useResource(c.rows, …)` directly, so it no longer uses `usePointResource`;
  - a null id → `{ ids: "" }` and `found: false` on the first render (`network/live/web/internal/use-live.ts`);
  - `network/live/CLAUDE.md`'s "no nullable id" prose is updated.
  - **jsdom case:** null gives `found: false` on the first render, the only observed tuple is `{ ids: "" }`, and `pendingMountSnapshot().pending` settles.
- **Framework guards, so migrated sites stay covered:**
  - `lint/plugins/reactive-server-io/lint/no-reactive-server-io.ts`: add `useLive` / `useLiveRow`.
  - `checks/plugins/no-db-backed-notify/check/index.ts`: also scan `serveValue(…, { source: "external", loader })` spans. The `jobs-list` exemption moves with it.
  - `lint/plugins/entity-projection-safety/lint/no-hand-rolled-entity-projection.ts` (+ its `CLAUDE.md`): condition (4) also covers `serveValue` loaders.
  - **Boot assert** (`server-core/core/resources.ts`, plus a runtime accessor for the preloaded registered keys): after all plugins load, throw if a registered resource with `preload` has no `Resource.Declare` contribution.
    - Why: a forgotten `...served.declare` silently loses boot hydration and L2 persistence, and five preloaded resources migrate in this phase.

### Wave 1 — plain values (29, plus `slow-ops` → endpoint)

| Resource | Target |
|---|---|
| `chord.curriculum`, `chord.index-status` | V-db (curriculum: invalidate → push) |
| `chord.progress` | V-db, `params: ["timeZone", "tokens"]` (invalidate → push) |
| `browser-recents` | V-db∞ (a DISTINCT ON derivation, capped at 12) |
| `mail-sync-state` | V-db∞, declared in `mail-core/core` and served in `mail/sync`. It is the first cross-plugin `serveValue`, so check the facet output. |
| `mail-labels` | V-db∞. The client `select` becomes a `useMemo` (contract §6). |
| `prototypes.list` | V-ext. The canvas's `select` + `gate` become a lookup by name (contract §6). |
| `prototypes.version` | V-ext |
| `prototypes.history` | V-ext, `params: ["name"]` |
| `prototypes.statuses`, `prototypes.thumbnails` | V-ext |
| `release.previews` | V-ext, declared with `preload: "boot"` (parity). Keeps `release/web/internal/register.ts`, whose comment is fixed (it names a nonexistent `release.history`). |
| `worktree-ops` | V-ext, declared with `preload: "boot"`. Pinned eager by the eager-tier generator (there is no `register.ts`): confirm `web-tiers.generated.ts` still pins op-status. |
| `config-v2.conflict-locations`, `config-v2.modified-counts` | V-ext |
| `config-v2.secret-meta` | V-ext, `params: ["path"]` |
| `db-query-deadlines`, `claude-code-status`, `sentinel.status`, `sentinel.vitals` | V-ext |
| `task-detail` | V-db, `params: ["id"]`, `TaskSchema.nullable()` |
| `conversations-gone-stats` | V-db, declared with `preload: "boot"`. The key is unchanged, so the L2 row stays compatible. |
| `agents` | V-db∞, declared with `preload: "boot"` (the user's hand-written roster, read whole by the sidebar) |
| `event-triggers` | V-db∞, unwrapped to `TriggerRow[]` (a union of N per-event tables, plus the computed `dangling`) |
| `page-backlinks` | V-db∞, `params: ["pageId"]` (a join on `liveBlocks`) |
| `agent-notes-authors` | V-db∞, `params: ["blockId"]` (composite PK; contract §10) |
| `data-view-custom-values` | V-db∞, `params: ["dataViewId"]` (composite PK) |
| `data-view-row-order` | V-db∞, `params: ["dataViewId", "viewId"]` (composite PK) |
| `active-data.bindings` | V-db∞, `params: ["conversationId"]` (composite PK) |
| `slow-ops` | **Resource deleted.** A GET endpoint (`implement()`), and the pane reads it with `useEndpoint`. Update the precedent comment in `change-feed/server/internal/exclusion.ts:34`. |

### Wave 2 — values with a lifecycle (8)

These delete the hand-kept `unsubscribes` / `watchers` / active-set maps and the self-referencing `notify` (contract §2–3).

| Resource | Target |
|---|---|
| `jsonl-events` | V-ext, `params: ["id"]`, `revalidate` (memo signature), `whileSubscribed(({ id }, notify) => …)`: watchTranscript + prime, and a stop that unsubscribes and evicts. A sync start. |
| `subagent-activity` | V-ext, `params: ["id"]`, `revalidate`, `whileSubscribed` (a `watchPaths` room + prime; the stop evicts the memo and the conversation join). A sync start. |
| `subagent-transcript` | V-ext, `params: ["id", "by", "key"]`. The server re-parses `by` / `key` with `SubagentRefSchema`. `revalidate` is `subagentTranscriptMemo.signature(transcriptMemoKey(id, ref))`. `whileSubscribed` has a sync start that opens the `watchPaths` room, primes and notifies; its stop unsubscribes and evicts. The `unsubscribes` map and the `{kind:"unlinked"}` stand-in go. |
| `allow-files` | V-ext, `params: ["id"]`, `whileSubscribed` that returns a SYNC stop chained on the watcher promise. An async start would delay the sub-ack. |
| `commits-graph.graph` | V-db, `params: ["attemptId"]`, `recomputeOn: [refHeadServed]`, `revalidate`, and an eviction-only `whileSubscribed`. The `attempt-work` twin. The active set and the `unresolved("not loaded")` placeholder go. The body and chip render the read only once `attemptId` is known, so there is no `""` tuple. |
| `review.plugin-changes` | V-ext, `params: ["conversationId"]`, `throttleMs: 3000`, `recomputeOn: [{ value: editedFilesServed, params: ({ id }) => ({ conversationId: id }) }, refHeadServed]`. This is contract §2's own example. The plugin is excluded from the base composition, so verify with tsc and tests only. |
| `jobs-list` | Declared with `load: "on-demand"`. V-ext, `throttleMs: 1000`, `whileSubscribed: (_p, notify) => onQueueActivity(notify)`. |
| `queue-health.pulse` | V-ext, `throttleMs: 1000`, and a `whileSubscribed` that also hands `notify` to the deadline timer (it replaces the `subscribed` flag) |

### Wave 3 — lookup-only collections (10)

All follow the `todo-block-task` template (`from:` the entity-extension handle, which is an `EntitySource`).

| Resource | Read |
|---|---|
| `conversation-preprompts`, `conversation-progress`, `conversation-notes`, `turn-summaries` | `useLiveRow(c, conversationId)`. The server table handles already use the obvious names, so the declarations are named `…Rows`. |
| `conversation-categories` | `useLive(c, { ids })` + the existing `mapResource` |
| `usage-stats` | `useLive(c, { ids })`. The stamp uses `usageStats.rows.point.encode`. |
| `tasks-auto-start`, `task-efforts`, `task-preprompts` | `useLiveRow(c, taskId)`. The hooks narrow to `string`: every caller passes one. |
| `release.runs` (was `release.run`, a `{ id }` value) | Lookup over `_releaseRuns`, read with `useLiveRow`, so item 7 can add a window to the same declaration. |

**Barrier:** delete `usePointResource` and `usePointResources`, together with:
- their `window-hooks.test.tsx` cases and barrel exports;
- their `RESOURCE_HOOKS` entries and the `usePointResource` nullish branch (`no-pending-data-collapse.ts:588-590`);
- their lint-test fixtures (`no-pending-data-collapse.test.ts:150-270`), ported to `useLive` / `useResource` where a case still guards a real shape.

### Wave 4 — windowed collections (15, plus the `deploy` values and the `prompt-task-origins` fold)

| Resource | Declaration → read |
|---|---|
| `browser-bookmarks` | `filterable: { url }`, `sortable: ["createdAt"]`, 100 / 500. The bar and the start page read `useLive(c)`, and the star reads `{ where: { url }, limit: 1 }`. |
| `deploy.deployments` | `filterable: { serverId }`. Id lookups use `useLiveRow` (6 readers), the per-server list uses `where`, and `release-field` uses the default window. The dates move to `z.coerce.date()`. `remote-deploy-section` gates the row read and `deploy.runs` by hand, because a row read has no `data` for `useCombinedResources`. |
| `deploy.server-health` | `from:` the extension handle, `id: "serverId"`. Map readers use `useLive`, per-server reads use `useLiveRow`. The hooks stop collapsing pending into "never checked": 8 call sites decide pending explicitly. |
| `deploy.servers` (value), `deploy.runs` (value) | V-db∞ (the `sshKey` is derived from a central secrets lookup) and V-ext. They land with the two above, because readers combine them. |
| `mail-thread-messages` | `filterable: { threadId }`, default `internalDate desc` 100 / 500, reversed in the pane, `loadMore` for older messages |
| `pages-starred`, `pages-origin` | `from:` the extension handles, `filterable: {}`, the same defaults and max. Fix the vacuous `parentId` check in `agent-access-verify.ts:641`. |
| `build.history` | `from: _buildRuns`, `where: eq(namespace, runtimeNamespace())`, 50 / 50, declared with `preload: "boot"`. `build-info` / `build-fix` use `useLiveRow` (runs older than the top 50 are now found). No longer L2-persisted. |
| `conversation-summaries` | `filterable: { conversationId }`, `generatedAt desc` 20 / 200. The latest one is read with `{ where, limit: 1 }`. |
| `event-emissions`, `dead-jobs` | `emittedAt` / `archivedAt desc`, caps 1000 / 2000, `loadMore`. The `{ rows }` wrappers go. |
| `claude-cli-calls` | `filterable: { sourceName, model }`, chips via `groupBy: "sourceName"`, and the tier as a model `in` |
| `trash-entries` | `filterable: { sourceId }`, `deletedAt desc` 100 / 500 |
| `prompt-block-tasks` | `id: "taskId"`, `filterable: { blockId }`. `prompt-task-origins` is deleted: its reader uses `useLiveRow(promptBlockTasks, taskId)`. |
| `plugin-health-reviews` | `filterable: { pluginId }`. The pane's client filter becomes `where`. |
| `pushes` (was `pushes-by-attempt`) | `filterable: { attemptId }`, `createdAt desc`. The carrier is renamed `"pushes.attempts-cascade"` and moves server-only (update `tasks-core/web/internal/register.ts`'s comment). The review pane and code-review summary render the read only once `attemptId` is known. |

**Barrier:** delete `useWindowResource` / `window-hooks.ts` (with `window-hooks.test.tsx`), its barrel export and its `RESOURCE_HOOKS` entry.

### Wave 5 — Sonata (8)

| Resource | Target |
|---|---|
| `sonata-songs`, `sonata-playback-history`, `sonata-song-midi` | V-db∞, each reason naming item 7. Readers use `useLive(v)` with the same `.find` / Map builds. The dead `usePlaybackHistory` / `useSongMidi` go. |
| `sonata-chord-mode`, `sonata-key-auto-detect`, `sonata-transpose`, `sonata-rhythm` | Lookup over their extension handles, read with `useLiveRow(c, currentSongId)`. A null song reads `found: false`, so the default. |
| `sonata-track-view` | V-db∞, `params: ["songId"]` (composite PK). It is read by a keyed `<TrackViewObserver key={songId}>` publishing into a **new** `shell/web/track-view-store.ts`. `enqueueResourceWrite(trackViews, { songId }, …)` gives a per-song lane. |

**Design step, owned by one agent: pending is a state in the Sonata stores.**

- **The union.** `transpose-store`, `chord-mode-store`, `key-mode-store`, `rhythm-store` and the new track-view store each hold `{ pending: true } | { pending: false; value }`. Rhythm's `null` keeps meaning "no groove".
- **Song change.** `SonataProvider` (`shell/web/context.tsx`) resets all five to pending when `currentSongId` changes, and the observers write only settled values.
- **Gating.** `baseScore` (`score-gates.ts`), play-on-load and the toolbar setters wait until all five settle, so no frame renders or plays with a default or the previous song's value.
- **Consumers** handle the pending arm: the audio engine, the piano roll, notation, the keyboard, the mixer, and `useGroove`.

Accepted exception, recorded with the item-7 note: `usePlaybackHistoryMap` / `useSongMidiMap` keep their documented pending → empty-map collapse (the library sorts "never played" first). Item 7's joined columns replace them.

### Wave 6 — `page-blocks` (the high-risk one)

- **Target:** V-db∞, `params: ["pageId"]`, reason "one page's content forest — the reducer, the optimistic overlay and document order need every block". The loader is unchanged (`liveBlocks` subquery, `withRank`).
- **Readers:**
  - `block-store.ts` → positional `useOptimisticResource(pageBlocks, { pageId }, opts)`;
  - `composite-block-store.tsx` → `enqueueResourceWrite(pageBlocks, …)`;
  - panes / outline / version preview → `useLive`.
- **The design step: a gate component above `BlockEditorProvider`.**
  - `BlockStore` already carries `pending`, but the provider (`block-editor-context.tsx`, 2445 lines) reads `store.data` / `store.serverData` / `dispatch` in hooks that cannot be skipped. The positional pending arm has none of those.
  - So the gate renders the editor's loading state while the store is pending, and mounts the provider only with a settled store.
  - In the composite store, a pending child feed renders as loading in its own region, never as `[]` rows.
- **Delete the legacy object overload of `useOptimisticResource`** (`OptimisticBaseArgs`, the overload, the `"resource" in source` branch).
  - **Port, do not delete,** the 21 legacy-form cases in `use-optimistic-resource.test.tsx` (`useRows` / `mountHook`, `rowsResource`, `denialResource`, the inline `resourceDescriptor`s) to the positional `liveValue` form (`mountPositional` / `settledOf`). They cover confirmation, denial, watermarks and reconnect retry.
  - **Rewrite** the `no-pending-data-collapse.test.ts` fixtures at :336 and :388.
- **Update:** `page/editor/lint/no-adhoc-structural-write.ts` and its test, for the renamed declaration.

### Wave 7 — endgame

- **Move the factories:** `windowQueryResourceDescriptor` / `pointQueryResourceDescriptor` go into `network/live/core/internal/`, and are un-exported from `query-resource/core`.
  - **Their tests move too:** `window-descriptor.test.ts`, and `query-resource/server/internal/compile-window.test.ts` + `compile-window-runtime.test.ts` into `network/live/server/internal/`.
    - There they take the factories by relative path, and `compileWindowQuery` / `windowQueryResource` / `QueryDb` / `SelectMap` / `WindowQueryResourceSpec` from the `query-resource/server` barrel (or its `server/testing` barrel if R13 requires).
    - `query-resource` must never import `network/live`: its test files count as R6 edges, and that would close a cycle.
  - **Messages:** reword the guards at `compile-window.ts:118` / `:181` and the `spec.ts:187` / `:233` comments so they name `liveCollection`.
  - **Vocabulary:** `resource-vocabulary/core/vocabulary.ts` drops both entries. Fixtures follow: `eager-tier-gen.test.ts`, `parse-resources.test.ts`, `find-marker-calls.test.ts`.
- **Runtime:**
  - **Make `mode` required.** Split `ServerResourceOptions` into a keyed variant (no `mode`) and a non-keyed one (`mode` required), and require it on `DefineResourceInput` / `ResourceDefinition`.
    - Remove both `?? "invalidate"`s.
    - Update the facades that re-present the types (`server-core/core/resources.ts`, `central-core/core`) and every runtime test that omits `mode`.
    - The docs facet's "no mode ⇒ push" default in `parse-resources.ts` becomes moot, so remove it.
  - **Delete** the `rowIdentity` arm, `runtime-row-identity.test.ts`, its `keyed-resource-scope` entry, and the dead `live-state/web` re-exports.
- **Lint allowlist:** confirm it is the substrate globs plus tree / tick / config files, each commented with its item.
- **Docs and messages:**
  - root `CLAUDE.md` (:345-352: "New DB-backed live-state resources…" now points at `liveCollection` / `liveValue`) and `docs/abstractions.md`;
  - framework: `server-core/CLAUDE.md` (§`defineResource`), `web-sdk`, `resource-runtime`, `central-core`, `codegen`, `keyed-resource-scope`, `resource-vocabulary`;
  - primitives: `live-state/CLAUDE.md` (bounded-hooks and `select` sections), `query-resource/CLAUDE.md`, `optimistic-mutation/CLAUDE.md`, and the `entity-extensions/CLAUDE.md` recipe (still `pointQueryResourceDescriptor`);
  - remediation hints that name old spellings: `no-raw-sse`, `no-use-resource-cast`, `no-refetch-interval`, the `keyed-resource-scope` text, and the error at `notifications-client.ts:1746`;
  - `build/plugins/deployment/web/internal/register.ts`'s comment;
  - every migrated plugin's prose.
- **Records:**
  - a Result section in this doc, including the `initialData` deviation from contract §7;
  - "Phases after the proof" §3 marked done in the unified-API doc;
  - the Resources page status card, keeping the Wave 0 sub-bullets verbatim.

## Execution (ultracode)

Waves run serially. Each wave is one Workflow:

1. **Plan the clusters** (me, before the fan-out).
   - A cluster is the union-find closure of every resource in the wave whose declaration, serve or reader files overlap. The census has every reader, and a fresh `rg` of each declaration's importers confirms them.
   - This yields a file → agent ownership map: no file has two owners. Known merges:
     - W2: `jsonl-viewer` + `subagents`;
     - W4: `jobs` + `events` (`queue-view.tsx`); `deployments` + `health` + `servers` + `deploy.runs`;
     - W5: all of Sonata, stores included.
2. **Migrate** (one agent per cluster, in this worktree with no isolation: ownership is disjoint).
   - Each agent migrates declaration, serving, every reader (in any plugin), tests and prose.
   - It runs `./equin test` on every plugin it touched.
   - It never edits shared files: the lint allowlist, the scanner fixtures and root docs. It reports the edits those files need.
3. **Barrier** (me):
   - apply the shared-file edits, shrink the allowlist, and do the wave's hook deletions;
   - `./equin build` in the background. It regenerates docs, the eager tier and the registries, then runs every check, so check never runs standalone and fails on docs drift;
   - one fix agent per failing cluster;
   - the wave's e2e scripts and the boot-snapshot check.
4. **Review.**
   - One adversarial reviewer per cluster diff (`git diff $(git merge-base HEAD main)`), prompted to refute the migration:
     - contract conformance;
     - pending collapses;
     - a lost option (`throttleMs`, `preload`, `load`, `revalidate`, `whileSubscribed`);
     - a changed key or params an e2e or boot path depends on;
     - an unbounded reason that is not true.
   - Confirmed findings are fixed before the next wave.

## Critical files

- **API:**
  - `plugins/network/plugins/live/{web/internal/use-live.ts, core/internal/live-collection.ts, lint/ (new), CLAUDE.md}`;
  - `plugins/primitives/plugins/live-state/{web/window-hooks.ts, web/index.ts, core/resource.ts, lint/no-pending-data-collapse.ts (+ test)}`;
  - `plugins/primitives/plugins/optimistic-mutation/web/internal/use-optimistic-resource.ts` (+ `__tests__`);
  - `plugins/infra/plugins/query-resource/{core/index.ts, core/internal/window-descriptor.ts, server/internal/compile-window.ts, server/internal/spec.ts}`.
- **Framework (approved):**
  - `resource-runtime/core/runtime.ts` (mode required, `rowIdentity`) and its tests;
  - `server-core/core/resources.ts` (boot assert, type facade) and `central-core/core`;
  - `tooling/plugins/resource-vocabulary/{core/vocabulary.ts, check/index.ts}`;
  - `tooling/plugins/codegen/core/eager-tier-gen.ts` (+ test);
  - `tooling/plugins/checks/plugins/{no-db-backed-notify, keyed-resource-scope, no-raw-sse, no-use-resource-cast}`;
  - `tooling/plugins/lint/plugins/{reactive-server-io, entity-projection-safety, polling-safety}`;
  - the framework `CLAUDE.md` files;
  - autogenerated `*.generated.ts` (regenerated by build).
- **Scanners:** `plugin-meta/plugins/facets/plugins/resources/facet/parse-resources.ts` (+ test), `plugin-meta/plugins/parse-utils` (test fixtures).
- **Sonata stores (W5):**
  - `apps/sonata/plugins/shell/web/{transpose,chord-mode,key-mode,rhythm}-store.ts`, and a new `track-view-store.ts`;
  - `shell/web/{context.tsx, score-gates.ts, components/sonata-layout.tsx}`;
  - `track-mixer/web/hooks.ts`, and the audio engine / piano-roll / notation / keyboard consumers.
- **Editor (W6):** `page/plugins/editor/web/{block-store.ts, composite-block-store.tsx, block-editor-context.tsx}`, `page/plugins/editor/lint/no-adhoc-structural-write.ts`.
- **Call sites:** about 70 plugins, per the wave tables. Representative ones:
  - `apps/chord/*`, `apps/prototypes/files`, `conversations/conversation-view/jsonl-viewer`, `tasks/tasks-core`, `apps/deploy/*`.

## Verification

- **Per wave:**
  - `./equin test` on every touched plugin, plus `plugins/network/plugins/live`, `plugins/primitives/plugins/live-state`, `plugins/primitives/plugins/optimistic-mutation`, `plugins/framework/plugins/resource-runtime`, `plugins/infra/plugins/query-resource`, `plugins/plugin-meta/plugins/facets/plugins/resources` and `plugins/framework/plugins/tooling`;
  - `./equin build`: type-check, eslint with the new rule, `resource-vocabulary`, `eager-tier-in-sync`, `keyed-resource-scope`, `no-db-backed-notify`, `plugins-doc-in-sync`, `plugin-boundaries`;
  - the optimistic-mutation suite's case count never drops.
- **Boot snapshot** (after W1 and W4): `GET /api/resources/boot-snapshot` on the worktree deploy must contain:
  - `agents`, `worktree-ops`, `release.previews`, `conversations-gone-stats`;
  - `build.history`, after W4.

  Also confirm with `query_db` that `live_state_snapshot` still holds rows for `agents` and `conversations-gone-stats`. The Wave 0 boot assert catches a missing declare at boot.
- **New tests:**
  - `useLiveRow(c, null)` (above);
  - `no-legacy-resource-spelling`: RuleTester for the flagged call and import, plus a `buildLintConfig` test that an allowlisted file is exempt;
  - `no-db-backed-notify`: flags a `serveValue` external loader that reads `db.`;
  - the boot assert throws for an undeclared preloaded resource;
  - the runtime rejects a missing `mode` (`@ts-expect-error`);
  - the Sonata stores' pending arm;
  - the editor gate renders loading, never an empty page.
- **E2E by wave** (all paths verified to exist):
  - **W1:**
    - chord: `trainer-verify`, `curriculum-verify`, `song-index/flows`, `piano-shot`;
    - prototypes: `canvas-size`, `canvas-version`, `canvas-picks-persist`, `present-verify`, `thumbnail-cover`, `files/touch`;
    - config: `conflict-agent-verify`, `config-detail-shot`;
    - page: `editor-collab/crdt-adjacent-surfaces-verify` (checks `page-backlinks`), `agent-access-verify` (checks `agent-notes-authors`);
    - `bell-filter` (regression).
  - **W2:** `allow-monitor/allow-chip`, `rewind`, the jsonl-viewer scripts.
  - **W3:**
    - `auto-start-verify`, `launch-options-verify`, `prompt-templates/usage-order --conv <id>`;
    - a `screenshot.ts` pass on one conversation showing its progress bar, preprompt chip, notes, turn summary and category avatar.
  - **W4:**
    - `starred-verify`, `agent-access-verify` (after the `parentId` fix);
    - `build/popover-logs`, plus a `build-info` check on a run older than the top 50;
    - deploy: `local-serve-verify`, `remote-deploy-verify`, `investigate-failure`;
    - `mail/mailbox-tabs-verify` (on seeded rows, since mail tables are `ExcludeFromFork`);
    - `prompt/block/prompt-launch`, `events/live-sources` (regression);
    - **the pushes cascade:** after a fresh boot with no subscriber, land a push in the worktree DB; the attempt's derived status and the task-events push list both update, and the read-set debug shows `pushes.attempts-cascade` → `attempts`.
  - **W5:**
    - `track-mixer/track-fader`, `library/cell-affordance`;
    - the new `sonata/e2e/song-switch.ts`: set transpose, chord mode and a muted track on song A; reload; switch to B and back. Assert that nothing leaks, that no default frame renders or plays, and that the settings persist.
  - **W6:**
    - editor: `structural-write-order-verify`, `paste-optimistic-verify`, `structural-atomicity-verify`, `drag-reorder-verify`;
    - `crdt-multitab-agent-verify`, `crdt-fanout-verify`, `crdt-offline-verify`, `crdt-newblock-verify`;
    - `agent-access-verify` (checks `page-blocks`).
- **Runtime:**
  - `get_runtime_profile`: loader spans for the new keys, no new flush stall;
  - `get_timeline`: no stall event;
  - `live-state` logs: no sub-error or divergence.
- **Final:** `no-legacy-resource-spelling` passes with its ignores equal to the substrate globs plus the tree / tick / config files, each commented with item 3, 7 or 9.

## Result (2026-09-27)

All eight waves landed on this branch, and the tree is uncommitted pending review. Every in-scope resource is on
`liveValue` / `liveCollection` / `useLive` / `useLiveRow`:

- 44 values;
- 14 lookup-only collections;
- 15 windowed collections;
- `slow-ops` replaced by a GET endpoint;
- `prompt-task-origins` folded into `prompt-block-tasks:rows`.

The old spellings remain only in the tree (item 3), revision-tick (item 7) and config (item 9) files and the substrate. The
`live/no-legacy-resource-spelling` lint enforces this: its `ignores` list is the 94-file inventory of what is left, grouped by
item. Each wave's builds and checks passed.

### End state

- **Vocabulary:** 7 descriptor factories → 5 (`resourceDescriptor`, `keyedResourceDescriptor`,
  `queryResourceDescriptor`, `liveValue`, `liveCollection`).
  - `windowQueryResourceDescriptor` / `pointQueryResourceDescriptor` are internal to `network/live`
    (`core/internal/window-descriptor.ts`), and their tests moved with them.
  - `compileWindowQuery` is published from `query-resource/server/testing` (R13).
- **`mode` is required** on every non-keyed old server form. The runtime's `?? "invalidate"` default is deleted.
  - `ServerResourceOptions` is split into a keyed variant (`KeyedServerResourceOptions`, no `mode`) and a non-keyed one.
  - The docs facet throws on a missing `mode` instead of guessing.
- **Deleted:**
  - `usePointResource`, `usePointResources` (Wave 3 barrier) and `useWindowResource` (Wave 4 barrier), each forced by R13;
  - the legacy object form of `useOptimisticResource` (Wave 6);
  - the `rowIdentity` scope arm;
  - the unused `live-state/web` re-exports of the old factories.
- **New API surface:** `useLiveRow(c, id | null)`. A null id reads the shared `{ ids: "" }` tuple and settles `found: false` on the
  first render. `useResource` gained no option.
- **`useLive` identity:** a list result and its `loadMore` keep their identity until rows, state or limit change, and
  `useLiveRow` is memoized the same way. Before this, per-row consumers such as the page-tree star rebuilt their sets on every render.
- **New guards:**
  - the legacy-spelling lint, which flags imports, re-exports, namespace and dynamic-import reads;
  - a boot assert that every preloaded registered resource has a `Resource.Declare`, run in serve and exec before the barrier;
  - `no-db-backed-notify`, which also scans `serveValue` external loaders;
  - `no-hand-rolled-entity-projection`, which also covers `serveValue` loaders;
  - `no-reactive-server-io`, which now watches `useLive` / `useLiveRow`.

### Deviations from the plan

- **Lint:** it flags imports, not calls, since every call needs an import. The allowlist test also requires each listed file to still
  import an old spelling, so a barrier cannot forget to delete an entry.
- **Hook deletions:** they happened at the Wave 3 and Wave 4 barriers, not Wave 7, because R13 fails a public name whose only importer
  is a test.
- **Sonata (Wave 5):** the design went further than planned.
  - Content and settings share one per-surface state (`shell/web/loaded-song.tsx`) with a single song id, so one song's
    content cannot be paired with another's settings, whatever the call order. This also fixes a background-play leak found in review.
  - Settings register through a `Sonata.SongSetting` slot, and the score gate waits only on registered settings. A composition
    without a feature cannot hang the player, and the shell names no feature.
  - Observers are keyed on a load generation, so a same-song re-arm cannot stay pending.
  - The track-view setting lives in `track-mixer`, not in a shell store.
- **`page-blocks` (Wave 6):** a type-enforced `BlockEditorProviderGate` mounts the provider only with a settled store. The composite store
  renders a still-loading child page as a loading region under its anchor (`loadingBelow`), never as `[]`. All 21
  legacy-form optimistic tests were ported (27 cases before and after).
- **Naming:** declarations are named `…Rows` or otherwise renamed where a server table handle already takes the obvious name (`agentRows`,
  `pushRows`, `conversationProgressRows`, `serverHealthRows`, `songMidiRows`).
- **Constants:** `event-emissions` / `dead-jobs` `maxLimit` now read the same constants as their prune caps (`EMISSIONS_CAP`,
  `DEAD_JOBS_ARCHIVE_CAP`).
- **`initialData`** stays on `ResourceDescriptor`, a deviation from contract §7. The window / point / groups descriptors and the tree,
  tick and config descriptors still seed it; no optimistic read uses it as a base any more.

### Verification

- **Builds:** `./equin build` (all checks) passed at every barrier. The boot snapshot still carries `agents`, `worktree-ops`,
  `release.previews`, `conversations-gone-stats` and `build.history`. `agents` and `conversations-gone-stats` keep their
  `live_state_snapshot` rows.
- **Full suite:** `./equin test` fails 32 cases.
  - All 32 fail identically on a clean checkout of the branch base, or come from the pre-existing `define-extension.test.ts`
    module-mock leak.
  - The branch fixes the base's 24 `views.test.ts` failures.
- **E2E:** waves 1–4 found no migration-caused failure; every failure reproduced identically on main.
  - The one worktree-only failure, `toc-lands-on-right-message`, was diagnosed as the script's own settle timing under host load. It
    reproduces the same way on main and passes 9/9 on a quiet rebuild.
  - **Waves 5–7:** 16 of 18 scripts passed (every editor, CRDT, optimistic, Sonata and build script). `crdt-adjacent-surfaces-verify`
    matched its known 3/5 baseline.
    - The new `sonata/e2e/song-switch.ts` passes 31/31, twice. It reaches controls that the toolbar moved into its `⋯` overflow
      panel through a new helper, `primitives/adaptive-bar/e2e/reach.ts` (`reachInBar`).
    - `queue-reorder.ts` scores 7/11 on main as well. `49a1e10d3` (rank-reorder sliding) made its drop positions and drop-indicator
      selector stale. The fix is to drop on the target row's centre, like `data-view/list/e2e/sortable-reorder.ts`.
    - `bell-filter.ts` was off by one once, from live notification traffic, and passed on retry.
- **Resources page:** the `initialData` deferral is recorded under item 9, next to the config deferral. It says what still seeds the
  field and when it can go.
- **Pushes cascade:** `pushes.attempts-cascade` → `attempts` is present in the runtime registry (`_debug`), downstream and upstream. A
  dynamic push-landing test was not possible without a real push.
- **Runtime:** no new flush stall.
  - The element slow-ops for per-row `:rows` reads match main's volume under the old keys, so they predate this migration.

### Pre-landing review (second session)

- **Two review rounds**, read-only, with every finding checked by two independent verifiers.
  - By area: 22 reviewers, one server-side and one client-side lens per area group, plus sweeps over wire keys / boot and over
    invalidation / notify paths.
  - By resource: 10 reviewers, one per wave, tracing each resource from its declaration through the server to every reader against the
    base.
- **One real defect, now fixed.** `deploy.deployments` and `deploy.server-health` were whole sets at the base. Two readers still treated
  the new 100-row default window as every row, so past 100 rows they silently dropped answers:
  - the Release column (`remote-deploy/web/components/release-field.tsx`);
  - `useServerHealthMap()`.

  Fix — each reader asks for exactly the rows it shows:
  - `useServerHealthMap(serverIds)` reads `useLive(serverHealthRows, { ids })`. The servers Status column gets the ids from the
    whole-set `servers` value, now exported from `servers/web`.
  - The Release column asks the host list's own `{ where: { serverId } }` query, through `useDeploymentsListServerId()`. That context
    is provided by `DeploymentsBody` around its `DataView`, and it throws outside it.
- **Re-verified after the fix:**
  - the build, all checks included;
  - the full suite: exactly the 32 known failures;
  - the six e2e smoke scripts, all passing (song-switch 31/31, structural-write-order 19/19, crdt-multitab-agent 9/9,
    bell-filter 24/24, live-sources 18/18, popover-logs 13/13) — every first-attempt failure was host-load timing or the
    known bell-filter off-by-one, and cleared on retry;
  - the deploy server page, where the Status and Release columns render.
- **Integrated with main** (`3e2a9a0db`, four commits past the old base; ten shared paths three-way merged, two resolved by hand).
  Seven adversarial merge / interplay reviewers found nothing, and all of the following re-passed afterwards:
  - the build, including main's new `type-scale:closed-role-ladder` check;
  - the full suite: only known failures;
  - the smoke scripts, plus the jsonl-viewer scripts, which cover main's new empty-transcript states over the migrated `jsonl-events`;
  - the boot-snapshot check.

### Follow-ups found (pre-existing unless noted)

- **Stale value after reconnect:** an external value whose `notify` is connected only `whileSubscribed` and that has no `revalidate`
  can stay stale after a same-boot reconnect (`queue-health.pulse`, `jobs-list`, `allow-files`). The fix belongs in
  `compile-value.ts`: exclude such values from the version short-circuit, or mark the tuple stale on stop.
- **Duplicate transcript push:** every transcript open pushes the whole `jsonl-events` value twice (the sub-ack, then the watcher's first notify, about 1 MB).
- **Test isolation:** `infra/entity-extensions/server/internal/define-extension.test.ts:37`'s `mock.module` of `@plugins/database/server` leaks
  into every later bun test file (16 DB tests fail in every full run).
  - The same species: in a full run, `shell/toast/web/internal/live-toasts.test.ts` reports "Unhandled error between tests" ("the stub
    missed it"). Its `mock.module("react", …)` fires after the module under test has already loaded, so its stub is never called. It
    passes alone, and a clean base checkout shows the identical error.
- **RuleTester wiring:** 77 RuleTester suites lack bun `describe` / `it` wiring, so their failures surface as "Unhandled error between tests".
- **Test scripts and harness:**
  - `toc-lands-on-right-message.ts` should wait on `scrollend`;
  - `conflict-agent-verify.ts`'s `--path` collides with the harness flag;
  - `screenshot.ts` `--click` resolves an app-rail button before a tab of the same name;
  - `remote-deploy-verify.ts` looks for the composition name without expanding the collapsed Deployments card, so it times out.
- **Sonata:** the chord-grid / ultimate-guitar persist observers pair `currentSongId` with the loaded song's raw content. A debounce masks a
  wrong-song save today.
- **`page-blocks` (new with this branch):**
  - an op aimed at a still-loading child page throws;
  - a child page whose load fails shows loading, with the error only in `sync-status`;
  - an in-place `pageId` change remounts the editor provider.
- **Data-view field extensions:** `FieldExtensionProps.render` has no loading state, so custom columns, starred, agent-origin and
  source-field show a default while loading.
- **Other:**
  - `Resource.Declare.from` / `getContributionsIfCollected` are typed but `undefined` at runtime (`server-core/core/resources.ts`);
  - an agent whose row is gone shows loading forever in its side pane;
  - the SSH-setup card opens by default while health loads (`useDefaultOpen` takes only a boolean).
