# Declarative Trigger Sync via Server Contributions

## Context

Job `improve.apply-queue-top` was removed in a refactor but its trigger row survived in the DB. When `conversation.turn-completed` fires, the events dispatcher finds the stale trigger, tries to dispatch to the nonexistent job, and crashes. Root cause: triggers are registered imperatively in `onReady` using a delete-then-reinsert pattern. When a job is removed from code, nothing cleans up its triggers. There is no lifecycle management between durable trigger rows (DB) and ephemeral job registration (in-memory).

The recently-landed server-side contribution API (`server/src/contributions.ts`) provides `defineServerContribution<P>(name)` — a factory+query token. Plugins contribute via `contributions: [Token({...})]` on `ServerPluginDefinition`; consumers call `Token.getContributions()` in `onReady`. Collection happens between the register and onReady phases, so contributions are available before any `onReady` fires.

## Design

### Core idea

1. The events plugin defines a `Trigger` contribution token
2. Consumer plugins declare their triggers as static contributions instead of imperative `onReady` code
3. The events plugin's `onReady` syncs the DB to match exactly what's declared: delete stale rows, insert missing ones
4. A dispatcher safety net catches any remaining edge cases at runtime

### What migrates

**11 static triggers across 8 plugins** — all follow the identical delete-then-reinsert pattern in `onReady`, all with `with: {}` and `oneShot: false`:

| Plugin | Event | Job |
|---|---|---|
| `task-title` | `conversationCreated` | `titleOnConversationCreatedJob` |
| `task-title` | `userTurnSent` | `titleOnUserTurnSentJob` |
| `tasks` | `refAdvanced.where({ refName: "refs/heads/main" })` | `pushIngestJob` |
| `conversations` | `taskStatusChanged` | `maybeLaunchDependentsJob` |
| `queue` | `conversationCreated` | `seedRankJob` |
| `queue` | `conversationTurnCompleted` | `seedRankJob` |
| `turn-summary` | `conversationTurnCompleted` | `generateTurnSummaryJob` |
| `conversation-category` | `conversationTurnCompleted` | `classifyConversationJob` |
| `conversation-progress` | `conversationTurnCompleted` | `classifyProgressJob` |
| `conversation-progress` | `pushLanded` | `markProgressPushedJob` |
| `improve` | `conversationCreated` | `applyGroupJob` |

Note: The `conversations` plugin also has a one-time cleanup of stale `maybeLaunchTaskJob` rows (from the old dynamic per-dep triggers). This sweep moves into the events plugin's `sweepStaleTriggers()`.

### What stays imperative

| Case | Reason |
|---|---|
| `build/server/index.ts` | Conditional `isMain()` guard — trigger only installed on main worktree. Also has orphan-cleanup and auto-build logic in the same `onReady`. |
| `infra/events/server/internal/install-jobs-hooks.ts` | Infrastructure bridge using `UNSAFE_triggerByName` to cross plugin boundaries. |
| `events-test/server/internal/handle.ts` | Test/debug plugin with HTTP-handler-driven trigger creation. |

The `trigger()`, `deleteTriggersFor()`, and `UNSAFE_triggerByName()` functions remain exported for these use cases.

## Implementation

### Step 1: Expose `getAllRegisteredJobNames()` from the jobs plugin

The stale-trigger sweep needs to know which job names are currently registered.

**`plugins/infra/plugins/jobs/server/internal/registry.ts`** — add:
```typescript
export function getAllRegisteredJobNames(): Set<string> {
  return new Set(jobRegistry.keys());
}
```

**`plugins/infra/plugins/jobs/server/index.ts`** — add to exports:
```typescript
export { defineJob, UNSAFE_getRegisteredJob, getAllRegisteredJobNames, DEFAULT_MAX_ATTEMPTS } from "./internal/registry";
```

### Step 2: Define `Trigger` contribution token + sync in events plugin

**`plugins/infra/plugins/events/server/index.ts`**:

Define the token:
```typescript
import { defineServerContribution } from "@singularity/server/contributions";
export const Trigger = defineServerContribution<TriggerSpec<any, any>>("trigger");
```

Add `onReady` to the plugin definition:
```typescript
onReady: async () => {
  const declared = Trigger.getContributions();
  const seenJobs = new Set<string>();
  for (const t of declared) {
    if (!seenJobs.has(t.do.name)) {
      await deleteTriggersFor(t.do);
      seenJobs.add(t.do.name);
    }
    await trigger(t);
  }
  await sweepStaleTriggers();
},
```

The `seenJobs` set is critical: without it, two contributions for the same job (e.g. queue's two `seedRankJob` triggers) would delete each other. `deleteTriggersFor` wipes ALL rows for a job name; the second call would delete the first contribution's freshly-inserted row.

`sweepStaleTriggers()` iterates all trigger tables and deletes rows whose `job_name` doesn't correspond to any registered job. This catches orphaned rows from removed jobs like `improve.apply-queue-top`:

```typescript
async function sweepStaleTriggers(): Promise<void> {
  const registeredNames = getAllRegisteredJobNames();
  if (registeredNames.size === 0) return; // safety: never wipe everything
  for (const table of triggerTableRegistry.values()) {
    const jobNameCol = (table as any).jobName as AnyPgColumn;
    await db.delete(table).where(notInArray(jobNameCol, [...registeredNames]));
  }
}
```

### Step 3: Dispatcher safety net

**`plugins/infra/plugins/events/server/internal/dispatch-job.ts`** — when `UNSAFE_getRegisteredJob(p.jobName)` returns null, instead of throwing (which causes Graphile retries and crash reports):

```typescript
if (!target) {
  console.warn(
    `[events] removing stale trigger ${p.triggerId}: job "${p.jobName}" no longer exists (event "${p.eventName}")`,
  );
  const table = triggerTableRegistry.get(p.eventName);
  if (table) {
    await db.delete(table).where(eq((table as any).id as AnyPgColumn, p.triggerId));
  }
  return;
}
```

Update the file's doc comment to reflect the new behavior (stale triggers are self-healed, not thrown).

### Step 4: Migrate 8 consumer plugins

Each plugin: remove `deleteTriggersFor`/`trigger` imports and calls from `onReady`, add `Trigger` import from `@plugins/infra/plugins/events/server`, add `contributions: [Trigger({...})]`. If `onReady` only did trigger registration, remove it entirely. Append to existing `contributions` array if one exists.

**Files and changes:**

1. **`plugins/tasks/plugins/task-title/server/index.ts`** — remove entire `onReady`, add 2 contributions. Remove `deleteTriggersFor`/`trigger` imports.

2. **`plugins/tasks/server/index.ts`** — remove trigger lines from `onReady` (keep `ensureConversationsMetaTask`, `backfillConversationsMetaParent`, `runInitialReconcile`). Add 1 contribution. Remove `deleteTriggersFor`/`trigger` imports.

3. **`plugins/conversations/server/index.ts`** — remove trigger lines and the stale `maybeLaunchTaskJob` sweep from `onReady` (keep `ensureSystemMeta()`, `startPoller()`, `startTurnEmitter()`). Add 1 contribution to existing `contributions` array. Remove `deleteTriggersFor`/`trigger` imports.

4. **`plugins/conversations/plugins/conversations-view/plugins/queue/server/index.ts`** — remove entire `onReady`, add 2 contributions. Remove `deleteTriggersFor`/`trigger` imports.

5. **`plugins/conversations/plugins/conversation-view/plugins/turn-summary/server/index.ts`** — remove entire `onReady`, add 1 contribution. Remove `deleteTriggersFor`/`trigger` imports.

6. **`plugins/conversations/plugins/conversation-category/server/index.ts`** — remove entire `onReady`, add 1 contribution. Remove `deleteTriggersFor`/`trigger` imports.

7. **`plugins/conversations/plugins/conversation-progress/server/index.ts`** — remove entire `onReady`, add 2 contributions. Remove `deleteTriggersFor`/`trigger` imports.

8. **`plugins/improve/server/index.ts`** — remove trigger lines from `onReady` (keep `ensureImprovementsMetaTask()`). Add 1 contribution. Remove `deleteTriggersFor`/`trigger` imports.

## Verification

1. `./equin build` compiles and starts
2. `./equin check` passes
3. Query trigger tables to verify correct row counts per job and no stale `improve.apply-queue-top` or `maybeLaunchTaskJob` rows
4. Verify `build`'s imperative trigger still works on main
5. Create a task with dependencies; verify `maybeLaunchDependentsJob` fires on dep status change
