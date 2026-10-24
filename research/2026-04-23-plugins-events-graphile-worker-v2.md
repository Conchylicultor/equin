# Events + Graphile Worker — v2

Supersedes [`2026-04-23-plugins-events-graphile-worker.md`](./2026-04-23-plugins-events-graphile-worker.md). Read v1 for the unchanged material (context, goal, overall dispatch flow, unchanged public API, caller-visible `emit()` semantics, idempotency contract, unchanged trigger tables, failure surfacing, verification). This doc is the diff: four substantive revisions driven by review feedback, plus one rejected item with rationale.

## Summary of changes from v1

| Area                             | v1                                      | v2                                                  |
| -------------------------------- | --------------------------------------- | --------------------------------------------------- |
| Transactional boundary on `emit` | Not addressed                           | **Tx-aware `emit(payload, { tx? })`** — mandated    |
| Graphile task registration       | One task per action (`taskList[name]`)  | **One shared task `events.dispatch`**               |
| Bun compat                       | Step 9 of migration                     | **Step 0: spike before anything else**              |
| Fork cleanup                     | `TRUNCATE graphile_worker.jobs`         | **`DROP SCHEMA graphile_worker CASCADE`**           |
| `onReady` hook                   | Assumed to exist                        | Confirmed (`server/src/types.ts:43`) — v1 stands    |

---

## 1. Transactional boundary on `emit()`

### Erratum (discovered during execution)

The "tx-aware `emit(payload, { tx })`" plan below is **not achievable within this migration's scope.** Graphile Worker requires `pg` (node-postgres). The existing server uses `postgres.js`. They're separate TCP drivers — sharing a Postgres transaction requires sharing the underlying connection, which these two libraries don't support across drivers. Graphile's `addJob({ pgClient })` is useful only if the caller's tx is *on Graphile's own pool*.

**Revised decision:** `emit(payload)` — no `opts`. Emits are **post-commit only**, enforced by convention and documented as a hard rule. The dual-write risk is real but manageable: callers emit after their write's tx commits. This matches the pre-Graphile behavior in practice (no v1 caller today emits inside a tx).

**Follow-up (out of scope):** unify the server on `drizzle-orm/node-postgres` + `pg.Pool`. Once unified, add tx-aware emit as a one-line change. Worth its own design doc when someone needs the atomic guarantee.

The rest of §1 below is preserved for historical reference but no longer represents the intended API.

---

### Problem

Today `emit()` reads the trigger table and calls `action.run()` inline. Handlers may touch any DB they want, but `emit()` itself does not share a transaction with the caller. In practice, callers in equin today don't wrap emit+write in a tx either — mostly because there's only one production user (events-test).

After Graphile: `emit()` writes to `graphile_worker.jobs` (via Graphile's own `pg.Pool`). If the caller is mid-transaction and rolls back, the job inserts stay committed — classic dual-write, and now far more visible because it's the primary failure mode.

### Decision: tx-aware `emit`

Extend `EventHandle.emit` to accept an optional client:

```ts
// plugins/events/server/internal/event.ts
type EmitOptions = { tx?: PgTxLike };
emit(payload: T, opts?: EmitOptions): Promise<void>;
```

Under the hood, the SELECT and every `addJob` call must use `opts.tx ?? db`. Graphile's `addJob` already supports `{ pgClient: tx }` — we forward it.

**Rule for callers** (new section in `docs/events.md`):

> If `emit()` is called inside a transaction, pass the transaction client: `await taskCompleted.emit(payload, { tx })`. Without it, jobs commit even if your transaction rolls back.
>
> If you're calling `emit()` outside a transaction, pass no options — but only emit after any preceding write has committed. The rule of thumb: **emit is a commitment.** Don't call it until the fact you're announcing is durable.

The `PgTxLike` shape is a minimal structural type satisfied by both a Drizzle transaction and a raw `pg.PoolClient` (both expose `query`). Keeps callers from having to reach for Graphile types.

### Why not "emit is always post-commit, period"

Considered and rejected. The "same tx" pattern is strictly more flexible (you can always emit post-commit by not passing `tx`), and it matches how every sane job queue is used in Postgres-backed systems. Forbidding it would push callers toward hand-rolled post-commit hooks, which is worse than the problem.

### Affected call sites

Once the first production events land (per `docs/events.md:152`):

- `plugins/tasks/server/internal/mutations/pushes.ts` (taskCompleted emit)
- `plugins/tasks/server/internal/mutations/tasks.ts` (taskCompleted emit on drop)
- `plugins/conversations/server/internal/poller.ts` (conversationCompleted emit — outside tx, fine)

Each mutation already runs in a Drizzle transaction; the guidance is to plumb the `tx` object through to `emit`.

---

## 2. Shared `events.dispatch` task

### Problem

v1 registered one Graphile task per action, built from `actionRegistry` at worker startup. Graphile's `taskList` is effectively frozen after `run()` returns — adding or removing actions later requires stopping and restarting the runner. Not a problem today (every plugin change = server restart anyway), but the project's trajectory is toward dynamic plugin composition ("agents composing apps from building blocks"). Pinning actions to worker-startup is a forward-compat trap.

### Decision: single task, action name in payload

```ts
// plugins/events/server/internal/worker.ts
await run({
  connectionString,
  taskList: {
    "events.dispatch": async (payload, ctx) => {
      const { actionName, actionConfig, eventPayload, triggerId, eventName, oneShot } = payload;
      const action = actionRegistry.get(actionName);
      if (!action) throw new NonRetryableError(`unknown action: ${actionName}`);
      const parsed = action.schema.safeParse(actionConfig);
      if (!parsed.success) throw new NonRetryableError(`config drift: ${...}`);
      await action.run(parsed.data, { payload: eventPayload, triggerId, table: triggerTableRegistry.get(eventName)! });
      if (oneShot) await deleteTriggerRow(eventName, triggerId);
    },
  },
  concurrency: 4,
});
```

The in-memory `actionRegistry` is already the source of truth at invoke time. Adding a plugin at runtime (future) = new entry in the registry; the worker picks it up on the next job without a restart.

### Observability cost and mitigation

`graphile_worker.jobs.task_identifier` is always `"events.dispatch"`, so you can't filter by action name at the task-identifier level. Compensation:

- Index on `((payload->>'actionName'))` in `graphile_worker.jobs` — a plain functional B-tree, cheap.
- A view `events_jobs_v` that selects `payload->>'actionName' AS action_name, payload->>'eventName' AS event_name, *` for operator queries.
- The follow-up Debug sidebar "Jobs" pane reads the view.

These are additive; none require a restart or a Graphile change.

---

## 3. Bun compat — spike first

### Problem

The whole plan assumes `graphile-worker` runs under Bun. If it doesn't, or if `pg`'s `LISTEN/NOTIFY` path is broken under Bun's Node compat, the dispatch latency story changes (sub-second → ~1s polling), which affects the calculus for latency-sensitive use cases like push-and-exit. Deferring this to step 9 of the migration means discovering a blocking issue after significant implementation.

### Decision: compat spike as step 0

Before any other migration work:

1. New scratch file (throwaway, not committed): `scratch/graphile-bun-spike.ts`.
2. Start a `run()` worker with a single `"spike.echo"` task that appends to a file.
3. From a separate process, `addJob("spike.echo", { n: 1 })`.
4. Measure dispatch latency (time between addJob and task invocation).
5. Kill the worker mid-job (`kill -9`), restart, verify the job re-runs.
6. If latency >> 100ms, inspect: is `LISTEN/NOTIFY` firing, or is Graphile polling?

**Decision gates:**

- Spike **passes** (sub-second dispatch, crash-safe): proceed with migration as planned.
- Spike **passes, polling only** (~1s latency, crash-safe): proceed, but flag to user before committing to any latency-sensitive action (e.g. push-and-exit currently has no SLA, so probably fine).
- Spike **fails** (runner crashes, jobs lost, or fundamental `pg` incompatibility): stop. Options become: (a) run worker in a separate Node.js process talking to the same Postgres, (b) pick a different queue (pg-boss, bullmq-postgres, or hand-roll), or (c) drop Graphile. Reshape the plan based on findings.

Time-box: 1 hour. Report back to the user with result + recommendation before writing migration code.

---

## 4. Fork cleanup — `DROP SCHEMA CASCADE`

### Problem

v1 said `TRUNCATE graphile_worker.jobs` after `pg_restore` in `db-fork.ts`. Graphile has more than just `jobs`:

- `graphile_worker.jobs`
- `graphile_worker.job_queues`
- `graphile_worker._private_jobs` (internal)
- `graphile_worker.migrations`
- `graphile_worker.known_crontabs` — **the footgun:** stores `last_execution` timestamps per cron entry, so a forked worktree would silently skip every cron that the parent recently ran
- `graphile_worker.known_crontab_timestamps`

Truncating only `jobs` leaves the rest inheriting parent state.

### Decision

Replace the TRUNCATE with:

```sql
DROP SCHEMA IF EXISTS graphile_worker CASCADE;
```

Run this in `db-fork.ts` right after the existing `DROP SCHEMA IF EXISTS drizzle CASCADE`. Graphile re-migrates on next worker startup (idempotent, ~100ms). Clean slate, no stale crontab state, no partial-truncate footguns.

Cost: we lose the parent worktree's job history, but (a) that history is about work for the *parent* worktree, not the fork, and (b) inheriting it would be actively wrong.

---

## 5. `onReady` — not changing v1

Reviewer flagged this as an assumption. It's not — the hook exists:

- Defined in `server/src/types.ts:43` with a comment explicitly stating "Called once after `runMigrations()` completes. Use this for background work (pollers, watchers) that issues DB queries."
- Invoked in `server/src/index.ts:13-19`.
- `plugins/conversations/server/internal/poller.ts:144-149` exports `startPoller()` which the conversations plugin's `onReady` calls.

`server/CLAUDE.md:47` says "no lifecycle hooks" — this is **stale documentation**, predating the addition of `onReady`. Worth a drive-by fix when we touch the area (one-line correction to CLAUDE.md).

v1's plan to start the worker from `events.onReady` is correct.

---

## Revised critical-files list (diff from v1)

Additions:

- `scratch/graphile-bun-spike.ts` — throwaway, for the pre-migration spike.

Changes:

- `plugins/events/server/internal/event.ts` — v2 additionally: `emit` signature gains `opts?: { tx?: PgTxLike }`; both the SELECT and the enqueue loop use `opts.tx ?? db`.
- `plugins/events/server/internal/worker.ts` — v2: single `"events.dispatch"` task instead of per-action tasks.
- `plugins/conversations/server/internal/db-fork.ts` — v2: `DROP SCHEMA graphile_worker CASCADE` instead of `TRUNCATE`.
- `docs/events.md` — v2 additionally: new "Transactional boundary" subsection under "Emit-site discipline."
- `server/CLAUDE.md` — v2 additionally: fix the stale "no lifecycle hooks" line (note that `onReady` is a lifecycle hook and is how background work starts).

Everything else in v1's migration steps stands.

---

## Revised migration ordering

0. **Bun compat spike** (new step 0 — see §3). Decision gate before proceeding.
1. Add `graphile-worker` dep.
2–8. Per v1 §"Migration steps", with the three surgical swaps from §§1, 2, 4 above.

---

## Open questions (revised)

Closed since v1:

- ~~Retry defaults~~ — `maxAttempts: 5`. Confirmed.
- ~~Observability in v1 cut?~~ — Follow-up. Confirmed.
- ~~Bun + LISTEN/NOTIFY~~ — Spike step 0 answers this before implementation.

Still open:

- **`PgTxLike` shape.** Minimal structural type vs importing Drizzle's transaction type. Lean toward structural (keeps events plugin independent of Drizzle internals). Confirm during implementation.
- **Post-commit emit helper.** Should we offer a `emitAfterCommit(payload)` helper that schedules emit via a tx hook, for callers who don't want to plumb `tx` through? Probably yes as a v2 nicety; not blocking.
- **Per-action retry override.** `defineAction({ maxAttempts, backoff })`. Not blocking; revisit when a real action needs it.
