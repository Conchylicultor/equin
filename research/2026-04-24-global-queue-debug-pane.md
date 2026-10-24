# Queue Debug Pane

## Context

We now have two layered primitives with no observability:

- **`jobs`** (layer 1) — wraps `graphile-worker`. Jobs live in `graphile_worker.jobs` with columns for `attempts`, `max_attempts`, `run_at`, `locked_at`, `last_error`. Completed jobs are **deleted**; permanently-failed ones (`attempts >= max_attempts`) stay forever as a de-facto dead-letter.
- **`events`** (layer 2) — one trigger table per event; `emit()` finds matching enabled triggers and enqueues a wrapper dispatch job per match. **Emissions leave no trace** once their dispatch jobs complete.

Today the only way to debug "why didn't my trigger fire" or "why is this job stuck" is manual `psql` — which events-test works around with ad-hoc endpoints. We want one Debug pane that answers:

- What's currently in the queue? (pending / running / retrying / dead-letter)
- What events have fired recently, and which triggers did they match?
- What triggers are currently registered?
- Can I retry a dead job / cancel a stuck one / delete a stale trigger?

Industry references: Bull-Board (tabs per state + drawer), Sidekiq Web, Hasura Event Triggers (crucially persists an *invocations log* because events are otherwise ephemeral), Temporal UI (event-history-as-timeline).

## Decisions (from user)

1. **Single unified Debug.Item "Queue"** with tabs — reflects that events layer on top of jobs and users need to trace flow end-to-end.
2. **Add a capped `event_emissions` log table** — without it, debugging "my event went nowhere" stays blind.
3. **Admin actions**: retry failed/dead-letter, cancel/delete job, disable/delete trigger. **No** re-emit (deferred).

## Plan

### 1. New plugin: `plugins/debug/plugins/queue/`

Follows the existing nested-under-debug pattern (mirrors `logs`, `worktree-cleanup`, `db-backup`).

- `web/index.ts` — barrel export `definePlugin(...)` contributing `Debug.Item "Queue"` and declaring the pane.
- `web/panes.ts` — `queuePane = Pane.define({ path: "/debug/queue", ... })`.
- `web/components/queue-view.tsx` — tab bar (Jobs / Events / Triggers) + active tab content. Polls at 2 s using the same `setInterval(refresh, 1000–2000)` pattern used by `events-test` and `worktree-cleanup` — no push resource for a debug tool.
- `web/components/jobs-tab.tsx`, `events-tab.tsx`, `triggers-tab.tsx` — one component per tab.
- `server/index.ts` — no new routes here; routes live on the source plugins (see §3, §4).

### 2. Event emission log (events plugin)

New table in `plugins/events/server/internal/tables.ts`:

```ts
export const _event_emissions = pgTable(
  "event_emissions",
  {
    id: uuid().primaryKey().defaultRandom(),
    eventName: text().notNull(),
    payload: jsonb().notNull(),
    emittedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    matchedCount: integer().notNull(),
    matchedTriggerIds: jsonb().$type<string[]>().notNull(),
  },
  (t) => [index("event_emissions_emitted_at_idx").on(t.emittedAt.desc())],
);
```

Write path: extend `dispatch()` in `plugins/events/server/internal/event.ts:153` to insert one row after it queries matching `rows`, before enqueuing dispatch jobs (so the log captures the match outcome including zero-match emissions). Prune inline inside the same transaction:

```ts
// keep ~1000 most recent
DELETE FROM event_emissions
 WHERE emitted_at < (SELECT emitted_at FROM event_emissions
                     ORDER BY emitted_at DESC OFFSET 1000 LIMIT 1);
```

Export `_event_emissions` from `plugins/events/server/index.ts` so the drizzle schema picker registers the migration.

### 3. Jobs plugin: new routes

Add a small server barrel + routes file under `plugins/jobs/server/`:

- `GET /api/jobs?state=pending|running|retrying|dead&limit=200` — SELECT from `graphile_worker.jobs` WHERE `task_identifier='jobs.run'`, derive state from `attempts`/`max_attempts`/`locked_at`, return `{id, jobName (from payload.jobName), input (from payload.input), state, attempts, maxAttempts, runAt, lockedAt, queueName, lastError}`.
- `POST /api/jobs/:id/retry` — uses `getWorkerUtils().rescheduleJobs([id], { attempts: 0, runAt: new Date() })`. Works on both retrying and dead-letter rows.
- `DELETE /api/jobs/:id` — uses `getWorkerUtils().completeJobs([id])` to remove the row.

Graphile's `WorkerUtils` (`plugins/jobs/server/internal/worker.ts:26`) already exposes these — no new dependencies.

State derivation helper (pure function, lives in `plugins/jobs/server/internal/state.ts`):

| state      | predicate                                          |
| ---------- | -------------------------------------------------- |
| running    | `locked_at IS NOT NULL`                            |
| dead       | `attempts >= max_attempts`                         |
| retrying   | `attempts > 0 AND attempts < max_attempts`         |
| pending    | otherwise                                          |

### 4. Events plugin: new routes

- `GET /api/events/emissions?limit=200` — SELECT from `event_emissions` ORDER BY emittedAt DESC.
- `GET /api/events/triggers` — union across all `triggerTableRegistry` tables (`plugins/events/server/internal/registry.ts:7`). Returns `{eventName, id, jobName, jobWith, enabled, oneShot, createdAt, filters: {col:value}}` for each row.
- `DELETE /api/events/triggers/:id` — thin wrapper over existing `deleteTrigger(id)` in `plugins/events/server/internal/trigger.ts:57`.
- `PATCH /api/events/triggers/:id` body `{enabled}` — sweeps all trigger tables (same pattern as `deleteTrigger`), updates `enabled`.

### 5. UI per tab

All three tabs use a shared `<QueueTable>` component (kept local to `plugins/debug/plugins/queue/web/components/queue-table.tsx`) that takes columns + rows + per-row action buttons — same style as `worktree-cleanup-panel.tsx`'s raw table.

**Jobs tab.** Header chips filter by state (All / Pending / Running / Retrying / Dead — counts badge). Columns: `state` (colored dot), `jobName`, `attempts/max`, `runAt` (relative), `queue`, `lastError` (truncated + tooltip). Row click opens a drawer with full `input` JSON, full `lastError`, all timestamps. Actions per row: **Retry** (shown on `retrying` + `dead`), **Cancel** (shown on `pending`). Running rows are non-actionable.

**Events tab.** Columns: `emittedAt` (relative), `eventName`, `payload` (first ~80 chars), `matchedCount` (badge; 0 in red). Row click → drawer showing full payload + a sub-table of matched trigger ids with their target jobName + dispatch-job status (join against `graphile_worker.jobs` on a best-effort basis — the dispatch job may already be gone if it succeeded, which is itself useful information: "matched, delivered, done").

**Triggers tab.** Group-by event name (collapsible sections). Columns: `jobName`, `jobWith` (truncated JSON), `filters` (key=value chips), `oneShot`, `enabled` (toggle switch), `createdAt`. Actions: **Delete** (confirm inline like worktree-cleanup's dirty-check). Toggle switch calls PATCH `enabled`.

### 6. Reused primitives

- `Pane.define` — `plugins/pane/web/pane.ts`
- `Debug.Item` slot — `plugins/debug/web/slots.ts`
- `WorkerUtils.rescheduleJobs / completeJobs` — already lazy-initialized in `plugins/jobs/server/internal/worker.ts`
- `triggerTableRegistry` — `plugins/events/server/internal/registry.ts:7`
- `deleteTrigger` — `plugins/events/server/internal/trigger.ts:57`
- shadcn `Button`, `Badge`, `Switch`, `ScrollArea` (already used across debug panes)

### 7. Non-goals (deferred)

- Re-emit from emission log (requires replay semantics; user deferred).
- Throughput charts (can add a `Stats.Chart` contribution later — the emission log makes it cheap).
- Per-job trace/log integration with the `Log` plugin.
- Cron/scheduled-job view (graphile-worker supports it; no plugin uses it yet).

## Files touched

New:
- `plugins/debug/plugins/queue/web/{index.ts, panes.ts, components/*.tsx}`
- `plugins/debug/plugins/queue/server/index.ts` (barrel, empty contribute)
- `plugins/debug/plugins/queue/package.json`
- `plugins/events/server/internal/tables.ts` (add `_event_emissions`)
- `plugins/jobs/server/internal/state.ts` (state-derivation helper)
- `plugins/jobs/server/routes.ts` + wire into plugin barrel
- `plugins/events/server/routes.ts` + wire

Modified:
- `plugins/events/server/internal/event.ts` — `dispatch()` writes emission row
- `plugins/events/server/index.ts` — export `_event_emissions`
- `plugins/jobs/server/index.ts` — export new routes
- `plugins/debug/web/CLAUDE.md` / `docs/plugins.md` — regenerated by `./equin build`
- `web/src/plugins.ts`, `server/src/plugins.ts` — register `queue` plugin

## Verification

1. `./equin build` — deploys; verifies the migration for `event_emissions` is generated and applied.
2. Open `http://<worktree>.localhost:9000` → sidebar → Debug → Queue. Three tabs render, polling works.
3. In another tab hit `POST /api/events-test/emit` a couple of times. Events tab should show the emissions within 2 s; matched-count should match expected triggers.
4. In events-test, subscribe a trigger to a non-existent job so it permanently-fails. Jobs tab → Dead filter: row appears with `lastError`. Click **Retry** → attempts resets, row moves back to Retrying then returns to Dead.
5. Triggers tab → toggle a trigger's Enabled off → emit the event → verify emission row shows matchedCount = 0 and no new dispatch job appears.
6. Triggers tab → Delete a trigger → confirm row disappears from the tab AND from the underlying `{event}_triggers` table (spot-check with `psql`).
7. Let the events-test emit loop run > 1000 times → verify `event_emissions` row count stays ≈ 1000 (pruning works).
