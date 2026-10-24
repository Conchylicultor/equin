# Crashes Plugin — Auto-Task Creation for Server & Frontend Crashes

## Context

Today, when the server crashes (`uncaughtException`, unhandled rejection) or the frontend throws, nothing happens beyond a log line or a red toast. There is no durable record and no queued work for an agent to pick up. We want every crash to become an actionable child task under a dedicated **Crashes** meta-task so the agent manager can launch an agent on it, the same way it does for `Agents` and `Conversations` today.

The core design constraint is **dedup**: a crashloop must not spam the task list. Identical crashes should roll up into one task with a counter. The primary mechanism is a deterministic **fingerprint** on the error (type + normalized top stack frames), enforced by a unique index at the DB layer so upserts are atomic.

## Goals

- Capture server uncaughtException / unhandledRejection; durably record them even though the process is dying.
- Capture frontend `window.error`, `unhandledrejection`, and React render errors via the existing `PluginErrorBoundary`.
- Dedup by fingerprint: first crash → new task; repeats → count bump on the same crash row.
- On drop (task resolved) + recurrence: create a fresh task (regression signal).
- Velocity cap: >20 crashes / 60s per fingerprint flips `crash_loop=true` → stop updating the task and stop notifying the resource, but keep bumping the DB count.
- Tag every crash with `SINGULARITY_WORKTREE` so cross-worktree noise stays separated.

## Non-goals (v1)

- No structured `FATAL`-log subscription. We can layer it on top of `Log.subscribe` later — not required for v1.
- No dedicated Crashes UI pane. The auto-created tasks are enough; a debug panel is future work.
- No source-map resolution for frontend stacks. Raw bundled stacks are acceptable v1; deep-link to source comes later.

## Architecture at a Glance

```
 Browser                             Server                         DB
 ────────                            ────────                       ──
  window.error ─┐
  unhandled  ───┼──► POST /api/crashes ──► fingerprint ──► upsert(crashes)
  Boundary   ───┘                                             │
                                                              ├─ inserted? → createTask() → link
 process.uncaughtException ──► fs.appendFileSync(jsonl)       │
 process.unhandledRejection ─►  ./crashes-buffer/<wt>.jsonl   ├─ crash_loop? → skip task update
                                    ▼                         │
                              onReady() flush ────► POST-equivalent (in-process)
```

Three crash sources converge on **one upsert path**. The upsert row drives whether a task is created, reused, or skipped.

## Plugin Layout

New top-level plugin `plugins/crashes/` (peer of `agents`, `tasks`, `health`):

```
plugins/crashes/
├── package.json                       # @singularity/plugins-crashes
├── shared/
│   ├── fingerprint.ts                 # shared normalize+hash (used by server & web)
│   └── types.ts                       # CrashSource, CrashReport (POST body), Crash row
├── server/
│   ├── index.ts                       # ServerPluginDefinition (routes, resources, onReady)
│   ├── api.ts                         # public exports (CRASHES_META_TASK_ID, recordCrash)
│   └── internal/
│       ├── tables.ts                  # _crashes pgTable
│       ├── resources.ts               # crashesResource (push)
│       ├── meta-crashes.ts            # CRASHES_META_TASK_ID + ensureCrashesMetaTask
│       ├── record-crash.ts            # single upsert path used by route + flush
│       ├── velocity.ts                # in-process sliding window
│       ├── buffer.ts                  # jsonl file read/append/flush helpers
│       ├── handle-report.ts           # POST /api/crashes handler
│       └── process-hooks.ts           # uncaughtException / unhandledRejection listeners
└── web/
    ├── index.ts                       # PluginDefinition (Core.Root contribution)
    ├── components/
    │   └── crash-reporter.tsx         # effect-only component; installs window listeners
    └── report.ts                      # report(err) → fetch POST /api/crashes
```

### Critical files touched outside the plugin

- `server/src/db/schema.ts` — add `export * from "@plugins/crashes/server/internal/tables";`
- `server/src/plugins.ts` — import and append `crashesPlugin`. Must load **before** other plugins so `process-hooks` install early, and **before** any plugin whose `onReady` might throw (so the flush sees a clean DB).
- `web/src/plugins.ts` — import and append the web plugin.
- `plugin-core/error-boundary.tsx` — add `componentDidCatch` that calls `report({...})`. Single hook point catches React render errors from every slot. Keep the error-boundary's UI unchanged.

## Schema

`plugins/crashes/server/internal/tables.ts` (style mirrors `plugins/tasks-core/server/internal/tables.ts`):

```typescript
import {
  boolean, index, integer, pgTable, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";
import { _tasks } from "@plugins/tasks-core/server/internal/tables";

export const _crashes = pgTable(
  "crashes",
  {
    id: text("id").primaryKey(),           // `crash-${Date.now()}-${rand}`
    fingerprint: text("fingerprint").notNull(),
    worktree: text("worktree").notNull(),
    source: text("source").notNull(),      // 'server-uncaught' | 'server-unhandled' | 'browser-error' | 'browser-rejection' | 'react-boundary'
    errorType: text("error_type"),         // e.g. 'TypeError'
    message: text("message").notNull(),
    stack: text("stack"),
    url: text("url"),                      // page URL (browser only)
    userAgent: text("user_agent"),         // browser only
    count: integer("count").notNull().default(1),
    crashLoop: boolean("crash_loop").notNull().default(false),
    taskId: text("task_id").references(() => _tasks.id, { onDelete: "set null" }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt:  timestamp("last_seen_at",  { withTimezone: true }).defaultNow().notNull(),
    createdAt:   timestamp("created_at",    { withTimezone: true }).defaultNow().notNull(),
    updatedAt:   timestamp("updated_at",    { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("crashes_fingerprint_worktree_idx").on(t.fingerprint, t.worktree),
    index("crashes_task_id_idx").on(t.taskId),
  ],
);
```

The **unique `(fingerprint, worktree)`** index is the load-bearing invariant: it makes `INSERT … ON CONFLICT DO UPDATE` the single atomic dedup primitive.

## Fingerprinting

`shared/fingerprint.ts` (used by both server and web so the contract is symmetric):

```typescript
export function fingerprint(errorType: string | undefined, stack: string | undefined): string {
  const frames = normalizeFrames(stack ?? "");
  const top = frames.slice(0, 3).join("|");
  const input = `${errorType ?? "Error"}|${top}`;
  return sha256(input).slice(0, 16);    // 64 bits is fine at our scale
}

function normalizeFrames(stack: string): string[] {
  return stack
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith("at "))
    .map(l => l
      .replace(/:\d+:\d+\)?$/, "")       // strip :line:col
      .replace(/\?v=[a-z0-9]+/gi, "")    // strip vite cache-busters
      .replace(/\/node_modules\/\.vite\/deps\//, "/NM/")
    );
}
```

**Tradeoff (v1):** top-3 normalized frames with file paths but **no line numbers**. Too coarse and unrelated bugs collapse; too fine and every deploy creates a new task. This default is a reasonable starting point — tune if false-merges show up in practice.

## Upsert + Task-Creation Flow

`server/internal/record-crash.ts` is the single entry point used by both the HTTP handler and the boot-time flush:

```typescript
export async function recordCrash(input: CrashReport): Promise<void> {
  const fp = fingerprint(input.errorType, input.stack);
  const worktree = process.env.SINGULARITY_WORKTREE!;

  // 1. velocity cap first — decides whether to do any downstream work
  const loop = bumpWindowAndCheck(fp);

  // 2. atomic upsert
  const id = `crash-${Date.now()}-${rand()}`;
  const [row] = await db
    .insert(_crashes)
    .values({ id, fingerprint: fp, worktree, ...input, crashLoop: loop })
    .onConflictDoUpdate({
      target: [_crashes.fingerprint, _crashes.worktree],
      set: {
        count: sql`${_crashes.count} + 1`,
        lastSeenAt: new Date(),
        updatedAt:  new Date(),
        crashLoop:  sql`${_crashes.crashLoop} OR ${loop}`,
        // do NOT overwrite message/stack — first-seen is canonical
      },
    })
    .returning();                                    // full row, post-upsert

  // 3. crash_loop? just notify and bail — no task churn
  if (row.crashLoop) {
    crashesResource.notify();
    return;
  }

  // 4. need a task? (no link, or linked task is dropped)
  const needsTask =
    row.taskId === null ||
    !(await hasOpenTask(row.taskId));

  if (needsTask) {
    const task = await createTask({
      parentId: CRASHES_META_TASK_ID,
      title:    taskTitle(row),
      description: taskDescription(row),
      author:   "crashes-plugin",
    });
    await db.update(_crashes).set({ taskId: task.id }).where(eq(_crashes.id, row.id));
  }
  crashesResource.notify();
}
```

### Task body

```
Source: server-uncaught   Worktree: claude-1776772879-uo9q
Fingerprint: a3b1…        Count: 1   First seen: 2026-04-21T14:22:03Z

TypeError: Cannot read properties of undefined (reading 'id')
    at handleTurn (/.../plugins/conversations/server/internal/turns.ts:87)
    at …
```

Brief, scannable. An agent picking up the task has the fingerprint + stack + worktree — enough to bisect. (Pointer to `Log.channel("server")` could be added later once the logs plugin supports channel-and-range query params.)

Task title keeps it short for the list view: `[crash] TypeError: Cannot read properties of undefined (reading 'id')` (truncated to ~80 chars).

### Recurrence-after-drop

`hasOpenTask(taskId)` returns false when the task is dropped or deleted. That flips `needsTask=true` and creates a new task, overwriting `crashes.taskId` with the new id. The old task is left alone — it remains dropped, and the dropped timestamp is preserved as history.

## Velocity Cap

`server/internal/velocity.ts`:

```typescript
const WINDOW_MS = 60_000;
const THRESHOLD = 20;
const windows = new Map<string, { start: number; count: number }>();

export function bumpWindowAndCheck(fp: string): boolean {
  const now = Date.now();
  const w = windows.get(fp);
  if (!w || now - w.start > WINDOW_MS) {
    windows.set(fp, { start: now, count: 1 });
    return false;
  }
  w.count++;
  return w.count > THRESHOLD;
}
```

Purely in-process. No DB roundtrip in the hot path. Gets cleared on process restart — fine, because a restart breaks the loop anyway.

`crash_loop` on the row is **sticky** (`OR`'d, never reset in the UPDATE) so the UI can show "this crash looped before" even after the window clears. A manual "clear" action can reset it later; not needed v1.

## Server Capture — File Buffer + Flush

The Postgres driver is async-only, so an `uncaughtException` handler cannot reach the DB before the event loop dies. We buffer to disk synchronously.

### Buffer location

`~/.singularity/crashes/<worktree>.jsonl` — one JSON object per line. Lives outside the worktree so re-forks / branch switches don't wipe it.

### `server/internal/process-hooks.ts`

```typescript
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = join(homedir(), ".singularity", "crashes");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${process.env.SINGULARITY_WORKTREE}.jsonl`);

export function installProcessHooks() {
  process.on("uncaughtException", (err) => {
    appendCrashSync("server-uncaught", err);
    // let Node's default behavior exit the process
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    appendCrashSync("server-unhandled", err);
    // do NOT exit — matches current Node behavior (log + continue)
  });
}

function appendCrashSync(source: CrashSource, err: Error) {
  const line = JSON.stringify({
    source,
    errorType: err.name,
    message: err.message,
    stack: err.stack,
    at: new Date().toISOString(),
  }) + "\n";
  try { appendFileSync(file, line); } catch { /* best-effort */ }
}
```

### `onReady` flush

```typescript
onReady: async () => {
  installProcessHooks();
  await ensureCrashesMetaTask();
  await flushBufferedCrashes();   // reads file, recordCrash() each, unlinks on success
}
```

Order matters: install hooks first (so a crash during flush still gets buffered), then ensure the meta-task, then drain. Flush failures don't block startup — they log and leave the file for next boot.

## Frontend Capture

### `web/components/crash-reporter.tsx`

Effect-only `Core.Root` contribution, mirroring `ReconnectWatcher`:

```tsx
export function CrashReporter() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      report({
        source: "browser-error",
        errorType: e.error?.name,
        message: e.message,
        stack: e.error?.stack,
        url: window.location.href,
        userAgent: navigator.userAgent,
      });
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const err = e.reason instanceof Error ? e.reason : null;
      report({
        source: "browser-rejection",
        errorType: err?.name,
        message: err?.message ?? String(e.reason),
        stack: err?.stack,
        url: window.location.href,
        userAgent: navigator.userAgent,
      });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
```

### `plugin-core/error-boundary.tsx` — one-line hook

Add `componentDidCatch` that fires a best-effort POST:

```typescript
componentDidCatch(error: Error, info: ErrorInfo) {
  // Dynamically import to avoid a hard dep from plugin-core → plugins/crashes.
  // Silently swallow on failure — we're already in an error path.
  import("@plugins/crashes/web/report").then(m => m.report({
    source: "react-boundary",
    errorType: error.name,
    message: error.message,
    stack: error.stack,
    componentStack: info.componentStack,
    url: window.location.href,
    userAgent: navigator.userAgent,
  })).catch(() => {});
}
```

Every per-slot boundary already wraps every contribution, so this single hook covers all React render errors without a new top-level boundary.

### `web/report.ts`

Bare `fetch` to `/api/crashes`, fire-and-forget:

```typescript
export function report(body: CrashReport): void {
  try {
    void fetch("/api/crashes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,   // survives page unload
    }).catch(() => {});
  } catch { /* never throw from the error path */ }
}
```

`keepalive: true` matters: a crash that happens during navigation / unload must still send.

## Plugin Registration Steps

1. `plugins/crashes/server/index.ts`:
   ```typescript
   export default {
     id: "crashes", name: "Crashes",
     description: "Records server/frontend crashes and files deduped tasks.",
     httpRoutes: { "POST /api/crashes": handleReport },
     resources: [crashesResource],
     onReady: async () => {
       installProcessHooks();
       await ensureCrashesMetaTask();
       await flushBufferedCrashes();
     },
   } satisfies ServerPluginDefinition;
   ```
2. `plugins/crashes/web/index.ts`:
   ```typescript
   export default {
     id: "crashes", name: "Crashes",
     description: "Reports uncaught errors to the server.",
     contributions: [Core.Root({ component: CrashReporter })],
   } satisfies PluginDefinition;
   ```
3. Add `export * from "@plugins/crashes/server/internal/tables";` to `server/src/db/schema.ts`.
4. Append `crashesPlugin` to `server/src/plugins.ts`. Place **early** in the list so process hooks install before other plugins can crash on `onReady`.
5. Append the web plugin to `web/src/plugins.ts`.
6. Update `docs/plugins.md` with the new plugin entry.

## Verification

End-to-end test plan for after implementation:

1. **Build + migration generation.**
   ```
   ./equin build --migration-name add_crashes
   ```
   Confirm a new `..._add_crashes.sql` file appears under `server/src/db/migrations/` containing `CREATE TABLE "crashes"`, the unique index on `(fingerprint, worktree)`, and the FK to `tasks.id` with `ON DELETE SET NULL`.

2. **Meta-task appears.** Open the app, confirm a root-level task titled "Crashes" exists.

3. **Server uncaughtException.** In a throwaway route, `throw new Error("boom")` inside a `setTimeout` callback (bypasses the top-level try/catch). After the worktree server restarts, confirm:
   - `~/.singularity/crashes/<worktree>.jsonl` was created and then deleted post-flush.
   - One new child task under "Crashes" with title `[crash] Error: boom`.
   - `SELECT * FROM crashes;` shows `count=1`, `task_id` set, `source='server-uncaught'`.

4. **Dedup.** Trigger the same error 5 times. Confirm **one** task, `count=5`, `last_seen_at` advances.

5. **Drop + recurrence.** Drop the task from the UI. Trigger the error again. Confirm a **new** child task is created and `crashes.task_id` updates to point to it. The old dropped task remains untouched.

6. **Crashloop cap.** In a loop, throw 30× in 1s. Confirm `crash_loop=true` on the row, `count≈30`, and the task is **not** updated past the first cap (no repeated resource notifications — check the `/ws/notifications` frames in devtools).

7. **Frontend `window.error`.** In devtools, `setTimeout(() => { throw new Error("frontend-boom"); }, 0)`. Confirm a new crash row with `source='browser-error'` and a task.

8. **Frontend `unhandledrejection`.** `Promise.reject(new Error("rej"))` in devtools. Same check with `source='browser-rejection'`.

9. **React boundary.** Temporarily make a slot component throw during render. Confirm the `PluginErrorBoundary` still renders its retry UI, **and** a crash row/task lands with `source='react-boundary'`.

10. **Cross-worktree isolation.** Trigger the same error in two different worktrees. Confirm two separate crash rows (different `worktree`) and two separate tasks — the unique index is `(fingerprint, worktree)`, not `fingerprint` alone.

## Open Questions / Future Work

- **Structured log subscription.** Once the logs plugin gains a `level` field (or we adopt a `[FATAL]` convention), subscribe in `onReady` and treat fatal lines as a third server source. Not needed v1.
- **Crashes debug panel.** A `Debug.Item` entry showing the `crashes` table with count/last-seen columns would be valuable once there's enough volume to browse.
- **Source-map resolution.** Frontend stacks are minified; wiring up source maps on the server-side recorder would improve fingerprint stability across deploys and give agents readable stacks.
- **Fingerprint tuning.** The top-3-frames heuristic will merge some unrelated bugs and split some related ones. Revisit after a week of real data.
- **Sync-unsafe buffer growth.** If a crashloop writes thousands of lines to the jsonl file before the process exits, the next boot's flush will be slow. A size cap (e.g. keep last 100 lines per file) is cheap to add if it becomes relevant.
