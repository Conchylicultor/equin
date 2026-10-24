# Required `dedup` field on `defineJob` — fix duplicate builds, prevent the class of bug

## Context

During zero-downtime hot restart, two server processes coexist briefly. Both run `onReady`, both call `buildRunJob.enqueue({})` — and since no `jobKey` is passed, graphile-worker inserts two independent rows. The in-memory `inflight` boolean is per-process, so both handlers pass the guard and start concurrent builds.

Observed: two `buildRunJob` instances enqueued 18ms apart for the same commit, both failing.

Root causes:
1. `buildRunJob.enqueue({})` passes no `jobKey` — graphile can't deduplicate.
2. The `defineJob` API silently defaults to no dedup. Forgetting `jobKey` is invisible.

### Prerequisite: enqueue unification (done)

The event dispatch system previously called `target.run()` directly, bypassing the target's `enqueue()` and its dedup logic. This was fixed in `23ed1ded` — dispatch now calls `target.enqueue(p.jobWith, { _event: eventArg })` (dispatch-job.ts:68). Both direct enqueues and event-triggered jobs share the same `enqueue()` path, so the `dedup` field below applies uniformly.

## Design: required `dedup` field

Make every `defineJob` call explicitly declare its dedup strategy. No default — omitting the field is a type error.

### Type

```ts
type Dedup<S extends z.ZodType> =
  | "singleton"                              // one globally, constant key
  | "none"                                   // no dedup, new UUID per enqueue
  | { key: (input: z.infer<S>) => string };  // entity-scoped, key derived from input
```

**File: `plugins/infra/plugins/jobs/server/internal/registry.ts`**

```ts
export interface DefineJobSpec<N extends string, S extends z.ZodType, E extends z.ZodType> {
  name: N;
  input: S;
  event: E;
  dedup: Dedup<S>;   // REQUIRED — no silent default
  run: (args: { input: z.infer<S>; event: z.infer<E> | undefined; ctx: JobCtx }) => Promise<void> | void;
  maxAttempts?: number;
}
```

### Semantics in `enqueue()`

Replace the current `opts?.jobKey` logic (registry.ts:219-222) with dedup-derived keys:

```ts
async function enqueue(input: unknown, opts?: EnqueueOpts): Promise<{ jobId: string }> {
  const parsed = spec.input.parse(input);

  let effectiveJobKey: string | undefined;
  if (spec.dedup === "singleton") {
    effectiveJobKey = "_";
  } else if (spec.dedup !== "none") {
    effectiveJobKey = spec.dedup.key(parsed);
  }
  // dedup: "none" → effectiveJobKey stays undefined → randomUUID path

  const workflowRunId = effectiveJobKey
    ? `${spec.name}:${effectiveJobKey}`
    : randomUUID();
  const graphileJobKey = effectiveJobKey ? workflowRunId : null;
  // ... rest unchanged
}
```

### Remove `jobKey` from `EnqueueOpts`

With dedup declared at definition time, `jobKey` on `EnqueueOpts` is no longer needed. The `_event` field (added by the enqueue unification) stays — it's internal plumbing for the dispatch system:

```ts
export interface EnqueueOpts {
  maxAttempts?: number;
  runAt?: Date;
  tx?: EnqueueTx;
  /** @internal — only the events dispatcher should set this. */
  _event?: unknown;
}
```

The resume system (`resume-job.ts:110-118`) already bypasses `enqueue()` entirely — it calls `utils.addJob` directly with a raw `jobKey`. No changes needed there.

### Expose `dedup` on `RegisteredJob`

Add `dedup: string` to `RegisteredJob` (registry.ts:73) and populate it in the `register()` callback (`"singleton"`, `"none"`, or `"keyed"`). Lets the debug queue pane show each job's dedup strategy.

## Migration: all `defineJob` calls

| Job | Current dedup | New `dedup` |
|-----|---------------|-------------|
| `buildRunJob` | none (bug) | `"singleton"` |
| `backupRunJob` | `jobKey: "backup.periodic"` | `"singleton"` |
| `ttlCleanupJob` | `jobKey: "notifications.ttl-cleanup"` | `"singleton"` |
| `workflowRunJob` | `jobKey: execution.id` | `{ key: (input) => input.executionId }` |
| `exitCleanFinalizeJob` | `jobKey: conversationId` | `{ key: (input) => input.conversationId }` |
| `maybeLaunchTaskJob` | none (CAS guard in handler) | `"none"` |
| `maybeLaunchDependentsJob` | none (fan-out) | `"none"` |
| `eventsDispatchJob` | none (per-dispatch) | `"none"` |
| `jobsResumeJob` | none (internal, bypasses enqueue) | `"none"` |
| `applyGroupJob` | none | `"none"` |
| `logPing` | none (test) | `"none"` |
| `classifyConversationJob` | none | `"none"` |
| `classifyProgressJob` | none | `"none"` |
| `generateTurnSummaryJob` | none | `"none"` |
| `markProgressPushedJob` | none | `"none"` |
| `advancePinJob` | none | `"none"` |
| `validatePinJob` | none | `"none"` |
| `seedRankJob` | none | `"none"` |
| `taskStatusPinJob` | none | `"none"` |
| `pushIngestJob` | none | `"none"` |
| `titleOnConversationCreatedJob` | none | `"none"` |
| `titleOnUserTurnSentJob` | none | `"none"` |

All enqueue call sites that currently pass `jobKey` drop it — the key is now derived from the definition:
- `plugins/backup/server/index.ts` — drop `{ jobKey: "backup.periodic" }`
- `plugins/backup/server/internal/backup-job.ts` — drop `jobKey`, keep `{ runAt }`
- `plugins/notifications/server/index.ts` — drop `jobKey`, keep `{ runAt }`
- `plugins/notifications/server/internal/ttl-cleanup.ts` — same
- `plugins/apps/.../workflows/.../routes.ts` — drop `{ jobKey: execution!.id }`
- `plugins/conversations/.../push-and-exit/.../mcp-tools.ts` — drop `{ jobKey: conversationId }`

## Files to modify

| File | Change |
|---|---|
| `plugins/infra/plugins/jobs/server/internal/registry.ts` | Add `Dedup` type, make `dedup` required on `DefineJobSpec`, remove `jobKey` from `EnqueueOpts`, derive key in `enqueue()`, expose on `RegisteredJob` |
| `plugins/build/server/internal/build-run-job.ts` | Add `dedup: "singleton"` |
| `plugins/backup/server/internal/backup-job.ts` | Add `dedup: "singleton"`, drop `jobKey` from self-reschedule |
| `plugins/backup/server/index.ts` | Drop `jobKey` from boot enqueue |
| `plugins/notifications/server/internal/ttl-cleanup.ts` | Add `dedup: "singleton"`, drop `jobKey` from self-reschedule |
| `plugins/notifications/server/index.ts` | Drop `jobKey` from boot enqueue |
| `plugins/apps/.../workflows/.../run-job.ts` | Add `dedup: { key: ... }` |
| `plugins/apps/.../workflows/.../routes.ts` | Drop `jobKey` from enqueue |
| `plugins/conversations/.../push-and-exit/.../exit-clean-finalize-job.ts` | Add `dedup: { key: ... }` |
| `plugins/conversations/.../push-and-exit/.../mcp-tools.ts` | Drop `jobKey` from enqueue |
| 12 other `defineJob` files | Add `dedup: "none"` |

## Verification

1. `./equin build` — deploys cleanly
2. `./equin check` — passes all checks (TypeScript catches any `defineJob` missing `dedup`)
3. Trigger a hot restart — inspect `graphile_worker.jobs` to confirm only one `build.run` row exists
4. Query `graphile_worker.jobs WHERE task_identifier = 'jobs.run'` — verify backup/notification jobs still reschedule with correct keys
5. Trigger a manual backup — verify it deduplicates against a pending periodic backup (new behavior: both share the singleton key)
