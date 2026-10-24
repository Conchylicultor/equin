# Events + Graphile Worker

## Context

The events plugin today dispatches actions **inline inside `emit()`** via `Promise.all(rows.map(runAction))` (`plugins/events/server/internal/event.ts:151-217`). That design has two holes:

1. **No durability across restarts.** A server crash or `./equin build` mid-handler drops in-flight actions. The trigger row is preserved for `oneShot=true` (delete only happens on success), so the *intent* survives, but the *run* that was supposed to carry it out does not, and nothing re-fires it.
2. **No retries.** `v1` explicitly defers retries as out-of-scope (`docs/events.md:92-98`): the current preservation policy logs the error and walks away. Every production caller that wants at-least-once semantics would have to build its own retry.

Both get solved by moving the **execution** step behind a Postgres-backed job queue. The **subscription** layer (per-event trigger tables with typed filter columns and FK cascades) is the valuable part of today's design and stays put. This doc describes the switch to [Graphile Worker](https://worker.graphile.org/) as the execution backend.

## Goal

- `emit()` enqueues one durable job per matched trigger, then returns.
- Jobs survive server restarts (they live in Postgres).
- Graphile handles retries + exponential backoff; we delete our own retry concerns before they exist.
- The public API (`defineAction`, `defineTriggerEvent`, `trigger`, `deleteTrigger`, `EventHandle.emit`, `.deleteTargeting`) is **unchanged** for callers — the internals move.

---

## Design

### Topology — embedded worker

Graphile Worker runs **embedded** in the existing Bun server process via its `run()` API, started from the events plugin's `onReady` hook. Rationale:

- One server = one worktree. No need for a second supervised process.
- Precedent: `conversations` plugin's poller already starts a long-running loop in `onReady` (`plugins/conversations/server/internal/poller.ts:146`).
- `./equin build` already restarts the server — no worker-specific deploy flow.
- Graphile opens its own `pg.Pool` (via `connectionString`); no conflict with the existing `postgres.js` client.

If and when a worktree generates enough event volume to starve HTTP, we split — but that's not v1.

### Dispatch flow

```
                 emit(payload)
event owner ──────────────────► dispatch(): SELECT matching rows         (SAME)
                                           │
                                           ▼
                                   for each row:
                                     add_job(taskName=row.action_name,
                                             payload={ actionConfig,
                                                       eventPayload,
                                                       triggerId,
                                                       eventName,
                                                       oneShot })         (NEW)

                             ─── boundary: emit() returns here ───

graphile worker ──────────────► pulls job, routes to registered task
                                           │
                                           ▼
                                   safeParse(actionConfig)
                                     ├─ fails → throw non-retryable       (preserve row)
                                     └─ ok → action.run(...)
                                                  │
                                          ┌───────┴────────┐
                                          ▼                ▼
                                       throws          completes
                                          │                │
                                       retry            if oneShot:
                                     (Graphile)         DELETE row by id
```

The `runAction` helper (`plugins/events/server/internal/event.ts:174-217`) is gutted and reborn as a Graphile task handler; `dispatch` (lines 151-172) is replaced with an enqueue loop.

### API surface — what callers see

**Unchanged.** The only behavioral change is the semantics of `emit()`:

```ts
// Before: emit() resolves after all handlers have returned.
await taskCompleted.emit({ taskId: "X", ... });
// At this point, actions have finished (or thrown).

// After: emit() resolves after all jobs are enqueued.
await taskCompleted.emit({ taskId: "X", ... });
// At this point, jobs are durable in graphile_worker.jobs but may not have run yet.
```

This is the one caller-visible change. Everything else — `defineAction`, `defineTriggerEvent`, `trigger`, `deleteTrigger`, `.deleteTargeting`, `.where`, filter semantics, preservation policy — has identical external behavior. The `docs/events.md` user guide needs a small amendment to the "Flow at wire level" section and a new "Delivery semantics" paragraph.

### `oneShot` semantics

Today: row deleted after `action.run()` returns without throwing (`event.ts:211-216`). Failure preserves the row.

After:

| Outcome                                       | Trigger row       | Job row                              |
| --------------------------------------------- | ----------------- | ------------------------------------ |
| Job succeeds on attempt N (1 ≤ N ≤ maxAttempts) | Deleted if oneShot | Moved to success (or deleted)       |
| Job exhausts retries                          | **Preserved**     | Kept in `graphile_worker.jobs` with `last_error` populated |
| Config drift or unknown action (non-retryable) | **Preserved**    | Marked permanently failed            |

This is a strict improvement over today: a server crash no longer loses the run; the job resumes after restart, eventually succeeds, and *then* the row is deleted. Preservation-on-permanent-failure matches today's policy.

### Config-drift & unknown-action handling

Two places the check can happen. We do it at dispatch time (inside the worker task), not at enqueue time. Rationale: a deploy between enqueue and run could change the schema; the worker is the only correct place to re-validate.

- `actionRegistry.get(row.actionName)` returns `undefined` → **non-retryable failure.** Log, mark job permanently failed, preserve trigger row. Re-adding the plugin clears the job on next emit (or via an operator `retryJob`).
- `action.schema.safeParse(actionConfig)` fails → **non-retryable failure.** Same outcome.
- Handler throws → **retryable failure.** Graphile backs off and retries up to `maxAttempts`.

Graphile distinguishes these via thrown error types (standard `Error` → retry; specific non-retryable marker → stop). We wrap both drift cases in a helper that yields the non-retryable form.

### Idempotency — new contract for action authors

This is the substantive change for callers.

> **Actions must be idempotent.** Graphile will retry on handler throw. A handler may be invoked more than once for the same `{ triggerId, payload }` pair.

Practical guidance added to `docs/events.md`:

- Use `triggerId` (always present in `ActionContext`) as a dedup key when mutating shared state. Example: inserting a row — `INSERT ... ON CONFLICT (trigger_id) DO NOTHING` using a plain column, not the PK.
- Pure-side-effect actions that are naturally idempotent (e.g. "set task status to X") need no extra work.
- Side-effects that cannot be dedupped (e.g. "POST to external webhook with no idempotency header") need the author's attention — the doc calls this out.

The existing `events-test.log` action is *not* idempotent (it appends to an in-memory array). We either make it idempotent (skip if `triggerId` already seen) or accept duplicate log entries in the test suite. Recommend the former so the test harness models the real-world contract.

### Schema changes

**Graphile Worker's own schema.** Graphile installs a `graphile_worker` schema with its own tables and migrations. We let Graphile self-migrate on worker startup (`run({ ... })` with default `runMigrations: true`). Our `./equin build` flow stays as-is: Drizzle runs our migrations first, then the server boots, then `events.onReady` starts the worker which runs Graphile's migrations.

Per-worktree DB forks (via `pg_dump | pg_restore` in `plugins/conversations/server/internal/db-fork.ts:9-35`) will carry the `graphile_worker` schema along with everything else. We should `TRUNCATE graphile_worker.jobs` after forking — otherwise a fresh worktree inherits stale jobs from the template. Small change, same file.

**Our trigger tables.** **No schema changes.** The base columns (`actionName`, `actionConfig`, `oneShot`, `enabled`, filter columns) remain, all read the same way. We still SELECT them in `dispatch` to build job payloads; we just stop calling `action.run` inline from there.

### Task registration

Graphile's `run()` takes a `taskList: { [name]: handler }`. We register **one Graphile task per action** (not one shared `events.dispatch`), built from `actionRegistry` at worker start:

```ts
// plugins/events/server/internal/worker.ts
const taskList: Record<string, Task> = {};
for (const [name, action] of actionRegistry) {
  taskList[name] = async (payload, ctx) => {
    const { actionConfig, eventPayload, triggerId, eventName, oneShot } = payload;
    const parsed = action.schema.safeParse(actionConfig);
    if (!parsed.success) throw new NonRetryableError(`config drift: ${...}`);
    await action.run(parsed.data, { payload: eventPayload, triggerId, table: ... });
    if (oneShot) await deleteTriggerRow(eventName, triggerId);
  };
}
await run({ connectionString, taskList, concurrency: 4 });
```

Pros: `graphile_worker.jobs.task_identifier` matches the action name — drop-in observability. Cons: requires the action registry to be complete before `onReady` fires; this is already the case (actions register at module import, `onReady` fires after all imports resolve).

### Test harness — events-test migration

The test flow today is synchronous: `POST /emit` waits for handlers, `GET /log` immediately sees results. After the switch, the test has to wait for the job to drain.

Three options:

1. **Poll `graphile_worker.jobs`.** Add `waitForIdle()` helper that polls `SELECT count(*) FROM graphile_worker.jobs WHERE task_identifier LIKE 'events_test.%'` until zero, with timeout. Tests call it between `emit` and `GET /log`. Simple, no code changes to the plugin surface.
2. **`emit({ sync: true })`.** Add a testing-only option to `EventHandle.emit` that uses Graphile's `addJob` then `runOnce` instead of `run`. Leaky — production callers shouldn't see a "sync" flag.
3. **`runOnce` mode for the worker in tests.** Start Graphile with `runOnce: true` (no polling) and flush by calling it manually between emit and log read.

**Recommendation: option 1.** Zero impact on the plugin API; the helper lives in the events-test plugin's test support.

### Failure surfacing

Today, handler crashes log to stderr and vanish. With Graphile:

- Failed jobs sit in `graphile_worker.jobs` with `attempts`, `last_error`, `run_at`.
- Add a **"Jobs" item to the Debug sidebar** (`debug.item`) showing retrying + permanently failed jobs. Not v1 scope for this doc — mention as follow-up.
- Wire the `crashes` plugin to record permanently-failed jobs as tasks so they show up in the operator's feed. Also follow-up.

For the v1 cut-over: operator inspects via `psql`.

---

## Side benefits (not scope, but worth noting)

- **Cron for free.** Graphile has built-in cron. The deferred `CronSource` in `docs/events.md:141-148` becomes a thin wrapper: `trigger({ on: Cron("0 9 * * *"), do: ... })` registers a Graphile cron entry + our normal trigger row. Compound sources still need separate work.
- **Per-action retry config.** `defineAction({ name, config, run, maxAttempts?, backoff? })` maps 1:1 to Graphile's job options. Not in v1 scope but trivial once the plumbing exists.
- **At-least-once semantics.** `emit()` returning now means "job is durable" — strictly stronger than today's "handler was invoked once (at most)."

---

## Migration steps

1. **Add `graphile-worker` dep.** Root `package.json` (workspace) or `server/package.json`. Bun compatibility verified in step 9.
2. **Rewrite `plugins/events/server/internal/event.ts`:**
   - `dispatch()` — keep the `SELECT` (lines 151-169); replace `Promise.all(rows.map(runAction))` (line 171) with `Promise.all(rows.map(row => enqueue(def, row, payload)))`.
   - Delete `runAction` (lines 174-217) — logic moves to the worker task.
   - Add an `enqueue()` helper that uses Graphile's `addJob`.
3. **New file `plugins/events/server/internal/worker.ts`:**
   - Exports `startWorker(): Promise<Runner>` that builds `taskList` from `actionRegistry`, imports `triggerTableRegistry` for `oneShot` deletes, and calls Graphile's `run({ connectionString, taskList, concurrency })`.
   - Exports `stopWorker()` for tests / clean shutdown.
4. **Wire `onReady`.** `plugins/events/server/index.ts` gains `onReady: () => startWorker()`.
5. **Handle `oneShot` deletes in the task.** The worker needs to resolve `eventName → table` to delete the trigger row. Pass `eventName` in the job payload; look up the table via `triggerTableRegistry.get(eventName)`.
6. **Amend `plugins/conversations/server/internal/db-fork.ts`.** After `pg_restore`, `TRUNCATE graphile_worker.jobs` (and any other Graphile tables, or use `graphile-worker reset` helper).
7. **Migrate `events-test`:**
   - Make `logPing`'s run handler idempotent (dedup on `triggerId`).
   - Add `waitForIdle()` test helper that polls `graphile_worker.jobs`.
   - Update `handleEmit` routes or e2e scripts to `await waitForIdle()` between emit and log-read.
8. **Doc updates.** `docs/events.md`: amend "Flow at wire level" diagram, add "Delivery semantics" section (idempotency + retries), note `emit()` now returns after enqueue, not after execution.
9. **Bun compatibility check.** Run `./equin build` and confirm `graphile-worker` starts in Bun. Graphile uses `pg` (node-postgres) internally; Bun's Node.js compat covers it, but worth a smoke test. Flag: if `pg`'s `LISTEN/NOTIFY` hook doesn't work under Bun, Graphile still polls (slower dispatch, ~1s latency), which is acceptable for v1.

### Critical files to touch

- `plugins/events/server/internal/event.ts` — gut dispatch loop, keep SELECT.
- `plugins/events/server/internal/worker.ts` — **new file.**
- `plugins/events/server/internal/enqueue.ts` — **new file**, thin wrapper over `addJob`.
- `plugins/events/server/index.ts` — add `onReady`.
- `plugins/events-test/server/internal/action.ts` — dedup on `triggerId`.
- `plugins/events-test/server/internal/*` — test-harness `waitForIdle` helper.
- `plugins/conversations/server/internal/db-fork.ts` — truncate Graphile jobs post-fork.
- `docs/events.md` — delivery semantics + idempotency.
- `server/package.json` (or root) — add `graphile-worker` dep.

### Files to reuse, not rewrite

- `plugins/events/server/internal/registry.ts` — `actionRegistry` and `triggerTableRegistry` are exactly what the worker needs.
- `plugins/events/server/internal/base-columns.ts` — trigger-table base columns unchanged.
- `plugins/events/server/internal/action.ts` — `defineAction`, `ActionRef`, `deleteTargeting` sweep unchanged.
- `plugins/events/server/internal/trigger.ts` — `trigger()` and `deleteTrigger()` unchanged.
- `server/src/db/client.ts` — `connectionString` is already exported (line 13); Graphile consumes it directly. No new DB plumbing.

---

## Open questions

1. **Retry defaults.** Graphile's default is 25 attempts with exponential backoff. Probably too aggressive. Proposed: `maxAttempts: 5` globally, per-action override later. Agree?
2. **Concurrency.** `run({ concurrency: N })`. Propose 4 as a starting value (matches `postgres.js` pool `max: 5` minus one headroom). Worktrees are low-volume; easy to tune.
3. **Non-retryable error signaling.** Graphile recognizes a specific error shape. Confirm the current API during implementation and wrap in our own `NonRetryableError`. Not a design question, just flagging.
4. **Observability follow-up.** Do we want a Debug sidebar "Jobs" pane in this cut, or follow-up? Recommend follow-up — v1 is the API + durability; operator tools can come after.
5. **Action name = Graphile task name.** Guarantees a 1:1 mapping, nice for `task_identifier` debugging, but ties our namespace to Graphile's. Names like `"agents.launch"` are valid Graphile task names. Any concern?
6. **Bun + Graphile's `LISTEN/NOTIFY`.** If Bun's `pg` compat is fine, we get sub-second dispatch. If not, Graphile falls back to polling (~1s). Need a live test to know. Flagged in migration step 9.

---

## Verification

**Unit-level (events-test loop):**

1. Subscribe to `events_test.pinged` with `userId=X`.
2. Emit `{ userId: X, message: "hi" }`.
3. `await waitForIdle()`.
4. `GET /api/events-test/log` shows the entry with correct `triggerId`.
5. Inspect: `SELECT count(*) FROM events_test_pinged_triggers` → 0 (oneShot delete fired through the worker).
6. Inspect: `SELECT count(*) FROM graphile_worker.jobs` → 0 (job completed).

**Crash-recovery (the reason we're doing this):**

1. Subscribe + emit as above.
2. Immediately `kill -9` the server before the worker picks up the job.
3. `SELECT count(*) FROM graphile_worker.jobs` → 1 (job durable).
4. `./equin build` — server restarts.
5. Worker boots, claims the job, runs it.
6. `GET /api/events-test/log` shows the entry. Trigger row deleted.

**Retry:**

1. Add a temporary failure branch in `events-test.log` (fail first N times, then succeed based on a counter).
2. Emit.
3. Observe `graphile_worker.jobs.attempts` increment and `last_error` populated.
4. Eventually job completes; log entry appears once (idempotent handler).

**Config drift:**

1. Subscribe with a known-good config.
2. In code, tighten the action's zod schema so the stored config fails `safeParse`.
3. Emit → job enqueued → worker parses → throws `NonRetryableError`.
4. Job marked permanently failed; trigger row preserved; warning in logs.

**End-to-end:** `./equin build` succeeds; a follow-up plugin wiring `taskCompleted.emit` would be the real first production user. Out of scope here.
