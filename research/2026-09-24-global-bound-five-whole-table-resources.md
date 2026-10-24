# Bound five whole-table live resources — plan

## Context

Five Postgres-backed live resources load, and push, their whole table although every reader
needs one row (or one page). Audit: page "Live resources — audit and target model" §10.2;
contract: `research/2026-07-18-global-bounded-working-set-resource-contract.md` (the
2026-07-18 plan's ranking never saw them — not in the persisted boot snapshot).

What the code pass found (corrects the task text):

| Resource | Table | Rows on main | Readers | Real cost today |
|---|---|---|---|---|
| `turn-summaries` | `conversations_ext_turn_summary`, pk `conversationId` (upserted — **one row per conversation**, not per turn) | 0 (feature off) | `TurnSummaryCard`: `data[conversation.id]` | bootCritical ⇒ L2 persist + boot payload; whole map to every tab per turn |
| `conversation-summaries` | `conversation_summaries`, pk `id`, append-only, many per conv, index `(conversationId, generatedAt)` | 2 | `SummarizeButton`, `SummaryPane`: `data[convId][0]` (latest) | whole map on every Summarize |
| `task-efforts` | `tasks_ext_effort`, pk `taskId` | 6 | `useTaskEffort(taskId)` | whole map |
| `task-preprompts` | `tasks_ext_preprompt`, pk `taskId` | 505 | `useTaskPreprompt(taskId)` | whole map |
| `reports` | `reports`, pk `id`; **excluded from the change feed** | 1,759 (~1.7 MB) | Reports DataView (client-side filter/sort over all rows), detail pane + pane-resolve (`.find` by id) | NOT re-sent per report (nothing notifies); the whole table is loaded on every pane open, and it never live-updates. Retention sweeps only rows with `taskId IS NULL`, so investigated reports live forever |

Every reader of the first four looks up exactly one id — no reader needs the collection.

## Approach

### 1. Point ports — `turn-summaries`, `task-efforts`, `task-preprompts`

Exact twin of `tasks-auto-start` (commit `e075ccc17`) / `conversation-progress`:

- **Descriptor** (`shared/schemas.ts`): `resourceDescriptor<Record<…>>` →
  `pointQueryResourceDescriptor<Row>(key, <Shape>.schema, "<conversationId|taskId>")`
  (`@plugins/infra/plugins/query-resource/core`). Drop the `*PayloadSchema` record types.
  `turn-summaries` loses `bootCritical` (point resources hydrate post-mount — recorded decision;
  the card already renders nothing while pending). Keys unchanged.
- **Server** (`server/internal/resource.ts`): `defineResource({loader: fold…})` →
  `windowQueryResource(descriptor, { from: <extension handle>, point: { by: <handle>.table.<pk> } })`.
  No `select` (entity ⇒ wire columns). task-effort / task-preprompt currently call the legacy
  `defineResource({ key, … })` form without the descriptor — switch to the descriptor form.
- **Web hooks**: `useTaskEffort` / `useTaskPreprompt` → the `useTaskAutoStart` shape
  (`usePointResources(resource, taskId ? [taskId] : [])` + `mapResource(rows => rows[0]?.x ?? null)`),
  keeping `ResourceResult<T | null>` so pending never reads as "none".
  `TurnSummaryCard` → `usePointResource(turnSummariesResource, conversation.id)`.
- Update the `no-pending-data-collapse` lint test fixture that names `taskEffortsResource` only if it
  imports the real symbol (it is an inline source string — likely untouched).
- The boot-time stale-snapshot sweep (`clearSnapshotsExceptKeys`) deletes the old
  `turn-summaries` L2 row generically — nothing to do.

### 2. `conversation-summaries` — per-conversation keyed resource

Point does not fit: `point.by` must be the identity pk, and the pk is the summary `id` (many
rows per conversation). Use the `pushes-by-attempt` precedent
(`plugins/tasks/plugins/tasks-core/{core,server/internal}/resources.ts`) — a param-scoped
keyed resource, allowed by the contract ("per-key params … are fine"):

- **Descriptor** (`core/resources.ts`): `keyedResourceDescriptor<ConversationSummary[], { conversationId: string }>(
  "conversation-summaries", z.array(ConversationSummarySchema), [], (r) => r.id)`.
- **Server**: `defineResource(descriptor, { identityTable: "conversation_summaries", fanOut: { reason: "params key is the foreign column conversation_id; …" }, loader: ({conversationId}, ctx) => ctx?.affectedIds ? WHERE conv = X AND id IN affected : WHERE conv = X ORDER BY generatedAt DESC })`.
  Bounded by one conversation's Summarize presses; served by the existing
  `(conversationId, generatedAt)` index.
- **Web**: one domain hook `useLatestConversationSummary(convId)` →
  `mapResource(useResource(res, { conversationId }), rows => max-by-generatedAt ?? null)`
  (a scoped upsert appends, so pick the latest explicitly rather than trusting `[0]`).
  `SummarizeButton` and `SummaryPane` use it (pane handles an absent `convId` via the hook's
  nullable form, same pattern as auto-start: skip-subscribe when null — check `useResource`'s
  gate option; else split the component).

### 3. `reports` — server-paged DataView + by-id read + in-memory tick

The table stays excluded from the change feed (crash-storm safety); the list moves to the
endpoint + tick mechanism already used by release history / runs / events.

- **List endpoint** `POST /api/reports/query` (`plugins/reports/core` endpoint +
  `server/internal/handle-query.ts`), cloned from
  `plugins/release/server/internal/handle-history-query.ts`: `COLUMN_MAP` for
  `kind`(enum) `source`(enum) `noise`(bool) `rateLimited`(bool) `count`(int) `lastSeenAt`(date);
  default sort `lastSeenAt desc`, pk `id` tiebreaker; `searchWhere` = ILIKE over
  `message` / `kind` / `fingerprint`; `compileWhere` + `augmentServerQuery` + keyset
  (`primitives/keyset`); body schema = the release body minus `composition`.
- **Index**: add `index(lastSeenAt, id)` on `_reports` (migration generated by the build).
- **Facets endpoint** `GET /api/reports/facets` → `{ kinds, sources }` (`SELECT DISTINCT`),
  replacing the enum options the view derives from all rows today. Refetched when the tick moves.
- **Detail**: `GET /api/reports/:id` (404 → "Report not found."). `ReportDetail` and
  `useResolveReport` (panes.tsx) read it via `useEndpoint`; the Investigate mutation invalidates it.
  A report opened from the bell resolves whatever its age.
- **Tick** `reports.revision`: a `defineExternalResource` holding an in-process counter (no DB
  read, satisfies `no-db-backed-notify`), `mode: "push"`, `debounceMs: 2000` so a storm costs at
  most one refetch per 2 s per open pane. `recordReport` bumps it after a durable write on the
  non-rate-limited path (exactly where the stale "skips the resource notify" comments in
  `tables.ts` / `velocity.ts` say it should — they become true again); `investigateReport`
  bumps it too. Duress-buffered writes bump on flush.
- **Web** (`plugins/debug/plugins/reports/web/components/reports-view.tsx`): `DataView` with
  `dataSource={{ changeTick, fetchPage }}` (release-history-section pattern); field defs stay,
  `options` from the facets endpoint.
- **Delete** `reportsResource` (core descriptor, server resource, `Resource.Declare`) and update
  the references: `change-feed` `exclusion.ts` comment + `CLAUDE.md` line 117,
  `identity-coverage.test.ts` (uses the name as a string fixture — keep or rename the fixture),
  `plugins/debug/plugins/reports/CLAUDE.md`, `plugins/reports/CLAUDE.md` prose.

### 4. Docs

- Audit page §10.2: write an agent note (not the author's prose) recording that these five are
  done, plus the two corrections (turn summaries are one row per conversation; reports were
  load-on-open, not per-report re-sends; investigated reports escape retention).
- `plugins-details.md` / per-plugin CLAUDE.md autogen blocks regenerate on build.

## Critical files

- `plugins/conversations/plugins/conversation-view/plugins/turn-summary/{shared/schemas.ts,server/internal/resource.ts,web/components/turn-summary-card.tsx}`
- `plugins/tasks/plugins/task-{effort,preprompt}/{shared/schemas.ts,server/internal/resource.ts,web/hooks.ts}`
- `plugins/conversations/plugins/summary/{core/resources.ts,server/internal/resources.ts,web/components/{summarize-button,summary-pane}.tsx}`
- `plugins/reports/{core/resources.ts,core/routes.ts or endpoints,server/index.ts,server/internal/{resources,tables,record-report,investigate}.ts}` + new `handle-query.ts`, `revision.ts`
- `plugins/debug/plugins/reports/web/{panes.tsx,components/reports-view.tsx,components/report-detail.tsx}`

Reuse: `windowQueryResource` / `pointQueryResourceDescriptor` (`infra/query-resource`),
`usePointResource(s)` / `mapResource` (`primitives/live-state/web`), `compileWhere` /
`augmentServerQuery` (`data-view/plugins/server-query/server`), keyset
(`primitives/keyset`), `resolveFieldFilterSql` (`fields/plugins/server-capabilities`).

## Verification

1. `./equin test plugins/infra/plugins/query-resource plugins/database/plugins/change-feed plugins/primitives/plugins/live-state`.
2. `./equin build` (background) → green; `plugins-registry` / docs checks pass.
3. On the worktree: `GET /api/resources/_debug` shows `turn-summaries` / `task-efforts` /
   `task-preprompts` as point membership, `conversation-summaries` as a param-keyed tuple,
   no `reports` key; `live_state_snapshot` has no `turn-summaries` row; boot snapshot lacks it.
4. Screenshot / e2e via `screenshot.ts`: task detail Prompt card shows effort + preprompt
   (set one, confirm it updates live); a conversation's Summary pane + button badge; the
   turn-summary card; Debug → Reports lists newest-first, scroll pages more, kind filter options
   present, search works; open a report older than the first page by URL → detail renders;
   POST a test report → list refreshes within ~2 s.
