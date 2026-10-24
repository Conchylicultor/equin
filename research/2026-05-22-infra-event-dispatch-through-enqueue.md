# Event dispatch through enqueue

## Context

The jobs/events system has two paths to run a job handler, and only one respects dedup configuration.

**Direct path (correct):** `job.enqueue(input, { jobKey })` → graphile queue → worker calls `job.run()`. Dedup via `jobKey` works — graphile replaces a pending row instead of creating a second one.

**Event path (broken):** `event.emit()` → trigger matches → `eventsDispatchJob` enqueued → dispatch job calls `target.run()` directly, bypassing `target.enqueue()`. The target's dedup is never invoked. The target also inherits the dispatch job's `workflowRunId`/`ctx`, which means step/wait memoization would use the wrong identity (no current consumers hit this, but it's structurally wrong).

The fix: make the event path go through `target.enqueue()`. One path, one dedup point.

## Affected consumers

Audit of all 14 event-triggered jobs confirms:
- None use `ctx.step()`, `ctx.waitFor()`, or `ctx.sleep()` — no migration risk from the workflowRunId change
- All rely on `event` being non-null — the event payload must be correctly threaded through `enqueue()` → graphile → worker → `run()`
- One job (`conversation-category.classify`) is also directly enqueued and already handles both paths: `input.conversationId ?? event?.conversationId`

## Changes

### 1. `plugins/infra/plugins/jobs/server/internal/registry.ts`

Thread event payload through the enqueue → queue → worker pipeline.

- Add `event?: unknown` to `JobTaskPayload` (the internal graphile wire format)
- Add `_event?: unknown` to `EnqueueOpts` (internal-only, used only by the dispatch job to pass the validated event payload)
- In `enqueue()`: if `opts?._event` is provided, store it in the `JobTaskPayload`

### 2. `plugins/infra/plugins/jobs/server/internal/worker.ts`

Deliver the event payload from the queue to the handler.

- In `dispatch()`: pass `payload.event` to `job.run()` instead of hardcoded `undefined`
- Back-compat: `payload.event` is `undefined` for direct enqueues and pre-existing queue rows — same behavior as today

### 3. `plugins/infra/plugins/events/server/internal/dispatch-job.ts`

Rewrite the run handler to enqueue instead of calling run directly.

**Before:** validate input + event schemas → `target.run({ input, event, ctx })` → oneShot cleanup after run succeeds.

**After:**
- Look up target by name (same stale trigger cleanup as today)
- Validate event payload against `target.eventSchema` (keep this — `enqueue()` doesn't validate events)
- Call `target.enqueue(p.jobWith, { _event: eventArg })` — goes through graphile, applies dedup, gives target its own ctx
- OneShot cleanup: delete trigger row after successful enqueue (not after run — the trigger has served its purpose once the job is durably enqueued)
- Remove input validation (handled by `target.enqueue()` via `spec.input.parse()`)
- Remove `ctx` usage — the dispatch job no longer calls `run()`, so it doesn't need to thread ctx

### 4. `plugins/infra/plugins/events/server/internal/event.ts`

Simplify emit's maxAttempts logic.

- In `dispatch()`: remove `UNSAFE_getRegisteredJob(jobName)` lookup that was only used for `maxAttempts` threading
- Remove `maxAttempts` override on `eventsDispatchJob.enqueue()` — the dispatch job uses its own spec-level default (5), and the target's retry budget lives on its own graphile row
- Remove the `UNSAFE_getRegisteredJob` import

## Design decisions

1. **OneShot cleanup after enqueue, not after run.** Once the event has matched and the target is durably enqueued, the trigger has served its purpose. If the target fails, graphile retries it — that's job-level, not trigger-level.

2. **No `jobKey` on the target enqueue from dispatch.** Each event emission creates an independent target job (random `workflowRunId`). Future work can add a `jobKey` field to the trigger spec for caller-controlled dedup.

3. **Event validation stays in dispatch job.** The worker doesn't know about event schemas. The dispatch job validates once; the worker trusts the stored payload.

4. **Two graphile hops accepted.** Dispatch job → target job adds latency, but correctness > latency.

## Verification

1. `./equin build` — builds and restarts; all event-triggered jobs should still fire
2. Trigger an event that matches a trigger (e.g. create a conversation → fires `conversationCreated` → should trigger `task-title.on-conversation-created`, `queue.seed-rank`, `improve.apply-group`):
   - Verify the target jobs appear in the graphile queue as their own rows (not inside the dispatch job)
   - Verify the event payload reaches the handler
3. Use the debug queue pane to inspect that dispatch jobs now complete quickly (they just enqueue and return)
4. Test oneShot triggers (via the events-test plugin) — the trigger row should be deleted after the dispatch job enqueues the target
5. `./equin check` — passes
