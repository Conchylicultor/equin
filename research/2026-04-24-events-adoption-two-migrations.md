---
name: Events adoption — push-and-exit + auto-build migrations
status: ready-to-implement
scope: Replace two hand-rolled async patterns with the new events/actions API.
---

# Events adoption — two migrations

## Context

The `events` plugin was recently extended with a Graphile Worker backend (commit `74fbdf8`) that makes `.emit()` → action dispatch durable across server restarts and retryable on transient failure. The plugin ships with `events-test` as the only consumer. Before defining new events (`taskCompleted`, `conversationCompleted`, etc.), we want to retire two *existing* hand-rolled patterns that overlap what the events API now does for free:

1. **`push-and-exit` job runner.** An in-memory `jobs = new Map<string, JobState>()` + fire-and-forget `void runJob(id)` + 10-minute transcript polling loop. Classic at-least-once reinvention: the job is lost on restart, the verdict is not persisted, and the UI has to re-trigger. Today this "works" only because the verdict token lands in the transcript, so a second run finds it quickly — but it's obviously the wrong shape.
2. **`auto-build-watcher` polling.** A `setInterval` every 2s polls `getLatestPush()` to detect changes that `push-watcher` already saw when it wrote the push row. Two chained polling loops to propagate one signal, with a `.catch(() => {})` swallowing build failures. Replace the downstream loop with a `pushLanded` event emitted from `insertPush`, subscribed by an `autoBuild` action.

The intended outcomes:
- push-and-exit verdicts survive restart; the action is re-run automatically if the handler throws.
- One polling loop removed; build plugin no longer reaches into tasks-core's `getLatestPush` from a timer.
- Both migrations exercise the direct-job path and the trigger-subscription path, which are the two canonical API uses beyond `events-test`.

## Foundation: direct-job path in the events plugin

Task 1 needs to enqueue a durable action **without** a `defineTriggerEvent` trigger table (push-and-exit is kicked off by a user click, not by a state transition being announced to subscribers). The current `events.dispatch` task assumes a trigger row exists — it looks up the table by `eventName` and conditionally deletes on `oneShot`.

**Change:** add a second Graphile task `events.direct` and an `.enqueue(config)` method on the `ActionFactory`.

- `plugins/events/server/internal/worker.ts` — register a new task `events.direct` alongside `events.dispatch`. Its handler does: registry lookup → `schema.safeParse` → `action.run(parsed, { payload: null, triggerId: jobId, table: null, runId })`. No table, no oneShot, no preservation policy (direct jobs have no trigger row to preserve). A non-retryable failure (unknown action or schema drift) should throw so Graphile marks the job permanently failed — different from the trigger-path policy because there's no row to keep.
- `plugins/events/server/internal/action.ts` — extend `ActionFactory` with `.enqueue(config, opts?)`. Calls `getWorkerUtils().addJob("events.direct", { actionName, actionConfig: config }, { maxAttempts: opts?.maxAttempts ?? 5, jobKey: opts?.jobKey })`. Validates `config` via the action's zod schema at call time (fast fail on the caller's thread) and again at dispatch (deploy-drift safety, unchanged from the existing pattern). Exposes `jobKey` so callers can coalesce (used in Task 2).

`ActionContext`'s `table` is already typed as `unknown` (`plugins/events/server/internal/action.ts:21`), so passing `null` from the direct path is type-clean; we don't need to widen the interface. The `payload` field likewise accepts `null`.

## Task 2 also needs: `ensureTrigger`

Task 2's subscription is plugin-level, not per-user. The build plugin subscribes to `pushLanded` exactly once; we don't want every server boot to insert a new row into `_push_landed_triggers`.

**Change:** add `ensureTrigger(spec)` to the events plugin.

- `plugins/events/server/internal/trigger.ts` — sibling to `trigger()`. Same arguments; idempotent. Implementation: look up a row in the target table whose `action_name = spec.do.name` AND `action_config = spec.do.config` (exact JSONB equality, not `@>`) AND filter columns match. If found, return its id; else insert and return the new id. Unique partial index on `(action_name, action_config)` where `enabled = true` — only if we decide the uniqueness should be enforced at DB level; for now, the "SELECT then INSERT" is a plain race-prone pattern, acceptable because `onReady` fires once per process and no one else writes these rows concurrently.

## Task 1 — push-and-exit

### Storage: new `_push_and_exit_jobs` table

Owned by the push-and-exit plugin.

| Column           | Type            | Notes |
|------------------|-----------------|-------|
| `conversation_id`| text, PK, FK to `_conversations.id` `ON DELETE CASCADE` | one job per conversation; cascade drops on conversation delete |
| `status`         | text, not null  | `"running" \| "clean" \| "flag" \| "error"` |
| `text`           | text, nullable  | flag text when `status = "flag"` |
| `message`        | text, nullable  | error message when `status = "error"` |
| `updated_at`     | timestamptz, default now() | for resource ordering / debugging |

Rationale (vs. graphile-only or conversation-row):
- Graphile's `jobs` table holds retry metadata, not business outcome. Using `last_error` for flag text would conflate a domain verdict with a failure surface.
- Putting verdict on `conversations` couples core schema to a deeply nested leaf plugin.
- A tiny dedicated table is a clean, self-contained mapping of `JobState` and fits the existing push-based resource pattern.

### Files to change

- **NEW** `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/tables.ts` — define `_pushAndExitJobs` table. The barrel at `server/src/db/schema.ts` auto-picks it up (re-exports from all plugins).
- **NEW** `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/action.ts` — `export const pushAndExitAction = defineAction({ name: "push-and-exit.run", config: z.object({ conversationId: z.string() }), run: async ({ conversationId }) => {...} })`. The `run` body is today's `runJob` logic, rewritten so every `jobs.set` becomes a `db.update(_pushAndExitJobs)` and every `pushAndExitResource.notify()` stays as-is. **Idempotency check at entry**: if the row is already `"clean"`, `"flag"`, or `"error"`, return immediately — the handler already succeeded on a prior attempt and is being retried after a fluke.
- **REPLACE** `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/job-runner.ts` — delete. Move `waitForFinalTurn`, `interpret`, and `sleep` into `action.ts` (or a small `transcript.ts` sibling). The `jobs` Map goes away entirely. `pushAndExitResource`'s `loader` becomes `async () => { const rows = await db.select().from(_pushAndExitJobs); return Object.fromEntries(rows.map(r => [r.conversationId, toJobState(r)])); }`.
- **UPDATE** `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/index.ts`:
  - `POST /api/conversations/:id/push-and-exit`: de-dup via `SELECT ... WHERE conversation_id = $1 AND status = 'running'`; 409 if present. Else `INSERT ... ON CONFLICT (conversation_id) DO UPDATE SET status='running', text=NULL, message=NULL, updated_at=now()` (idempotent re-arm after a terminal state). Then `pushAndExitAction.enqueue({ conversationId }, { jobKey: conversationId })`. 202. The `jobKey = conversationId` means a re-trigger while a job is already queued coalesces to one.
  - `DELETE /api/conversations/:id/push-and-exit`: delete the row. No in-memory state to touch.
- **UNCHANGED** `shared/resources.ts` — `JobState` shape stays; it's just sourced from the DB now.

### Restart UX

On server restart mid-`running`: Graphile re-runs the direct job after its `max_attempts` backoff. The handler's entry-check reads the DB row, sees `status = "running"`, and proceeds. `sendTurn` is re-sent (Claude receives the push-and-exit prompt twice in the worst case — acceptable, far rarer than today's "UI flickers and user re-clicks"); `waitForFinalTurn` finds the verdict token from the first prompt almost immediately.

On server restart after verdict was written but before action returned: retry sees terminal status at entry, early-returns, Graphile marks the job done. No duplicate delete of the conversation.

## Task 2 — push-watcher → auto-build

### Event definition: `pushLanded`

Owned by `tasks-core`. Payload mirrors the `pushes` row's meaningful fields:

```ts
// plugins/tasks-core/server/internal/tables.ts (add)
export const { event: pushLanded, table: _pushLandedTriggers } = defineTriggerEvent<{
  pushId: string;
  sha: string;
  attemptId: string;
  conversationId: string | null;
}>({
  name: "tasks_core.push_landed",
  filters: {
    attemptId: text("attempt_id").references(() => _attempts.id, { onDelete: "cascade" }),
  },
});
```

Filter on `attemptId` (cascading on attempt delete) gives future subscribers a natural dimension. No filter on `conversationId` or `pushId` for v1 — add if/when a subscriber wants them. Re-export `pushLanded` from `plugins/tasks-core/server/index.ts`.

### Emit site

`plugins/tasks-core/server/internal/mutations/pushes.ts:16-27` (`insertPush`). The function already has a single committed-insert path guarded by `onConflictDoNothing` — `row` is truthy iff a new row was actually written. Add the emit inside the existing `if (row)` block alongside the two resource notifies:

```ts
if (row) {
  pushesResource.notify();
  attemptsResource.notify();
  await pushLanded.emit({
    pushId: row.id,
    sha: row.sha,
    attemptId: row.attemptId,
    conversationId: row.conversationId,
  });
}
```

Post-commit by construction (single statement). No transaction boundary today, so the v2 spec's "emit is post-commit" rule is trivially satisfied.

### Subscribing action: `autoBuild`

- **NEW** `plugins/build/server/internal/auto-build.ts` — houses the action, the `lastAutoBuildAt` mutable export (migrated from `auto-build-watcher.ts`), and the single `defineAction` call:

  ```ts
  export let lastAutoBuildAt: string | null = null;

  export const autoBuild = defineAction({
    name: "build.autoBuild",
    config: z.object({}).strict(),
    run: async () => {
      const { autoBuild: enabled } = await readConfig(buildConfig);
      if (!enabled) return;
      if (isBuildInflight()) return; // runBuild would coalesce anyway; early-return avoids noise
      lastAutoBuildAt = new Date().toISOString();
      await runBuild();
    },
  });
  ```

  `runBuild()` already coalesces overlapping calls via its promise singleton (`run-build.ts:9-21`), so even without `jobKey` the worker never runs two builds. We still set `jobKey: "build.autoBuild"` on every emit-triggered enqueue implicitly via the trigger path's own logic — or, more precisely, Graphile's per-action concurrency via `queueName` if we decide to go there. For v1, rely on `runBuild`'s internal coalescing and pay the price of up-to-4-queued-autoBuild-jobs resolving quickly against the same inflight build. **Not a regression** — today's polling loop has the same coalescing; we're just moving the coalescing point from the timer to the action.

- **UPDATE** `plugins/build/server/index.ts`:
  - Import `autoBuild` and call `ensureTrigger({ on: pushLanded, do: autoBuild({}), oneShot: false })` from `onReady`. Once per boot, idempotent.
  - Replace `startAutoBuildWatcher` call with a tiny boot-time catch-up: if `(await readConfig(buildConfig)).autoBuild && await getMainAheadCount() > 0`, call `runBuild()` (and set `lastAutoBuildAt`). This preserves today's first-tick behavior for the "crashed mid-build" scenario.
- **DELETE** `plugins/build/server/internal/auto-build-watcher.ts`.
- **UPDATE** `plugins/build/server/internal/handle-build-status.ts:2` — change the `import { lastAutoBuildAt } from "./auto-build-watcher"` to import from `./auto-build` instead.

## Critical files summary

Events plugin (foundation):
- `plugins/events/server/internal/worker.ts` — add `events.direct` task.
- `plugins/events/server/internal/action.ts` — add `.enqueue(config, opts)` on `ActionFactory`.
- `plugins/events/server/internal/trigger.ts` — add `ensureTrigger(spec)`.

Task 1 (push-and-exit):
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/tables.ts` — NEW.
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/action.ts` — NEW.
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/job-runner.ts` — DELETE (logic migrated).
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/index.ts` — rewire routes + resource loader.

Task 2 (auto-build):
- `plugins/tasks-core/server/internal/tables.ts` — add `pushLanded` event + table.
- `plugins/tasks-core/server/index.ts` — re-export `pushLanded`.
- `plugins/tasks-core/server/internal/mutations/pushes.ts` — emit inside `if (row)`.
- `plugins/build/server/internal/auto-build.ts` — NEW (action + `lastAutoBuildAt`).
- `plugins/build/server/index.ts` — `ensureTrigger` + boot-time catch-up.
- `plugins/build/server/internal/auto-build-watcher.ts` — DELETE.
- `plugins/build/server/internal/handle-build-status.ts` — retarget import.

## Verification

Run `./equin build` — drizzle-kit picks up `_push_and_exit_jobs` and `_push_landed_triggers`, server restart applies migrations.

**Task 1 (push-and-exit)**:
1. Open a conversation, click Push & Exit. Verify the UI shows "Pushing…", then a flag sheet with Claude's text (if it finds issues), or the conversation disappears with a "Pushed and closed" toast.
2. Click Push & Exit again; inspect `SELECT * FROM _push_and_exit_jobs` — one row with `status='running'`. Confirm `SELECT * FROM graphile_worker.jobs WHERE task_identifier = 'events.direct'` has one job.
3. **Crash recovery**: while a job is running, `kill -9` the server. `./equin build`. Watch the logs: the action re-runs, finds the verdict token in the transcript, writes the terminal state.
4. **Dismiss a flag**: DELETE the row via the UI close-sheet button; confirm `_push_and_exit_jobs` row is gone and the button reappears.

**Task 2 (auto-build)**:
1. With `autoBuild = true` in config, `./equin push` some commit to main from another worktree. Watch the main worktree's server logs: push-watcher records the push, `pushLanded` emits, autoBuild action fires, build runs.
2. `SELECT * FROM _push_landed_triggers` — one row (the singleton trigger), `action_name='build.autoBuild'`, `attempt_id IS NULL` (match-any subscription).
3. **Boot catch-up**: stop the server, push a commit from another worktree, start the server back up. `getMainAheadCount()` is > 0 on boot → `runBuild()` fires once directly. `SELECT * FROM graphile_worker.jobs` should be empty (the build was a direct call, not a queued action). Push-watcher backfill then records the push; that *does* emit and enqueue an autoBuild, but the action's `isBuildInflight()` early-return means no duplicate build.
4. **Idempotent subscription**: restart the server three times; `SELECT count(*) FROM _push_landed_triggers WHERE action_name='build.autoBuild'` stays at 1.
5. `/api/build/status` still returns `autoBuildAt` with a fresh timestamp after an auto-build — confirming the migrated `lastAutoBuildAt` export works.

## Risks

- **Direct-dispatch path is new plugin surface.** Task 1 depends on `.enqueue` and the `events.direct` worker task. Both are small, but they're the first consumers so edge cases may appear (e.g., Graphile's `addJob` behavior when `jobKey` collides — confirm in implementation).
- **`sendTurn` idempotency** in push-and-exit: retries after restart may send the push-and-exit prompt twice. Mitigation: at-entry check of the row's status. Residual risk: restart mid-`sendTurn` → two prompts sent. Accepted; occurs in a narrow window and Claude handles a redundant prompt gracefully.
- **`ensureTrigger` race**: two concurrent `onReady` invocations could both insert. In practice, `onReady` runs once per process and the server is single-process per worktree. If the concern grows, add a unique partial index.
- **Graphile job-id type**: the dispatch handler casts `helpers.job.id` to `String(...)` for `runId`; the direct-task handler should do the same for consistency. No `triggerId` exists for direct jobs — using the Graphile job id as the dedup key in the action is the natural substitute.
- **Missed follow-up opportunity**: once `pushLanded` exists, other plugins (e.g. `stats`, `tasks-core`) might want to subscribe instead of polling. Not scope here; just flag.
