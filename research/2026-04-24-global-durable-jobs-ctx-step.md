# Durable jobs: `ctx.step` + `ctx.waitFor` on top of `defineJob`

## Context

`research/2026-04-24-global-jobs-events-split.md` landed the jobs + events primitives. `research/2026-04-24-push-and-exit-jobs-migration.md` then migrated push-and-exit onto `defineJob` with `maxAttempts: 1`. That migration worked for the happy path but exposed a class of bug we haven't solved:

> **A 10-minute polling loop inside a handler doesn't survive server restart.** When auto-build (`plugins/build`) runs `./equin build` in response to `pushes.landed` — which happens mid-run, because push-and-exit *causes* that event — the bun server restarts. Graphile-worker has already incremented `attempts` to 1 at pickup; with `max_attempts: 1`, the job is permanently failed. The `_push_and_exit_jobs` row stays `status='running'` forever. UI stuck at "Pushing…".

The deeper issue: graphile-worker restarts are only useful when the handler is short and idempotent. Our current shape bakes both the side-effect (`sendTurn`) and the wait (10-min poll) into one non-idempotent handler. `maxAttempts: 1` was chosen precisely because a retry would silently re-prompt Claude.

Durable-execution engines (Temporal, Inngest, DBOS, Restate) solve this by making long handlers *replayable*: every side effect goes through a `step.run(name, fn)` wrapper that memoizes its result, and every wait (`step.sleep`, `step.waitFor`) suspends the handler off-CPU. On resume, the code runs from the top; completed steps short-circuit from the log; the wait returns its resolved value. This doc proposes adding just enough of that to `@plugins/infra/plugins/jobs/server` to fix push-and-exit cleanly and become the default shape for future agent workflows.

**Scope**: extend `JobCtx` with `ctx.step`, `ctx.waitFor`, `ctx.sleep`, plus the tables and builtin re-enqueue job that make them durable. Migrate push-and-exit as the first consumer. No new plugin; no separate `defineWorkflow` surface. Zero breaking changes to existing `defineJob` callers.

## Design

### Public API

One addition — everything flows through `ctx`:

```ts
export interface JobCtx {
  // Existing
  jobId: string;
  attempt: number;

  // New — workflow identity, stable across suspends.
  // Equals jobKey if one was passed to enqueue; else generated uuid.
  workflowRunId: string;

  // Run `fn` exactly once per workflowRunId. Result memoized in _job_steps.
  // On replay (retry or resume), returns the recorded result without calling fn.
  step<R>(name: string, fn: () => Promise<R> | R): Promise<R>;

  // Subscribe to `event` (matching `where` + optional `match` predicate),
  // suspend the handler, and return the event payload when it fires.
  // Returns null on timeout.
  waitFor<T>(
    event: EventSource<T>,
    opts: {
      where?: Partial<T>;
      match?: (payload: T) => boolean;
      timeoutMs?: number;
    },
  ): Promise<T | null>;

  // Sleep until `runAt`; handler suspends and resumes there.
  sleep(ms: number): Promise<void>;
}
```

Rules for the handler body (contract, documented in `defineJob` JSDoc):

- Any side effect (`sendTurn`, `setStatus`, `deleteConversation`, network calls, DB writes) goes inside `ctx.step`. If it doesn't, it runs again on every replay.
- Between steps: only deterministic code. No `Date.now()`, `Math.random()`, `crypto.randomUUID()`. If you need them, wrap in a `ctx.step("stamp", () => Date.now())`.
- No user-facing `try/catch` around `ctx.*`. A special `SuspendSignal` is thrown by `waitFor`/`sleep` to exit the handler; swallowing it will hang the workflow.

Push-and-exit under this API (concrete rewrite, replaces today's `push-and-exit-job.ts` body):

```ts
export const pushAndExitJob = defineJob({
  name: "push_and_exit.run",
  input: z.object({ conversationId: z.string() }),
  maxAttempts: 3, // no longer fragile — send-prompt is inside a step
  run: async ({ conversationId }, ctx) => {
    await ctx.step("send-prompt", () =>
      sendTurn(conversationId, PUSH_AND_EXIT_PROMPT),
    );

    const turn = await ctx.waitFor(conversationTurnCompleted, {
      where: { conversationId },
      timeoutMs: 600_000,
      match: (p) =>
        p.stopReason === "end_turn" &&
        (p.text.includes(CLEAN_TOKEN) || p.text.includes(FLAG_TOKEN)),
    });

    if (!turn) {
      await ctx.step("flag-missing", () =>
        setStatus(conversationId, "flag", "No final message from Claude."),
      );
      return;
    }

    const verdict = interpret(turn.text);
    if (verdict.status === "clean") {
      await ctx.step("mark-clean", () =>
        setStatus(conversationId, "clean", null),
      );
      await ctx.step("delete-conversation", async () => {
        await deleteConversation(conversationId);
        recentConversationsResource.notify();
      });
    } else {
      await ctx.step("mark-flag", () =>
        setStatus(conversationId, "flag", verdict.text),
      );
    }
  },
});
```

No try/catch. No `triggeredAt`. No `waitForFinalTurn`. Restart-safe.

### Tables

Added to `plugins/jobs/server/internal/tables.ts` (new file; drizzle-kit picks it up automatically — `server/drizzle.config.ts:18-23` globs `plugins/**/server/**/internal/tables.ts`).

```ts
export const _jobSteps = pgTable(
  "job_steps",
  {
    workflowRunId: text("workflow_run_id").notNull(),
    stepName: text("step_name").notNull(),
    resultJson: jsonb("result_json"),           // null when fn returned undefined
    errorMessage: text("error_message"),        // set if fn threw (step marked failed)
    completedAt: timestamp("completed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.workflowRunId, t.stepName] })],
);

export const _jobWaits = pgTable(
  "job_waits",
  {
    workflowRunId: text("workflow_run_id").notNull(),
    waitName: text("wait_name").notNull(),       // stable per-callsite key; see §Wait names
    status: text("status").$type<"pending" | "resolved" | "timed_out">().notNull(),
    payloadJson: jsonb("payload_json"),          // event payload when status=resolved
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.workflowRunId, t.waitName] })],
);
```

Both tables are internal to the jobs plugin — no plugin-level public export. Rows persist for the workflow's lifetime and are deleted when the workflow completes (see §Cleanup).

### `workflowRunId`

Stable identity for a single workflow run, used as the key for the step log and wait log. Rules:

- `enqueue(input)` with no `jobKey` → generate `workflowRunId = crypto.randomUUID()`, store it alongside `input` in the graphile payload.
- `enqueue(input, { jobKey })` → `workflowRunId = jobKey`. This gives callers explicit control for idempotent re-enqueues (push-and-exit already uses `jobKey: conversationId`).
- Exposed as `ctx.workflowRunId` for escape hatches (e.g., debugging, custom queries).

Payload shape in `graphile_worker._private_jobs` becomes:

```jsonc
{
  "jobName": "push_and_exit.run",
  "workflowRunId": "claude-1777050427-0cpi",  // = jobKey, or generated uuid
  "input": { "conversationId": "claude-1777050427-0cpi" }
}
```

### `ctx.step` mechanics

```ts
async step(name, fn) {
  const existing = await db.select()
    .from(_jobSteps)
    .where(and(eq(_jobSteps.workflowRunId, this.workflowRunId), eq(_jobSteps.stepName, name)))
    .limit(1);
  if (existing[0]) {
    if (existing[0].errorMessage) throw new Error(existing[0].errorMessage);
    return existing[0].resultJson as R;
  }
  try {
    const result = await fn();
    await db.insert(_jobSteps).values({
      workflowRunId: this.workflowRunId,
      stepName: name,
      resultJson: (result ?? null) as unknown,
    });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.insert(_jobSteps).values({
      workflowRunId: this.workflowRunId,
      stepName: name,
      errorMessage: msg,
    });
    throw err; // let graphile see the failure and retry the whole handler
  }
}
```

- **Step failure is sticky.** If `fn` throws, the step row is written with `errorMessage`. The next replay reads that row and re-throws the same error. A failed step is a permanently failed workflow (unless the user explicitly retries — see §Retry).
- **Step name uniqueness.** Two `ctx.step("foo", ...)` calls in the same workflow will collide on the primary key. The second throws. Users are expected to give each call site a unique name — same contract as Temporal/Inngest.
- **Result serialization.** Stored as JSONB. If you need to pass an object that doesn't round-trip through JSON, refactor — same rule as graphile-worker payloads.

### `ctx.waitFor` mechanics

```ts
async waitFor(event, opts) {
  const waitName = opts.name ?? `wait:${event.name}:${callIndex++}`; // stable per call site
  // 1. Check if already resolved (resume path).
  const existing = await readWait(this.workflowRunId, waitName);
  if (existing?.status === "resolved") return existing.payloadJson as T;
  if (existing?.status === "timed_out") return null;

  // 2. First time: insert pending wait + trigger.
  await db.insert(_jobWaits).values({
    workflowRunId: this.workflowRunId,
    waitName,
    status: "pending",
  }).onConflictDoNothing();

  await trigger({
    on: event,
    do: jobsResumeJob,                  // builtin, see below
    with: {
      __resume_workflowRunId: this.workflowRunId,
      __resume_waitName: waitName,
      __resume_jobName: currentJobName,
      __resume_input: this.originalInput,
      __resume_match: opts.match ? serialize(opts.match) : null,  // see §Match
    },
    filter: opts.where,
    oneShot: true,
  });

  if (opts.timeoutMs) {
    await jobsResumeJob.enqueue(
      { __resume_timeout: true, __resume_workflowRunId: ..., __resume_waitName: ..., __resume_jobName: ..., __resume_input: ... },
      { runAt: new Date(Date.now() + opts.timeoutMs), jobKey: `timeout:${this.workflowRunId}:${waitName}` },
    );
  }

  // 3. Suspend.
  throw new SuspendSignal();
}
```

Wait names: default to `wait:<eventName>:<seq>` where seq is incremented per handler invocation. A replayed handler hits the same call sites in the same order, so the seq aligns. Callers that branch conditionally should pass `opts.name` explicitly.

Matcher: `opts.match` is a JavaScript predicate. Since we can't serialize closures to a trigger row, we run `match` on the RESUMING side: the events-dispatcher fires `jobsResumeJob` on any event that passes `where`, and `jobsResumeJob` re-reads the registered handler's match fn from a runtime registry keyed by `(workflowRunId, waitName)`. The registry is rebuilt on server start by walking `_jobWaits` status=pending rows. If a match fails, the resume job just re-subscribes and exits — same trigger stays armed for the next event.

> **Simplification for v1**: skip the `match` fn on the first pass. Use only `where` (structural column filter, already native to the events plugin). This covers push-and-exit: filter by `conversationId`, then re-check `stopReason === "end_turn"` and the token inside the handler after resume. If the resumed handler decides it's the wrong turn, it can call `ctx.waitFor` again — the step log keeps previous work; the second `waitFor` gets a fresh waitName.

### `jobs.resume` — builtin re-enqueue wrapper

Registered once by the jobs plugin itself:

```ts
export const jobsResumeJob = defineJob({
  name: "jobs.resume",
  input: z.object({
    __resume_workflowRunId: z.string(),
    __resume_waitName: z.string(),
    __resume_jobName: z.string(),
    __resume_input: z.unknown(),
    __resume_timeout: z.boolean().optional(),
  }).passthrough(),                     // extra keys = event payload
  run: async (p) => {
    const waitRow = await readWait(p.__resume_workflowRunId, p.__resume_waitName);
    if (!waitRow || waitRow.status !== "pending") return; // already resolved/timed-out (race)

    const { __resume_workflowRunId, __resume_waitName, __resume_jobName, __resume_input, __resume_timeout, ...eventPayload } = p;

    await db.update(_jobWaits)
      .set({
        status: __resume_timeout ? "timed_out" : "resolved",
        payloadJson: __resume_timeout ? null : eventPayload,
        resolvedAt: new Date(),
      })
      .where(and(eq(_jobWaits.workflowRunId, __resume_workflowRunId), eq(_jobWaits.waitName, __resume_waitName)));

    const target = UNSAFE_getRegisteredJob(__resume_jobName);
    if (!target) return; // schema drift — preserve wait row; operator can delete

    await target.enqueue(__resume_input, { jobKey: __resume_workflowRunId });

    // Cancel the other racer (event fired first → cancel timeout; timeout fired first → cancel trigger).
    if (!__resume_timeout) {
      await removeGraphileJobByKey(`timeout:${__resume_workflowRunId}:${__resume_waitName}`);
    }
    // The oneShot trigger row is deleted by the events dispatcher after this returns successfully.
  },
});
```

- Events dispatcher already calls `target.run(merged, ctx)` — so when the event fires, `jobs.resume.run(...)` executes with `jobWith ∪ eventPayload`. The `passthrough()` schema preserves the event payload as extra keys.
- On re-enqueue, `jobKey: workflowRunId` means any in-flight replay of the same workflow is coalesced (graphile's `replace` mode).
- When the target re-runs: `ctx.step` calls return cached results; `ctx.waitFor` for the same `waitName` finds `status=resolved` / `timed_out` and returns immediately without re-registering the trigger.

### Suspend semantics

`ctx.waitFor` and `ctx.sleep` throw `SuspendSignal` (a private error class). The jobs worker's `dispatch` function (`plugins/jobs/server/internal/worker.ts:75-90`) catches it and returns cleanly:

```ts
async function dispatch(payload, ctx) {
  try {
    await job.run(parsed.data, ctx);
  } catch (err) {
    if (err instanceof SuspendSignal) return; // graphile sees success
    throw err;                                 // graphile retries
  }
}
```

`SuspendSignal` is not exported from the jobs plugin barrel — users can't `instanceof` it, so a well-intentioned `try { ... } catch { /* swallow */ }` accidentally captures it. Mitigation: mention it prominently in the `defineJob` JSDoc ("do not wrap `ctx.*` calls in try/catch"), and make `SuspendSignal.message` visible in stack traces so anyone hitting the bug in dev notices fast.

### Cleanup

When the workflow handler returns normally (not via SuspendSignal), the worker runs a cleanup pass:

```ts
await db.delete(_jobSteps).where(eq(_jobSteps.workflowRunId, ctx.workflowRunId));
await db.delete(_jobWaits).where(eq(_jobWaits.workflowRunId, ctx.workflowRunId));
```

Pending trigger rows are NOT cleaned up here — oneShot triggers are removed by the events dispatcher only when their target succeeds. Any still-armed triggers from completed workflows will fire, run `jobs.resume`, find no pending wait, and exit quietly. This is noisy but harmless. A periodic GC sweep is a follow-up.

### Retry behavior

- Whole-handler retries (graphile `maxAttempts`) are unchanged: if the handler throws a non-Suspend error, graphile retries up to `maxAttempts`. Each retry replays the handler; completed steps short-circuit; the failing step re-runs.
- A `maxAttempts: 1` job that contains `ctx.step` and `ctx.waitFor` is still fine — the *steps* absorb transient failures because a successful step doesn't re-run. `maxAttempts: 1` now means "if the final unstepped code path throws, give up," not "the entire business logic can only run once."
- Push-and-exit switches to `maxAttempts: 3`. `send-prompt` is memoized, so the prompt is sent exactly once even if two retries happen before `waitFor` registers the trigger.

### The `conversation.turn-completed` event

New event sourced from the existing JSONL tailer (`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server/internal/watch-jsonl.ts`). Defined in a new small plugin or on the `conversations` server plugin (TBD during implementation — cheapest is a file in the `conversations` server barrel since the JSONL watcher is already a consumer of `findTranscriptPath` etc.):

```ts
export const { event: conversationTurnCompleted } = defineTriggerEvent({
  name: "conversation.turn-completed",
  filters: {
    conversationId: text("conversation_id"),
  },
});
```

Emitted from the watcher's fan-out path: when a tick detects a new assistant `end_turn` event (i.e. `events[events.length-1].type === "assistant-turn" && stop_reason === "end_turn"` and was not present in the previous tick's `events` length), call:

```ts
await conversationTurnCompleted.emit({
  conversationId,
  stopReason: "end_turn",
  text: turnText,
  messageId: turn.messageId,
});
```

The watcher already runs per-conversation and has access to `conversationId`. The addition is ~10 lines.

## Critical files

### New

- `plugins/jobs/server/internal/tables.ts` — `_jobSteps`, `_jobWaits`.
- `plugins/jobs/server/internal/step-ctx.ts` — `ctx.step`, `ctx.waitFor`, `ctx.sleep`, `SuspendSignal`, `workflowRunId` generation.
- `plugins/jobs/server/internal/resume-job.ts` — `jobsResumeJob` builtin.
- `plugins/conversations/server/internal/turn-completed-event.ts` — `conversationTurnCompleted` event.

### Modified

- `plugins/jobs/server/internal/registry.ts` — `JobCtx` gains the new fields; `enqueue()` generates `workflowRunId` if no `jobKey`.
- `plugins/jobs/server/internal/worker.ts` — `dispatch()` catches `SuspendSignal` and returns clean; runs cleanup on normal completion.
- `plugins/jobs/server/index.ts` — register `jobsResumeJob`.
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server/internal/watch-jsonl.ts` — emit `conversationTurnCompleted` from the detection path.
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/push-and-exit-job.ts` — rewrite handler per §Public API.
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/index.ts` — drop the `waitForFinalTurn` + `interpret` imports that move or inline.

### Unchanged

- `plugins/events/**` — no changes. `jobsResumeJob` is just another target job to it.
- The `_push_and_exit_jobs` table — kept as is, it's the user-facing UI state, orthogonal to the workflow machinery.
- All other existing `defineJob` callers (`buildRunJob`, `crashesJob`, event-dispatcher itself, etc.) — they never call `ctx.step` so the new ctx fields are inert.

## Reuse

- `defineTriggerEvent` (`plugins/events/server`) — untouched, consumed by `ctx.waitFor` via `trigger({ on, do: jobsResumeJob, ... })`.
- `trigger()` / `deleteTrigger()` (`plugins/events/server`) — the subscription registry is already restart-durable; we lean entirely on it for wait durability.
- `UNSAFE_getRegisteredJob` (`plugins/jobs/server/internal/registry.ts:82`) — used by `jobsResumeJob` to resolve the target to re-enqueue.
- JSONL tailer fan-out (`.../jsonl-viewer/server/internal/watch-jsonl.ts`) — already detects new events and notifies the `jsonlEventsResource`; we add a parallel `emit()` call on the same detection path.
- `interpret()` / `CLEAN_TOKEN` / `FLAG_TOKEN` (`plugins/.../push-and-exit/server/internal/prompt.ts`) — reused verbatim.
- `sendTurn` / `deleteConversation` / `readConversationTurns` (`@plugins/conversations/server`) — reused; `waitForFinalTurn` is deleted.

## Risks and edge cases

- **Race: event fires while target job is still locked.** After `ctx.waitFor` throws `SuspendSignal`, there's a window where the graphile row is still marked locked (until dispatch returns). If the event fires inside that window, `jobsResumeJob.enqueue(input, { jobKey })` hits a locked row with the same key; graphile-worker's `replace` mode queues the new job to run once the current one completes. Should be fine but must be tested — see Verification.
- **Suspend swallowed by user try/catch.** `defineJob` JSDoc must be explicit. A lint for raw `try` around `ctx.*` calls is a follow-up if this bites.
- **Trigger orphans on workflow abort.** If a handler throws before reaching its waits's cleanup path (e.g., an unrelated step fails), `_jobWaits` rows and their trigger rows stay armed. Events dispatcher will route resume attempts that become no-ops. A background sweep (oldest `_jobWaits` with no corresponding graphile job) can delete them; not in v1 scope.
- **`match` predicate not used in v1.** Push-and-exit doesn't need it — every assistant-turn for a given conversationId is worth resuming on, and the handler re-checks. Other consumers that need richer filtering will add `match` (see §Simplification-for-v1).
- **Step name drift across code versions.** If a handler is deployed with new step names while a workflow is mid-run, the replay won't find its old step names. Same problem Temporal has — documented, not fixed. Schema-drift preservation (events dispatcher already does this for job-name drift) is the precedent.
- **Wait name collision on conditional branches.** If a handler conditionally calls `ctx.waitFor` (A vs B), the default `wait:<eventName>:<seq>` naming produces different `waitName`s on replay if branching uses non-determinism. Mitigation: branching must only depend on already-stepped values, which is the general determinism rule.

## Verification

1. **Unit: `ctx.step` memoization.** Spawn a handler that increments a module-level counter inside a step. Fail the handler by throwing after the step. Retry → assert the counter is still 1 after 3 retries.
2. **Unit: `ctx.waitFor` + event resume.** Define a test event. Enqueue a handler that does `step → waitFor → step`. Emit the event; assert the second step runs and the workflow completes.
3. **Unit: timeout path.** Same as above but emit nothing; wait past `timeoutMs`; assert `waitFor` returns null and the handler's null-branch runs.
4. **Race: server restart mid-wait.** Enqueue a push-and-exit workflow on a live worktree. Kill the bun server (`kill -9` on the pid) while `waitFor` is pending. Restart via `./equin build`. Emit the `conversation.turn-completed` event (e.g. by completing a Claude turn); assert the workflow resumes, the state row moves to `clean`, and the conversation is deleted.
5. **Race: event fires during suspend commit.** Harder to test deterministically; simulate by calling `jobsResumeJob.enqueue` from inside `ctx.waitFor` BEFORE throwing Suspend. Assert the resumed run doesn't re-send the prompt (step cached).
6. **End-to-end: push-and-exit success.** Fresh conversation; click Push & Exit; Claude pushes and emits `PUSH_EXIT_CLEAN`; assert `_push_and_exit_jobs.status='clean'` and the conversation row is gone.
7. **End-to-end: push-and-exit + auto-build.** Same as (6), but with `autoBuild: true` (default). This is the scenario that motivated the doc — the server WILL restart mid-run. Assert the workflow survives and completes.
8. **End-to-end: push-and-exit timeout.** Send a prompt that deliberately avoids the sentinel; wait past `timeoutMs`; assert `_push_and_exit_jobs.status='flag'` with "No final message" detail.
9. **Migrations in sync.** `./equin check --migrations-in-sync` after adding the tables.
10. **Manual UI smoke.** Confirm the Push & Exit button flow end-to-end in the browser at `http://<worktree>.localhost:9000`.

## Out of scope (follow-ups)

- `match` predicate in `ctx.waitFor` (v1 uses `where` only).
- Runtime determinism enforcement (globals patching). The user preference is docs-only for now.
- Background GC of orphan `_jobWaits` / trigger rows.
- Step-level retry (`ctx.step(name, fn, { retries })`).
- Observability: a debug pane showing step logs for each workflow run (add to `plugins/debug/queue`).
- Migrating other long-running flows onto steps (`improve`, `build-run-job` if it grows).
