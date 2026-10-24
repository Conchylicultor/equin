# Migrate `push-and-exit` from in-memory Map to `defineJob` + persistent state row

## Context

`plugins/conversations/plugins/conversation-view/plugins/push-and-exit/` is one of the two features that motivated the jobs/events split in `research/2026-04-24-global-jobs-events-split.md` (landed as commit `e30d9d7`). That plan promised:

> "push-and-exit will then become a one-liner: HTTP handler writes state row, calls `pushAndExitJob.enqueue({ conversationId })`, done."

Today the plugin stores all per-conversation job state in a module-level `Map<string, JobState>` (`server/internal/job-runner.ts:12`) and kicks off the job with a bare `void runJob(id).catch(...)` in the POST handler (`server/index.ts:15`). Two problems fall out of that shape:

1. **No durability.** Server restart drops the Map. In-flight jobs orphan silently; the UI that was subscribed to the `push-and-exit` resource sees the entry vanish with no notification.
2. **No retries, no backpressure, no observability.** The job runs on the event loop of whatever Bun process accepted the HTTP request. There is no way to inspect running jobs, cap concurrency, or replay a failed one.

The jobs primitive now gives us all three for free. Migrating push-and-exit exercises the `defineJob + .enqueue()` path end-to-end on a real (non-test) feature and removes the last "fire-and-forget promise" pattern from the server.

**Scope:** move job execution to `@plugins/infra/plugins/jobs/server`, back the state with a Drizzle table, keep the existing resource key/shape and all HTTP routes. Zero UI changes.

## Design

### Shape of the DB row

One row per conversation, keyed on `conversation_id` (matches the primary key used everywhere else and gives natural "one push-and-exit in flight per conversation" semantics for free via PRIMARY KEY). Columns mirror the existing `JobState` discriminated union:

```ts
// plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/tables.ts
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { JobState } from "../../shared/resources";

type Status = JobState["status"]; // "running" | "clean" | "flag" | "error"

export const _pushAndExitJobs = pgTable("push_and_exit_jobs", {
  conversationId: text("conversation_id").primaryKey(),
  status: text("status").$type<Status>().notNull(),
  // `flag.text` and `error.message` both land here; null for running/clean.
  detail: text("detail"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

**Why a single `detail` column** rather than separate `flag_text` + `error_message` columns: the union variants never coexist on one row and a single column avoids `CHECK` constraints to enforce which column is set for which status. The mapping between row → `JobState` is one small helper function. No FK to the conversation row: deleting a conversation while a state row exists is already a valid transient (the job sets status=clean, then calls `deleteConversation`, then the UI fires DELETE on this row); adding FK+cascade would delete the row before the UI reads the "clean" notification.

### The job

```ts
// plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/push-and-exit-job.ts
import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";

export const pushAndExitJob = defineJob({
  name: "push_and_exit.run",
  input: z.object({ conversationId: z.string() }),
  maxAttempts: 1, // see "Retry policy" below
  run: async ({ conversationId }, _ctx) => {
    // 1. sendTurn(conversationId, PUSH_AND_EXIT_PROMPT)
    // 2. waitForFinalTurn (600s, unchanged from today)
    // 3. interpret(turn.text)
    // 4. update row: status=clean|flag|error + detail
    // 5. pushAndExitResource.notify()
    // 6. if clean: deleteConversation(id) + recentConversationsResource.notify()
  },
});
```

The body is almost line-for-line the current `runJob()` in `job-runner.ts`, with `jobs.set(...)` swapped for `db.update(_pushAndExitJobs).set({...}).where(eq(...))`. The `interpret()` and `waitForFinalTurn()` helpers move with it unchanged.

**Retry policy — `maxAttempts: 1`.** The default (5) would re-prompt Claude up to 5 times on any thrown error, which is wrong for this handler: the prompt is user-visible, conversation-mutating, and expensive. The existing handler already catches all business failures (timeout → status=flag, any `sendTurn`/poll throw → status=error) and writes them as terminal states, so the only throws that reach Graphile are DB-layer errors, where "don't silently re-prompt Claude" is the correct default. If we later want idempotent retry, the handler can gate `sendTurn` on a `prompt_sent_at` column — flagged as follow-up, not this PR.

**`jobKey: conversationId`.** Coalesces duplicate enqueues; a second POST while a job is running becomes a no-op on the Graphile side (Graphile's `replace` semantics on same key). The HTTP-level 409 guard stays as the primary user-facing protection, but `jobKey` makes the server side idempotent under racing requests.

### The HTTP handler

```ts
// plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/index.ts
"POST /api/conversations/:id/push-and-exit": async (_req, { id }) => {
  const existing = await db.select().from(_pushAndExitJobs).where(eq(_pushAndExitJobs.conversationId, id)).limit(1);
  if (existing[0]?.status === "running") {
    return Response.json({ error: "Already running" }, { status: 409 });
  }
  await db.insert(_pushAndExitJobs)
    .values({ conversationId: id, status: "running", detail: null })
    .onConflictDoUpdate({
      target: _pushAndExitJobs.conversationId,
      set: { status: "running", detail: null, updatedAt: new Date() },
    });
  pushAndExitResource.notify();
  await pushAndExitJob.enqueue({ conversationId: id }, { jobKey: id });
  return Response.json({ ok: true }, { status: 202 });
},

"DELETE /api/conversations/:id/push-and-exit": async (_req, { id }) => {
  await db.delete(_pushAndExitJobs).where(eq(_pushAndExitJobs.conversationId, id));
  pushAndExitResource.notify();
  return Response.json({ ok: true });
},
```

`onConflictDoUpdate` lets the user re-trigger from a prior terminal state (flag/error) cleanly — the row is overwritten to `running` and re-enqueued. Without upsert we would have to branch on existence, which adds a useless round-trip.

### The resource

Shape stays identical (`Record<string, JobState>`) so the UI needs zero changes. Only the loader swaps Map→DB:

```ts
// push-and-exit-job.ts (or wherever the resource is defined)
export const pushAndExitResource = defineResource({
  key: "push-and-exit",
  mode: "push",
  loader: async (): Promise<Record<string, JobState>> => {
    const rows = await db.select().from(_pushAndExitJobs);
    return Object.fromEntries(rows.map((r) => [r.conversationId, rowToState(r)]));
  },
});
```

Where `rowToState(r)` is the small helper that reconstitutes the discriminated union from `{status, detail}`. `pushAndExitResource.notify()` is called from exactly the same three spots as today (POST, DELETE, job `run` terminal transitions).

### UI

No changes. `push-and-exit-button.tsx` subscribes to `pushAndExitResource`, reads `jobs?.[conversation.id]`, and the union shape it sees is byte-for-byte what it sees today.

## Step-by-Step Migration

Each step leaves `./equin build` green.

### Step 1 — Add the table

Files created:
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/tables.ts` — `_pushAndExitJobs` definition above.

Files modified:
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/index.ts` — add `tables: [_pushAndExitJobs]` to the plugin definition (or whatever the project convention is for surfacing schema to drizzle-kit; follow the pattern used by `events-test/server/index.ts`).

Run `./equin build` once — this regenerates the drizzle migration (`migrations-in-sync` check enforces it's committed). Commit the generated file as part of this step's work.

Checkpoint: `./equin build` passes; `./equin check --migrations-in-sync` passes; plugin still runs against the old in-memory Map.

### Step 2 — Define the job, keep the Map as a shim

Files created:
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/push-and-exit-job.ts` — `defineJob({ name: "push_and_exit.run", ... })` wrapping the existing `runJob` body *verbatim* (still mutating the Map, not the table). `ctx` is accepted and ignored.

Files modified:
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/index.ts` — replace `void runJob(id).catch(...)` with `await pushAndExitJob.enqueue({ conversationId: id }, { jobKey: id })`. Add a side-effect import of `./internal/push-and-exit-job` at the top of the barrel so module-load registration happens before any route fires (mirrors `plugins/events/server/index.ts`'s `import "./internal/dispatch-job"` pattern).

Checkpoint: `./equin build` passes. Pushing a branch via the UI now goes through Graphile. The Map is still the store — crashes still lose state — but the *execution path* has moved. This lets us validate enqueue + worker pickup + `notify()` timing in isolation before touching storage.

### Step 3 — Swap the Map for the table

Files modified:
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/job-runner.ts` (now mostly obsolete):
  - Delete `jobs: Map`.
  - Move `waitForFinalTurn` and `interpret` somewhere the job can import them (either stay in this file minus the Map, or inline them into `push-and-exit-job.ts` — preference: keep them here as pure helpers, the file becomes "parsing helpers").
  - Move `pushAndExitResource` definition to `push-and-exit-job.ts` (or a new `resource.ts`). The new loader queries `_pushAndExitJobs`.
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/push-and-exit-job.ts`:
  - Job body swaps every `jobs.set(id, {...}); pushAndExitResource.notify();` for `await db.update(_pushAndExitJobs).set({ status, detail }).where(eq(_pushAndExitJobs.conversationId, id)); pushAndExitResource.notify();`.
  - `catch` branch writes `{ status: "error", detail: err.message }` to the row.
  - On `clean`: update row to `{ status: "clean", detail: null }`, notify, *then* `deleteConversation(id)`, *then* `recentConversationsResource.notify()`. Order matters — UI needs to see the clean status before the conversation disappears.
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/index.ts`:
  - POST: upsert row via `onConflictDoUpdate`, 409 if `existing.status === "running"`, enqueue.
  - DELETE: `db.delete(...).where(eq(...))`, notify.

Files deleted:
- Nothing deleted outright; `job-runner.ts` shrinks to helpers only (or gets renamed/merged). If the file ends up empty, delete it.

Checkpoint: `./equin build` passes. Kill the server mid-push: re-start it, the `running` row is still there; Graphile re-runs the job (see "Risks" #2 for the re-prompt concern). UI shows the status correctly after restart — this is the observable improvement the migration delivers.

### Step 4 — Regenerate plugin docs

`./equin build` regenerates `docs/plugins.md` via the `plugins-doc-in-sync` check. The push-and-exit entry gains a `DB schema: ...` line. Commit.

## Verification

```bash
./equin build
./equin check
```

End-to-end in the UI (any conversation at `http://<worktree>.localhost:9000/c/<id>`):

1. **Happy path (clean):** click Push & Exit on a conversation with committable work. Button shows "Pushing…", then disappears on success; conversation vanishes from the sidebar list; toast shows "Pushed and closed". Confirm:
   - `SELECT * FROM push_and_exit_jobs` is empty after the UI-triggered DELETE fires.
   - `graphile_worker.jobs` no longer contains the `push_and_exit.run` row (completed).
2. **Flag path:** click on a conversation with uncommitted design-doc changes (a realistic "flag" case). Dialog opens with the flag text, no conversation deletion, row persists as `status=flag, detail=<text>`. Click "Keep open" → DELETE fires → row gone.
3. **Error path:** click on a conversation whose worktree no longer exists (or stub `sendTurn` to throw). Row reaches `status=error, detail=<message>`; toast shown; UI auto-fires DELETE; row gone.
4. **Duplicate click guard:** click twice in quick succession. Second POST returns 409 (existing guard works against the row, not the Map).
5. **Server restart mid-push:** click Push & Exit; while `status=running`, `Ctrl-C` and re-start the server. Row is still `running`; Graphile picks the job back up (see Risks #2 for the re-prompt concern).
6. **Plugin boundaries:** `./equin check --plugin-boundaries` passes — the only new cross-plugin import is `defineJob` from `@plugins/infra/plugins/jobs/server`, which events-test already validates is legal.

## Critical Files

- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/tables.ts` — **new**, `_pushAndExitJobs` table
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/push-and-exit-job.ts` — **new**, `pushAndExitJob = defineJob(...)` plus (in Step 3) the resource definition
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/job-runner.ts` — **shrunk** to `waitForFinalTurn` + `interpret` helpers (or merged into the job file and deleted)
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/index.ts` — **rewritten** POST/DELETE handlers; side-effect import of the job module
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/shared/resources.ts` — **unchanged** (the UI contract is frozen)
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/components/push-and-exit-button.tsx` — **unchanged**
- `docs/plugins.md` — regenerated, gains a DB schema line
- `server/src/db/migrations/<timestamp>_<hash>.sql` — **new**, generated by drizzle-kit

Reference existing patterns to copy:
- `plugins/events-test/server/internal/log-job.ts` — exact `defineJob({name, input, run})` shape
- `plugins/events-test/server/internal/handle.ts:handleDirectEnqueue` — exact `.enqueue({...})` call pattern
- `plugins/events/server/index.ts` — the `import "./internal/dispatch-job"` side-effect pattern for module-load registration

## Risks and Explicit Flags

1. **`maxAttempts: 1` means no free retry on transient DB errors.** If the UPDATE at the end of `run` throws (connection drop, lock timeout), the job fails permanently and the row stays `running` forever until the user clicks DELETE or admin intervention. This matches current behavior (the Map would be stuck too), but now has a persistent fingerprint. If this becomes a problem in practice, the fix is to bump `maxAttempts` and add an idempotency guard via a `prompt_sent_at` column — follow-up, not this PR.

2. **Server crash mid-job re-prompts Claude.** When the worker dies without throwing (SIGKILL, OOM), Graphile unlocks the job after its lock timeout (~5 min default) and a new worker picks it up. The re-run will call `sendTurn` a second time, which posts the prompt as a new turn in the (already-mid-conversation) thread. Claude's response may be degraded. Accepted for this PR because (a) crash-mid-push is rare in the dev workflow, (b) today's behavior loses the state entirely — the new behavior is strictly better even with this edge case, (c) a follow-up can add the `prompt_sent_at` guard described above. **Flag this in the commit message.**

3. **Zombie `running` rows after a crash-without-retry.** With `maxAttempts: 1`, a job that fails once is permanently-failed; its row in Graphile stays with `attempts >= max_attempts` but no new worker will pick it up. The `_pushAndExitJobs` row stays `running` forever. Mitigation options: (a) startup sweep (`UPDATE _pushAndExitJobs SET status='error', detail='Lost on restart' WHERE status='running' AND updatedAt < now() - interval '30 min'`), (b) surface a "stuck" dismiss control in the UI. Neither is in scope for this PR; flag in the commit message as known follow-up.

4. **Order of operations on `clean`.** The job must write `status=clean` and `notify()` *before* calling `deleteConversation`, otherwise the UI sees the conversation disappear without seeing the clean state and the success toast never fires. Current code has this order implicitly (notify() first, deleteConversation() second); preserve it explicitly in the job body. The verification checklist item #1 catches regressions.

5. **Resource loader latency.** Today's loader is a Map iteration (microseconds); the new loader is a `SELECT * FROM _pushAndExitJobs`. Fine for realistic scales (handful of conversations per worktree); flag for follow-up if table ever grows unbounded. The loader is called on every `notify()`, so a O(n) scan per notify is the shape — acceptable.

6. **Mid-push cancellation is *not* being added.** Current UI has no cancel-while-running control (button shows "Pushing…" disabled). The DELETE route only fires from terminal states. Persisting the row doesn't change this; adding cancel would require the job to check the row between steps and bail if the row is gone — a real feature, out of scope.
