# Split `plugins/events/` into `plugins/jobs/` (primitive) + `plugins/events/` (bindings)

## Context

The current `plugins/events/` plugin conflates two concerns:

1. **A durable job primitive.** Graphile-Worker lifecycle, retries, `jobKey` coalescing, `maxAttempts`, action registry.
2. **Event→action bindings.** Per-event trigger tables, filter matching, emit fan-out, one-shot cleanup, `deleteTargeting`.

The pending next step in `/research/2026-04-24-events-adoption-two-migrations.md` was to add `.enqueue()` + a second Graphile task `events.direct` so plugins like **push-and-exit** could use the durable job primitive without defining a dummy event. That would have ossified the conflation (`ctx.table: PgTable | null`, divergent `DISPATCH_TASK` vs `DIRECT_TASK` failure semantics, `[key: string]: unknown` payload constraint leaking into callers).

Every modern durable-job system (Rails ActiveJob, Celery, BullMQ, River, Inngest, Temporal) makes the **job** the primitive and treats events/cron as optional invocation paths on top. The project's "plugins compose apps" vision makes this split strategically important: cron, compound events, webhooks-as-events all slot in cleanly as *more consumers of the jobs primitive*, not as new code paths inside the events plugin.

**Timing is ideal.** The events API has exactly one consumer today (`plugins/events-test/`). Two production features (**push-and-exit**'s in-memory Map + long-running async, **auto-build**'s `setInterval` polling) are waiting for this primitive. Doing the split now costs ~1 day; doing it after `.enqueue()` lands + 3 callers migrate costs a week.

**Outcome:** `defineJob({ name, input, run })` + `.enqueue()` is the sole way to declare background work. `defineTriggerEvent` + `trigger({ on, do: job, with })` binds jobs to events. `defineAction` is deleted. `push-and-exit` will then become a one-liner: HTTP handler writes state row, calls `pushAndExitJob.enqueue({ conversationId })`, done.

## Design

### Layer 1 — `plugins/jobs/` (the primitive)

```ts
// API surface in @plugins/infra/plugins/jobs/server
defineJob<N extends string, S extends z.ZodType>(spec: {
  name: N;
  input: S;
  run: (input: z.infer<S>, ctx: JobCtx) => Promise<void>;
  maxAttempts?: number;                   // default 5
}): JobFactory<N, S>;

type JobFactory<N, S> = {
  readonly name: N;
  readonly inputSchema: S;
  enqueue(
    input: z.input<S>,
    opts?: { jobKey?: string; maxAttempts?: number },
  ): Promise<{ jobId: string }>;
};

type JobCtx = { jobId: string; attempt: number };

// Internal composition API — used by the events plugin's dispatcher.
// Exported for cross-plugin use but documented as "not general-purpose".
getRegisteredJob(name: string): RegisteredJob | undefined;
```

**Owns:** Graphile Worker lifecycle (`startWorker`, `stopWorker`, `getWorkerUtils`), single shared task `"jobs.run"` (job name lives in the payload, not the task identifier), `jobRegistry: Map<string, RegisteredJob>`, `graphile_worker` schema (via `makeWorkerUtils`).

**Failure policy:** unknown job / schema drift → **throw** (fail loud; Graphile retries up to `maxAttempts`, then permanently-fails). Layer 1 has nothing to preserve.

**Single-task design rationale:** matches the existing `events.dispatch` pattern. Graphile's `taskList` is fixed at `run()` time; a single dispatcher that reads a runtime-mutable registry lets the agentic-composition future add jobs without restarting the worker. Observability queries gain one indirection (filter on `payload->>'jobName'` instead of `task_identifier`).

### Layer 2 — `plugins/events/` (event→job bindings)

```ts
// API surface in @plugins/infra/plugins/events/server
defineTriggerEvent<T, F>(spec: DefineTriggerEventSpec<T, F>): { table, event };   // unchanged
trigger<P, I>(spec: {
  on: EventSource<P>;
  do: JobFactory<string, z.ZodType<I>>;
  with: Omit<I, keyof P>;                  // static fields event payload doesn't supply
  oneShot?: boolean;                       // default true
}): Promise<string>;
deleteTrigger(id: string): Promise<void>;
deleteTriggersFor<N, S>(
  job: JobFactory<N, S>,
  configMatch?: Partial<z.input<S>>,
): Promise<void>;
```

**Implementation:** `defineTriggerEvent` keeps per-event Drizzle tables, filter columns, partial indexes — **no schema change**. The events plugin internally registers exactly one job at module-load time:

```ts
// plugins/events/server/internal/dispatch-job.ts
const eventsDispatchJob = defineJob({
  name: "events.dispatch",
  input: z.object({
    eventName: z.string(),
    triggerId: z.string().uuid(),
    jobName: z.string(),
    jobWith: z.record(z.unknown()),
    eventPayload: z.record(z.unknown()),
    oneShot: z.boolean(),
  }),
  run: async (p, ctx) => {
    const target = getRegisteredJob(p.jobName);
    if (!target) { console.warn(...); return; }                      // preservation
    const merged = { ...p.jobWith, ...p.eventPayload };              // event wins on overlap
    const parsed = target.inputSchema.safeParse(merged);
    if (!parsed.success) { console.warn(...); return; }              // preservation
    await target.run(parsed.data, ctx);                              // throws bubble up → Graphile retries
    if (p.oneShot) {
      const table = triggerTableRegistry.get(p.eventName);
      if (table) await db.delete(table).where(eq(table.id, p.triggerId));
    }
  },
});
```

**Preservation policy lives entirely inside this job's `run`.** Layer 1 is fail-loud by default; Layer 2 catches "unknown job" / "schema drift" and returns (completes the Graphile job without throwing, trigger row preserved). Handler throws still bubble up for retry.

`event.emit(payload)` scans matching trigger rows and calls `eventsDispatchJob.enqueue({...})` per row. No more direct `addJob` calls in the events plugin.

### Column aliasing strategy (no data migration)

Trigger tables already use SQL columns `action_name` and `action_config`. Rather than generate a migration to rename them to `job_name`/`job_with`, we **rename the Drizzle property names only**:

```ts
// plugins/events/server/internal/base-columns.ts
export const eventTriggerColumns = () => ({
  id: uuid("id").primaryKey().defaultRandom(),
  jobName: text("action_name").notNull(),                            // Drizzle alias, SQL unchanged
  jobWith: jsonb("action_config").$type<Record<string, unknown>>().notNull(),
  enabled: boolean("enabled").notNull().default(true),
  oneShot: boolean("one_shot").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

No migration file generated. Existing trigger rows (if any in the worktree DB) work unchanged — same JSONB, same action_name strings, just renamed property access. Add a short comment in this file explaining the aliasing.

### `defineAction` is deleted entirely

Unified primitive: only `defineJob`. `ActionFactory`, `ActionRef`, `DefineActionSpec` types removed. The `logPing({label})` factory-call pattern that baked config into an `ActionRef` becomes `trigger({ do: logPing, with: { label } })` instead. `logPing.deleteTargeting` becomes `deleteTriggersFor(logPing, { label })`.

### Barrel boundaries

- `plugins/jobs/server/index.ts` exports: `defineJob`, `getRegisteredJob`, types `JobFactory`, `JobCtx`, `RegisteredJob`. Default export: plugin definition with `onReady: startWorker`, `onShutdown: stopWorker`.
- `plugins/events/server/index.ts` exports: `defineTriggerEvent`, `trigger`, `deleteTrigger`, `deleteTriggersFor`, related types. **Does not re-export `defineJob`** — users import jobs from `@plugins/infra/plugins/jobs/server` directly. One primitive, one source.
- Creates DAG edge `events → jobs`. Acyclic (jobs has no events dependency). Passes `./equin check --plugin-boundaries`.

## Step-by-Step Migration

Each step leaves `./equin build` green and runnable.

### Step 1 — Create `plugins/jobs/` skeleton (no worker yet)

Files created:
- `plugins/jobs/package.json` (add `graphile-worker` dep)
- `plugins/jobs/server/index.ts` — barrel: exports `defineJob`, `getRegisteredJob`, types; default plugin definition with empty `onReady`.
- `plugins/jobs/server/internal/registry.ts` — `jobRegistry: Map<string, RegisteredJob>`; `defineJob()` and `getRegisteredJob()`. `enqueue` stub (throws `"worker not started"` — wired up in Step 2).

Files modified:
- `server/src/plugins.ts` — add `import jobsPlugin from "@plugins/infra/plugins/jobs/server"`, register **before** `eventsPlugin` in the array.
- `web/src/plugins.ts` — no change (jobs has no web surface).

Checkpoint: `./equin build` passes. Jobs plugin exists but is dormant; no callers.

### Step 2 — Move worker to jobs; re-point events at jobs's worker

Files moved (verbatim, adjusted for the new registry):
- `plugins/events/server/internal/worker.ts` → `plugins/jobs/server/internal/worker.ts`
  - Task identifier changed from `DISPATCH_TASK = "events.dispatch"` to `JOB_TASK = "jobs.run"`.
  - Handler looks up `jobRegistry.get(payload.jobName)` and calls `run(parsed, { jobId: runId, attempt })`.
  - Failure policy: on missing job or schema drift, **throw** (Layer 1 default).
- `plugins/jobs/server/internal/registry.ts` `enqueue()` implementation fills in: calls `getWorkerUtils().then(u => u.addJob("jobs.run", { jobName, ...input }, { jobKey, maxAttempts }))`.

Files modified:
- `plugins/jobs/server/index.ts` — `onReady: () => startWorker()`, `onShutdown: () => stopWorker()`.
- `plugins/events/server/index.ts` — remove `startWorker` call from `onReady` (leave `onReady` empty or remove).
- `plugins/events/server/internal/worker.ts` — delete the file (moved). Event-dispatch logic moves to a new `dispatch-job.ts` (see below).
- `plugins/events/server/internal/event.ts` — `emit()` now calls `eventsDispatchJob.enqueue(...)` instead of `(await getWorkerUtils()).addJob(DISPATCH_TASK, ...)`.

Files created:
- `plugins/events/server/internal/dispatch-job.ts` — defines `eventsDispatchJob` via `defineJob` at module load. Imports `getRegisteredJob` from `@plugins/infra/plugins/jobs/server`. Contains the preservation-policy dispatcher. Imported by `events/server/index.ts` for its side effect (module-load registration).

Checkpoint: `./equin build` passes. `events-test` still works end-to-end; only the Graphile task identifier changed (`events.dispatch` → `jobs.run`).

Update in same step:
- `plugins/events-test/server/internal/handle.ts` `handleWaitIdle`: SQL `task_identifier = 'events.dispatch'` → `task_identifier = 'jobs.run'`.

### Step 3 — Migrate `events-test` from `defineAction` to `defineJob`

Files modified:
- `plugins/events-test/server/internal/action.ts`:
  - `defineAction({name, config, run})` → `defineJob({name, input, run})`.
  - Schema field: `config` → `input`; include all fields the handler reads (merge of old `config.label` and old `ctx.payload.{userId, message}`).
  - `run: (config, ctx) => ...` → `run: (input, ctx) => ...`. `ctx.runId` → `ctx.jobId`. `ctx.payload` and `ctx.table` references removed (everything is now in `input`).
- `plugins/events-test/server/internal/handle.ts`:
  - `trigger({ on: source, do: logPing({ label }), oneShot })` → `trigger({ on: source, do: logPing, with: { label }, oneShot })`.
  - `logPing.deleteTargeting({ label })` → `deleteTriggersFor(logPing, { label })`.
- `plugins/events-test/server/index.ts` — if the action file is imported for side effect, confirm import order.

Checkpoint: `./equin build` passes. All 8 existing `events-test` routes continue to function; trigger rows stored as `{ action_name: "events_test.log", action_config: { label } }` work because the dispatch job reads `jobName`/`jobWith` Drizzle properties that alias the same SQL columns.

### Step 4 — Remove `defineAction` from events barrel

Files modified:
- `plugins/events/server/index.ts` — remove `defineAction`, `ActionFactory`, `ActionRef`, `DefineActionSpec` exports.
- `plugins/events/server/internal/trigger.ts`:
  - `TriggerSpec.do` changes from `ActionRef` to `JobFactory<string, z.ZodType>`.
  - `trigger()` writes `jobName: spec.do.name`, `jobWith: spec.with ?? {}` (matching the renamed Drizzle columns).
  - Add `deleteTriggersFor(job, configMatch?)` — sweeps `triggerTableRegistry` running `DELETE WHERE action_name = job.name AND action_config @> configMatch::jsonb` (or no config filter if omitted).
- `plugins/events/server/internal/registry.ts` — remove `actionRegistry`, `RegisteredAction`, `ActionContext`. Keep `triggerTableRegistry` only.
- `plugins/events/server/internal/base-columns.ts` — rename Drizzle properties `actionName` → `jobName`, `actionConfig` → `jobWith`; SQL column names unchanged. Add comment explaining alias.

Files deleted:
- `plugins/events/server/internal/action.ts`.

Checkpoint: `./equin build` passes. `./equin check --plugin-boundaries` passes.

### Step 5 — Add Layer 1 direct-enqueue test route

The existing 8 `events-test` routes all exercise the event→dispatch path. Direct `.enqueue()` (the load-bearing API for push-and-exit) has no test.

Files modified:
- `plugins/events-test/server/index.ts` — register route `POST /api/events-test/direct-enqueue`.
- `plugins/events-test/server/internal/handle.ts` — handler reads `{ label }` from body, calls `logPing.enqueue({ label, userId: "direct", message: "enqueued" })`, returns 202. Caller waits for `/wait-idle` then reads `/log` to verify the entry landed.
- `plugins/events-test/web/components/events-test-view.tsx` — add a "Direct enqueue" button alongside the existing Emit form (optional UI coverage).

Checkpoint: `./equin build` passes. The new route exercises jobs-layer enqueue → Graphile → `jobs.run` handler → `jobRegistry.get("events_test.log").run` → log write, with zero events-layer involvement.

### Step 6 — Regenerate plugin docs

`./equin build` regenerates `docs/plugins.md` via the `plugins-doc-in-sync` check. Commit the regenerated doc as part of the final commit.

## Verification

Run in order after Step 5:

```bash
./equin build
./equin check
```

Then exercise `events-test` from its UI pane (sidebar → Debug → Events Test):

1. **Subscribe + emit + log** — validates full Layer 2 path: event def → trigger insert → emit → `jobs.run` task → `events.dispatch` job → `getRegisteredJob("events_test.log")` → job run → log write → `/wait-idle` returns idle.
2. **Subscribe with `oneShot: true`, emit, verify trigger row gone** via `GET /api/events-test/triggers`.
3. **Subscribe with `userId` filter, emit with mismatching userId** — verify no log entry (filter correctness).
4. **Delete-targeting** with `label: "..."` — verify matching rows removed via `/triggers`.
5. **Direct enqueue (Step 5 new route)** — validates Layer 1 in isolation: no trigger row ever created, `logPing.enqueue({...})` flows straight through `"jobs.run"` → `logPing.run` → log entry.
6. **Worker crash preservation** — subscribe, rename `logPing`'s name in code, rebuild, emit: verify log stays empty, trigger row preserved, Graphile job completes (preservation policy for unknown job). Rename back, re-emit: verify entry lands. (Optional but catches the failure-policy split between layers.)

Test the UI by running the existing `e2e/screenshot.mjs` against the events-test pane; visually confirm trigger list and log populate correctly.

## Critical Files

- `plugins/events/server/internal/worker.ts` — **moved** to `plugins/jobs/server/internal/worker.ts`
- `plugins/events/server/internal/registry.ts` — **split**; `jobRegistry` moves to jobs, `triggerTableRegistry` stays
- `plugins/events/server/internal/event.ts` — `emit()` body swaps `addJob` for `eventsDispatchJob.enqueue`
- `plugins/events/server/internal/trigger.ts` — `TriggerSpec.do` retyped; `deleteTriggersFor` added
- `plugins/events/server/internal/base-columns.ts` — Drizzle property rename
- `plugins/events/server/internal/dispatch-job.ts` — **new**; holds the preservation-policy dispatcher
- `plugins/events/server/internal/action.ts` — **deleted**
- `plugins/events-test/server/internal/action.ts` — `defineAction` → `defineJob`; schema merges config + payload
- `plugins/events-test/server/internal/handle.ts` — `do: logPing({...})` → `do: logPing, with: {...}`; `deleteTargeting` → `deleteTriggersFor`; `wait-idle` task_identifier update
- `server/src/plugins.ts` — register `jobsPlugin` before `eventsPlugin`

## Risks and Explicit Flags

1. **`onReady` parallelism.** `Promise.all` on all `onReady`. Jobs's `startWorker` and events's `defineJob("events.dispatch")` race. Safe because `defineJob` is a synchronous Map write and must run at module-load time (not in `onReady`) — placed in `events/server/internal/dispatch-job.ts`, imported by the events barrel. By the time any `emit()` happens (post-boot), both workers and registries are populated.

2. **In-flight Graphile jobs during the Step 2 deploy** become orphans (`task_identifier = 'events.dispatch'` with no registered handler). Accepted risk in worktree-restart dev workflow; flag in the commit message.

3. **TypeScript type inference for `trigger({ on, do, with })`.** The constraint `with: Omit<I, keyof P>` relies on `P extends Partial<I>` holding structurally. Zod catches mismatches at runtime via `target.inputSchema.safeParse(merged)`. Compile-time errors may be noisy; if inference proves painful, fall back to `with: Record<string, unknown>` with runtime-only validation. Use `z.input<S>` (not `z.infer<S>`) for the `with` type to handle transforms.

4. **Column aliasing is the right default** (no migration, same data). If a future reader is confused by `action_name` storing a job name, the comment in `base-columns.ts` should make the aliasing explicit. A follow-up migration to physically rename columns can happen later at near-zero cost.

5. **`getRegisteredJob` is a wider API surface than ideal** — technically any plugin could call it to invoke any job synchronously. Name it explicitly (not `_internalGetJob`) but document that general plugins should use `job.enqueue(...)`, not `getRegisteredJob(name).run(...)`.

6. **Push-and-exit and auto-build migrations are OUT of scope for this plan.** Once this lands cleanly, those become separate follow-ups, each a small PR that uses `defineJob` + `.enqueue()` (push-and-exit) or `defineTriggerEvent` + `trigger()` (auto-build via a new `tasks_core.push_landed` event).
