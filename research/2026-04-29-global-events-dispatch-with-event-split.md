# Events Dispatch — Split `with` and `event` into Separate Job Args

## Context

Auto-launch silently dropped task `task-1777488085573-9u98vi` on 2026-04-29. The trigger fired, the dispatch job ran, the trigger row was deleted by the oneShot cleanup, and yet no conversation was ever spawned. The orphan now sits in the DB with `auto_start_at` set and no live trigger that will ever fire.

Root cause is in `plugins/infra/plugins/events/server/internal/dispatch-job.ts:36`:

```ts
const merged = { ...p.jobWith, ...p.eventPayload };
```

The `taskStatusChanged` payload carries `taskId` (the *source* task that just changed), and `arm-auto-start.ts` sets `with: { taskId }` (the *child* task to launch). The shallow merge is order-dependent and event-wins, so the dep's `taskId` clobbered the child's. `tasks.maybe-launch` ran against the parent task, hit the early-return guard (`!t.autoStartAt`), and the oneShot cleanup deleted the only trigger that could have launched the child.

This isn't a one-off. It's a structural problem with the dispatch primitive:

- **No schema contract distinguishes the two sources.** The job receives a flat blob and must guess which fields originated where.
- **Filter columns redundantly appear in payloads.** `tasks.statusChanged` filters by `taskId` AND ships `taskId` in the payload. Any subscriber operating on a *different* task than the one that fired collides on the most natural key name.
- **Failure looks like success.** Early-returns in `maybe-launch` are silent — no log, no surface signal, no retry. The orphan is invisible until someone goes looking.

The fix is to stop merging. `with` (subscriber intent) and `event` (delivery context) become two named fields of a single object passed to the target job's `run`. The job declares both schemas at definition time. Collisions are unrepresentable; the source of every read site is self-labeling.

This work also closes the audit-discovered latent collisions on `events_test.pinged.userId`, `conversation.created.conversationId`, and `conversation.turn-completed.conversationId` — none active today, all impossible after the refactor.

---

## The Contract Change

**Old.** `defineJob` declares one `input` schema; `run(input, ctx)` receives a flat-merged `{ ...with, ...eventPayload }`.

**New.** `defineJob` declares two schemas — `input` (what the subscriber bakes into `with`) and `event` (what the firing event delivers). `run({ input, event, ctx })` receives a single object with both as named fields. No merge anywhere.

```ts
defineJob({
  name: "tasks.maybe-launch",
  input: z.object({ taskId: z.string() }),
  event: z.never(),                                    // I don't read events
  run: async ({ input: { taskId }, event: _, ctx }) => { … }
});
```

```ts
defineJob({
  name: "events_test.log",
  input: z.object({ label: z.string() }),              // from `with`
  event: z.object({ userId: z.string(), message: z.string() }),
  run: async ({ input: { label }, event: { userId, message }, ctx }) => { … }
});
```

`event: z.never()` is the sentinel for "this job ignores event payloads." The dispatcher recognizes it and passes `event: undefined` to `run`. The handler can't accidentally read fields off `never`-typed event without a TS error.

The trigger subscription side gets a typed overload:

```ts
trigger({
  on: taskStatusChanged.where({ taskId: depId, status: "done" }),
  do: maybeLaunchTaskJob,                              // typed factory
  with: { taskId: childId },                           // type-checked vs. job.input
  oneShot: true,
});
```

`triggerByName` is renamed `UNSAFE_triggerByName` and reserved for the durable-hooks bridge (the only place that legitimately can't hold a typed factory reference).

---

## Files Changed

### Engine (infra)

| File | Change |
|------|--------|
| `plugins/infra/plugins/jobs/server/internal/registry.ts` | `defineJob` signature: add `event: ZodSchema` field; `RegisteredJob` exposes both `inputSchema` and `eventSchema`; `run` signature becomes `({ input, event, ctx }) => …` |
| `plugins/infra/plugins/jobs/server/internal/worker.ts` | Layer-1 worker calls `target.run({ input: parsed, event: undefined, ctx })` (workers always invoke jobs without an event) |
| `plugins/infra/plugins/events/server/internal/dispatch-job.ts` | Replace flat-merge with separate parses; pass both fields to `target.run`; special-case `eventSchema instanceof ZodNever` to skip parse and pass `undefined` |
| `plugins/infra/plugins/events/server/internal/trigger.ts` | Typed `trigger(spec)` overload constrains `with` to `Partial<z.input<JobFactory.inputSchema>>`; rename `triggerByName` → `UNSAFE_triggerByName` |
| `plugins/infra/plugins/events/server/internal/install-jobs-hooks.ts` | Update import: `UNSAFE_triggerByName` |
| `plugins/infra/plugins/events/server/index.ts` | Re-export `UNSAFE_triggerByName`; remove `triggerByName` from public surface |

### Job migrations

| File | Migration |
|------|-----------|
| `plugins/infra/plugins/events/server/internal/dispatch-job.ts` | `events.dispatch` self: input schema unchanged (`{eventName, triggerId, jobName, jobWith, eventPayload, oneShot}`); add `event: z.never()`; run reads from `input` (was `p`) |
| `plugins/infra/plugins/jobs/server/internal/resume-job.ts` | `jobs.resume`: `input = z.object({__resume_*})`, `event = z.record(z.unknown()).passthrough()`. Run extracts `__resume_*` from `input`, stores `event` (the verbatim payload) into `_jobWaits.payloadJson` |
| `plugins/conversations/server/internal/auto-start-jobs.ts` | `tasks.maybe-launch`: `input = z.object({taskId})`, `event = z.never()`. Drop the `.passthrough()` (it only existed to absorb the merge). Add early-return logging — see Telemetry below |
| `plugins/build/server/internal/build-run-job.ts` | `build.run`: `input = z.object({})`, `event = PushLandedSchema` (declared for documentation; handler still ignores). Drop `.passthrough()` |
| `plugins/events-test/server/internal/log-job.ts` | `events_test.log`: `input = z.object({label})`, `event = z.object({userId, message})`. Update destructure |
| `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/push-and-exit-job.ts` | `push_and_exit.run`: `input = z.object({conversationId})`, `event = z.never()` (job is enqueued directly, not event-triggered) |

### Trigger subscription migrations

| File | Migration |
|------|-----------|
| `plugins/build/server/index.ts:25` | Already uses typed `trigger(buildRunJob)` — no change |
| `plugins/events-test/server/internal/handle.ts:19` | Already uses typed `trigger(logPing)` — no change |
| `plugins/tasks/server/internal/arm-auto-start.ts:31,37` | Switch from `triggerByName` to typed `trigger(maybeLaunchTaskJob, …)`. Add import of `maybeLaunchTaskJob` from `@plugins/conversations/server` (verified acyclic — conversations imports tasks-core, not tasks). The `else` branch's `UNSAFE_getRegisteredJob` call also moves to `maybeLaunchTaskJob.enqueue({ taskId })` |
| `plugins/infra/plugins/events/server/internal/install-jobs-hooks.ts:25` | Stays on `UNSAFE_triggerByName` (cycle-breaker; legitimate infra-only use) |

---

## Audit Results — What Each Job Reads

The migration shape is uncontroversial because every existing handler is already classified by source:

| Job | Reads from `with` | Reads from event | New `input` | New `event` |
|-----|-------------------|------------------|-------------|-------------|
| `events.dispatch` | self-carries both as named fields | — | unchanged | `z.never()` |
| `build.run` | nothing | nothing (handler ignores payload) | `z.object({})` | `PushLandedSchema` (documentary) |
| `tasks.maybe-launch` | `taskId` | nothing | `z.object({taskId})` | `z.never()` |
| `jobs.resume` | `__resume_workflowRunId/waitName/jobName/input/timeout?` | the rest of the payload (stored verbatim) | `ResumeInputSchema` (`__resume_*` only) | `z.record(z.unknown()).passthrough()` |
| `events_test.log` | `label` | `userId`, `message` | `z.object({label})` | `z.object({userId, message})` |
| `push_and_exit.run` | `conversationId` | n/a (direct enqueue, no trigger) | `z.object({conversationId})` | `z.never()` |

Pure forwarding case (event payload becomes input, handler reads nothing from `with`): `build.run`. Handled cleanly by `input = z.object({})`. No special "forwarding" mode in the dispatcher.

Pure with-only case: `tasks.maybe-launch`, `push_and_exit.run`. Handled cleanly by `event = z.never()`.

Genuinely mixed: `jobs.resume`, `events_test.log`. Both already split fields by origin in their handlers; the new shape makes the split explicit at the schema layer.

### Latent collision audit

Filter-column-also-in-payload pattern exists in four of five events; only `tasks.statusChanged.taskId` is actively colliding today. After the refactor, all four become impossible to collide:

| Event | Filter ∩ payload | Active subscriber today | Status after refactor |
|-------|------------------|-------------------------|----------------------|
| `tasks.statusChanged` | `taskId`, `status` | `tasks.maybe-launch` (collision) | Fixed — `taskId` now in separate `input` field |
| `events_test.pinged` | `userId` | `events_test.log` | No subscriber puts `userId` in `with`; latent risk closed |
| `conversation.created` | `conversationId` | none | Latent risk closed |
| `conversation.turn-completed` | `conversationId` | `jobs.resume` (no collision — uses `__resume_*` keys) | Latent risk closed |
| `pushes.landed` | (no filters) | `build.run` | n/a |

---

## Deploy-Time Concerns

**In-flight trigger rows.** The `job_with` jsonb column is unchanged. After cutover, when an old trigger row fires:

1. Dispatcher parses `job_with` against new `input` schema for the target → succeeds (existing rows already have only the with-keys; eventPayload was the *other* source that got merged in).
2. Dispatcher parses `eventPayload` against new `event` schema → succeeds for permissive schemas; for `event: z.never()` jobs, the dispatcher skips the parse and passes `undefined`.
3. Target runs with separate args → correct behavior.

So existing in-flight triggers continue to work, and the structural fix retroactively un-breaks any future emit that matches them. **No DB migration needed.**

**In-flight `events.dispatch` graphile jobs.** The `events.dispatch` input schema is unchanged (`{eventName, triggerId, jobName, jobWith, eventPayload, oneShot}`). Queued dispatcher jobs deserialize fine; the new `run` body just routes the same fields to the target differently.

**The currently-stuck task `task-1777488085573-9u98vi`.** It has `auto_start_at` set with one stale `dropped` trigger row. The refactor doesn't auto-recover this specific case because the dep is `done`, not `dropped`, and the `done` trigger was deleted by the oneShot cleanup at the moment of the original bug. Manual recovery, performed once after deploy:

```sql
DELETE FROM "tasks_statusChanged_triggers"
 WHERE id = 'ac7ac5f8-4df7-4166-8383-2e12b8650121';
```

Then either toggle auto-start off/on in the UI for `task-1777488085573-9u98vi`, or call `armTaskAutoStart` directly. Document this in the deploy notes; don't bake it into the implementation.

---

## Telemetry — In Scope (Recommended)

Add `console.warn` to the early-return paths in `tasks.maybe-launch` that delete a oneShot trigger as a side effect. The pattern matches `dispatch-job.ts` and `resume-job.ts`:

```ts
if (!t || !t.autoStartAt) {
  console.warn(`[tasks.maybe-launch] task ${taskId} missing or auto-start cleared; oneShot trigger fired but no launch`);
  return;
}
```

Cost is one log line per early-return. Value is the difference between "silently orphaned" and "grep-able from logs." This is the smallest change that would have caught the original incident in minutes instead of days.

---

## Optional / Follow-up Items

### Orphan sweep — Recommended, deferred to follow-up

A cheap periodic check would have surfaced the bug independently of telemetry:

```sql
SELECT id FROM tasks
 WHERE auto_start_at IS NOT NULL
   AND id NOT IN (
     SELECT job_with->>'taskId'
       FROM "tasks_statusChanged_triggers"
      WHERE enabled
   );
```

Defer to a follow-up PR. It's defensive infrastructure, not part of the structural fix.

### Lint check — Nice-to-have, follow-up

`./equin check --no-input-event-collision` would flag any `defineJob` whose `input` and `event` schemas declare overlapping keys. The new architecture makes runtime collision impossible, but overlap is a code smell worth surfacing. Low priority — skip for now.

---

## Critical Files

Core engine changes (must read together for context):

- `plugins/infra/plugins/jobs/server/internal/registry.ts` — `defineJob` factory and `RegisteredJob` shape
- `plugins/infra/plugins/jobs/server/internal/worker.ts` — Layer-1 dispatch (`target.run` invocation site)
- `plugins/infra/plugins/events/server/internal/dispatch-job.ts` — the merge-site fix
- `plugins/infra/plugins/events/server/internal/trigger.ts` — typed overload + `UNSAFE_*` rename
- `plugins/infra/plugins/jobs/server/internal/step-ctx.ts:258-268` — durable-hooks bridge `spec.with` shape (for context, no edit)

Job migrations (each one isolated, in any order after engine lands):

- `plugins/conversations/server/internal/auto-start-jobs.ts` — `tasks.maybe-launch` + telemetry
- `plugins/build/server/internal/build-run-job.ts`
- `plugins/events-test/server/internal/log-job.ts`
- `plugins/infra/plugins/jobs/server/internal/resume-job.ts`
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/push-and-exit-job.ts`

Trigger subscriber migration:

- `plugins/tasks/server/internal/arm-auto-start.ts` — switch to typed `trigger(maybeLaunchTaskJob, …)`

---

## Verification

End-to-end:

1. `./equin build` — types compile, plugin boundaries pass, migration check passes (no schema changes, so no new migration).
2. `./equin check --plugin-boundaries` — confirms `tasks → conversations` import doesn't introduce a cycle.
3. **Repro the original bug.** Create task A with auto-start, depending on task B. Launch B and push. Confirm A auto-launches when B reaches `done`. Before the fix this fails silently; after, it works.
4. **Forwarding path.** Run a push, confirm `build.run` fires (and reads nothing from `event` — its handler is unchanged in behavior).
5. **Durable wait path.** Trigger a `push_and_exit` flow; the `ctx.waitFor(conversationTurnCompleted, …)` registers a `jobs.resume` trigger via `UNSAFE_triggerByName`; the resume reads `__resume_*` from `input` and the rest from `event`. Confirm `_jobWaits.payloadJson` contains the event payload as before.
6. **Latent-collision audit.** Manually emit `events_test.pinged` with `userId` and confirm `events_test.log` reads `label` from `with` and `userId`/`message` from `event` independently.
7. **Recovery.** Run the SQL cleanup for `task-1777488085573-9u98vi`, then toggle auto-start on it; confirm it launches.

Negative tests:

- Subscriber typo: `with: { taksId: "B" }` should fail TypeScript compilation against the typed `trigger(maybeLaunchTaskJob, …)` overload.
- Handler typo: reading `event.foo` in a `event: z.never()` job should fail TS compilation.
