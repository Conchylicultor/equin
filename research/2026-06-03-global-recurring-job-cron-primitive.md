# Recurring-job (cron) primitive for the jobs plugin

## Context

Claude Code deletes session-transcript JSONL files (`~/.claude/projects/<dir>/<session>.jsonl`)
whose **mtime** is older than `cleanupPeriodDays` (default 30). equin reads those
files directly as the *sole* source of truth for conversation content — it never copies
them into Postgres — so when an **active-but-idle** conversation's JSONL ages out, its
transcript viewer goes permanently blank. A conversation's mtime only refreshes when it
takes a new turn, so a live conversation that sits idle for 30 days is silently lost.

The fix is to **touch the JSONL of every active conversation** (`status <> 'done'`, which
includes the resumable `gone` state) on a recurring schedule, resetting mtime so Claude
Code's age check never trips. This is selective (closed conversations still age out — no
disk bloat) and keeps `claude --resume` working, since resume reads the very same file.

That recurring need is **not unique**. Four existing consumers hand-roll recurrence today:

- `backup.run` and `notifications.ttl-cleanup` — self-reschedule via `enqueue(..., { runAt })`.
- `attachments/orphan-sweep` and `jobs/stuck-lock-sweeper` — raw `setInterval` (the exact
  thing `CLAUDE.md` forbids: "Never use `setInterval`/`setTimeout` loops").

`worker.ts` already anticipates this: it passes `parsedCronItems=[]` to graphile-worker's
`run()` with the comment *"a future plugin may contribute one on top."* So rather than add
a fifth hand-rolled timer, we build the **first-class recurring primitive** the codebase
has been missing, and migrate the existing consumers onto it.

## Approach

Add a declarative `schedule` field to `defineJob`, backed by **graphile-worker's native
cron** (verified present in installed v0.16.6). Consumers declare a crontab string; the
jobs plugin builds `ParsedCronItem[]` from the registry at worker startup and hands them to
`run()`. No `onReady` seeding, no self-`enqueue`, no `setInterval`.

### Why native cron (not lifted self-reschedule)

Validated against `node_modules/graphile-worker/dist/` (cron.js, crontab.js, interfaces.d.ts):

- **Fleet-wide dedup is built in.** Each tick is scheduled via an atomic
  `INSERT ... ON CONFLICT DO UPDATE WHERE last_execution < excluded.last_execution` on
  `_private_known_crontabs`, then `INNER JOIN`ed to `add_job` — so across N worktree
  runners sharing one DB, each tick fires **exactly once globally**. (This is also why no
  `onMain` guard is needed — backup's old guard only existed to stop N worktrees each
  self-seeding.)
- **Failure-independent.** A failed tick gets graphile's normal retry budget; the *next*
  tick is scheduled regardless. A self-reschedule-on-success chain dies permanently on a
  failing run.
- **No backfill flood.** Omitting `options.backfillPeriod` (≡ 0) fires zero catch-up jobs
  on boot; a brand-new identifier skips backfill unconditionally on first run.
- Standard 5-field `m h dom mon dow` crontab via `CronItem.match` (field is `match`, not
  the deprecated `pattern`).

### Intentionally NOT migrated: `stuck-lock-sweeper`

It stays a raw `setInterval`. It is the recovery mechanism *for* graphile (clears
orphaned `locked_at` rows); routing it *through* graphile would mean a wedged worker
couldn't recover itself. This boundary — "infra that recovers the job system must not
depend on the job system" — will be documented inline.

## API

```ts
// New field on DefineJobSpec
schedule?: { cron: string | (() => string | null) };
```

- `cron` as a **string**: a static 5-field crontab (`"0 4 * * *"`).
- `cron` as a **resolver function**: evaluated once at worker startup, may read config and
  return `null`/`""` to disable. This is how backup drives its schedule from a user setting.
- **Constraint:** a scheduled job's `input` schema must parse `{}` (all fields
  optional/defaulted). The cron payload is built from `spec.input.parse({})`; if that
  throws, fail loud at startup.

Example (the new consumer):

```ts
export const transcriptTouchJob = defineJob({
  name: "conversations.transcript-touch",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "0 4 * * *" },
  async run() {
    for (const c of await listActiveConversations()) {
      if (!c.claudeSessionId) continue;
      const path = await findTranscriptPath(c.claudeSessionId);
      if (!path) continue;
      const now = new Date();
      await utimes(path, now, now);
    }
  },
});
```

## Changes

### New lifecycle hook — `onAllReady` (server-core)

A schedule resolver may read another plugin's state (backup reads `config_v2`),
but the jobs primitive can't `dependsOn` a feature plugin, and `onReady` is only
dependency-scoped. So `ServerPluginDefinition` gains an **`onAllReady`** hook,
invoked by `bin/index.ts` after the full `onReady` barrier (new `Phase 3`). The
jobs worker starts in `onReady` with an empty-but-live `parsedCronItems` array
(graphile re-reads it each tick) and **populates it in `onAllReady`** via
`installScheduledCronItems()` — by which point every plugin's config is ready.
Files: `core/types.ts`, `core/profiler.ts` (`PhaseId`), `bin/index.ts`.

### Primitive — `plugins/infra/plugins/jobs/`

- **`server/internal/registry.ts`**
  - Add `ScheduleSpec = { cron: string | (() => string | null) }`; add `schedule?` to
    `DefineJobSpec` and `RegisteredJob`.
  - Add `getScheduledJobs(): RegisteredJob[]` (registry filter).
  - Make `JobTaskPayload.workflowRunId` optional (cron payloads omit it).
  - Export `ScheduleSpec` from the barrel (`server/index.ts`).
- **`server/internal/worker.ts`**
  - New `buildCronItems()`: for each scheduled job, resolve the cron string (call the
    resolver if it's a function; skip on `null`/empty), then
    `parseCronItem({ task: JOB_TASK, match, identifier: \`cron:${name}\`,
    payload: { jobName: name, input: spec.input.parse({}) },
    options: { backfillPeriod: 0, maxAttempts: spec.maxAttempts } })`.
    Identifiers are unique because job names are unique.
  - `startWorker()`: pass `buildCronItems()` as the 3rd arg to `run(...)` (replacing `[]`).
  - `dispatch()`: derive the per-tick run id when graphile injects `_cron` —
    `const workflowRunId = p.workflowRunId ?? \`${p.jobName}:${p._cron.ts}\`` — and read
    `input` from the payload as today.

### Consumer migrations

- **`plugins/notifications/`** — `ttl-cleanup.ts`: add `schedule: { cron: "0 * * * *" }`,
  delete the trailing self-`enqueue`. `server/index.ts`: drop the `onReady` seed.
- **`plugins/infra/plugins/attachments/`** — convert `orphan-sweep.ts` from
  `startOrphanSweep`/`setInterval` into `defineJob({ name: "attachments.orphan-sweep",
  dedup: "singleton", schedule: { cron: "5 * * * *" }, run: <existing sweep logic> })`.
  `server/index.ts`: add the job to `register`, drop `startOrphanSweep()` from `onReady`
  (keep `ensureAttachmentsRoot()`). First sweep now waits for the next tick (≤1h) instead
  of running immediately — acceptable for orphan GC.
- **`plugins/backup/`** —
  - `shared/config.ts`: replace `periodicIntervalHours: intField` with
    `periodicCron: textField({ default: "0 3 * * *", label: "Backup schedule (cron)",
    description: "5-field crontab; empty = disabled." })`.
  - `server/internal/backup-job.ts`: give `input.trigger` a `.default("periodic")` so
    `input.parse({})` → periodic; add
    `schedule: { cron: () => getConfig(backupConfig).periodicCron.trim() || null }`;
    delete the `if (input.trigger === "periodic")` self-reschedule block. The "backup now"
    button keeps enqueuing `{ trigger: "manual" }`.
  - `server/index.ts`: drop the `onReady` seed + `isMain()` guard.
  - **Caveat:** changing `periodicCron` takes effect on the next worker restart (cron items
    are built at startup). A `watchConfig`→rebuild could lift this later; out of scope now.

### New plugin — `plugins/conversations/plugins/transcript-retention/` (server-only)

- `server/internal/touch-job.ts` — the `transcriptTouchJob` above. Imports:
  `listActiveConversations` from `@plugins/tasks-core/server`, `findTranscriptPath` from
  `@plugins/conversations/plugins/transcript-watcher/server`, `utimes` from
  `node:fs/promises`.
- `server/index.ts` — `{ id: "transcript-retention", ..., register: [transcriptTouchJob] }`.
- `CLAUDE.md` — purpose + the "active = status<>'done'" rationale.
- Register the plugin in `plugins/framework/plugins/server-core/bin/plugins.ts`.

## Critical files

- `plugins/infra/plugins/jobs/server/internal/registry.ts` — `defineJob`, `RegisteredJob`,
  `JobTaskPayload`, dedup.
- `plugins/infra/plugins/jobs/server/internal/worker.ts` — `run(...)` call site with the
  `parsedCronItems=[]` to replace; `dispatch()`.
- `plugins/infra/plugins/jobs/server/index.ts` — barrel.
- `node_modules/graphile-worker/dist/{cron,crontab}.js`, `interfaces.d.ts` — `parseCronItem`
  / `CronItem` / `_cron` payload / `known_crontabs` reference (read-only).
- `plugins/tasks-core/server` — `listActiveConversations()` (returns `claudeSessionId`).
- `plugins/conversations/plugins/transcript-watcher/server` — `findTranscriptPath()`.
- `plugins/backup/shared/config.ts`, `plugins/backup/server/{internal/backup-job.ts,index.ts}`.
- `plugins/notifications/server/{internal/ttl-cleanup.ts,index.ts}`.
- `plugins/infra/plugins/attachments/server/{internal/orphan-sweep.ts,index.ts}`.
- `plugins/framework/plugins/server-core/bin/plugins.ts` — server plugin registry.

## Verification

1. `./equin build` — must succeed (migrations, codegen docs, boundary + eslint checks).
2. `./equin check` — boundary rules (new barrels), plugins-doc-in-sync.
3. **Cron registered** — via MCP `query_db`:
   `SELECT identifier, last_execution FROM graphile_worker._private_known_crontabs ORDER BY 1;`
   Expect `cron:conversations.transcript-touch`, `cron:notifications.ttl-cleanup`,
   `cron:attachments.orphan-sweep`, and `cron:backup.run` (only if `periodicCron` non-empty).
4. **Touch works end-to-end** — pick an active conversation's JSONL, `stat -f %m <path>`
   to record mtime; temporarily set the touch job's cron to `"* * * * *"`, `./equin
   build`, wait ~70s, `stat` again → mtime advanced. Revert to `"0 4 * * *"` + rebuild.
   (Confirm the path via `query_db` for an active `claude_session_id`, then `findTranscriptPath`'s
   glob `~/.claude/projects/*/<session>.jsonl`.)
5. **No regressions** — Debug → Queue pane lists the scheduled jobs; backup "Backup now"
   button still enqueues a manual run; notifications still auto-dismiss/clean up.
