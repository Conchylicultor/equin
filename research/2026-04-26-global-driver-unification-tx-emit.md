# Driver unification + transactional `emit()`

**Status:** plan, not implemented
**Scope:** server DB driver + events plugin emit boundary
**Predecessors:** `research/2026-04-23-plugins-events-graphile-worker-v2.md` (which dropped tx-aware emit)

## Context

The events plugin's v2 spec committed to `emit(payload, { tx })` so callers could announce a fact inside the same Postgres transaction that wrote it. That landed as `emit(payload)` only — no opts — because the server's Drizzle client runs on `postgres.js` while Graphile Worker runs on `pg` (node-postgres). The two driver libraries can't share a TCP connection, which is what shared-tx requires.

Today this is fine: `events-test` is the only producer and it doesn't use transactions. As soon as the first real producer emits from inside a `db.transaction(...)` (the spec mentions `tasks.completed` from `plugins/tasks-core/server/internal/mutations/`), an author who naïvely calls `emit()` mid-tx causes silent dual-write — the tx rolls back, the job already got committed to a separate connection, the handler runs for a fact that no longer exists. Today's only guard is documentation.

The clean fix is to unify the server on node-postgres (`pg.Pool`) so app DB writes and `graphile_worker.jobs` writes share a connection. Once unified, transactional emit is no longer about facade-piercing: we call the public SQL function `graphile_worker.add_job(...)` directly on the caller's tx client, which is Graphile's own documented pattern for transactional job emission.

The codebase is well-positioned for this swap:
- All app code goes through Drizzle's SQL-builder API; no relational query API, no postgres.js-specific tagged-template patterns at call sites.
- Only **three** files actually touch the postgres.js native API (`sql.begin`, `sql.unsafe`, parameter-interpolating tagged templates): `server/src/db/migrate.ts`, `plugins/conversations/server/internal/db-fork.ts`, and `server/backfill-pushes.ts`.
- Graphile Worker already runs on node-postgres internally — we're not replacing the queue, just aligning the app pool with it.

Outbox pattern was considered and rejected: with one Postgres DB and a clean swap path, `graphile_worker.jobs` already *is* the outbox if you can write to it transactionally.

## Approach

### Driver swap

`server/src/db/client.ts` becomes a `pg.Pool`-backed client. Drizzle's API surface is identical (`db.select().from(...)`, `db.transaction(...)`, `db.execute(sql\`…\`)`), so 45+ plugin call sites need zero changes.

### `emit(payload, { tx })` API

Re-add the opts arg. When `tx` is provided, the dispatcher does **two** things on the caller's transaction:

1. The trigger-row `SELECT` runs on `tx` (so it sees uncommitted writes from the same tx).
2. The `graphile_worker.jobs` INSERT runs on the same `pg.Client` as the tx, via `tx._.session.client.query("SELECT graphile_worker.add_job(...)", [...])`.

When `tx` is absent, behavior is unchanged: dispatch runs on `db` and enqueues via the existing `eventsDispatchJob.enqueue` path (which goes through Graphile's `WorkerUtils.addJob`, fresh connection from Graphile's pool — fine for post-commit emit).

This is **Approach A** from the design exploration. Approach B (a `runInTx(async (tx, client) => ...)` helper that owns BEGIN/COMMIT manually) was rejected because:
- It abandons Drizzle's `db.transaction(...)` (savepoints, rollback semantics, retry-on-serialization-failure) for a hand-rolled equivalent.
- It forces every caller that emits inside a tx to switch wrapper functions, instead of just adding `, { tx }` to the emit call.
- It buys nothing: the only reason to manually own the client would be to inject it into Graphile's `WorkerUtils`, which we don't need — calling `graphile_worker.add_job` SQL directly is simpler.

The one acknowledged risk in Approach A is reaching into `tx._.session.client` (private in d.ts, public-field at runtime). We isolate that one access in the events dispatcher — if Drizzle ever renames it, there's exactly one line to fix.

### Why the SQL function and not `makeAddJob`

Graphile exports `makeAddJob(compiledOptions, makeWithPgClientFromClient(client))` for building a per-tx `addJob`. That works but requires reaching into `WorkerUtils._compiledSharedOptions` (also internal). The SQL function `graphile_worker.add_job(...)` is **publicly documented** as the transactional emit interface and accepts the full `TaskSpec` shape positionally:

```sql
SELECT graphile_worker.add_job(
  identifier   := $1,
  payload      := $2::json,
  queue_name   := $3,
  run_at       := $4,
  max_attempts := $5,
  job_key      := $6,
  priority     := $7,
  flags        := $8,
  job_key_mode := $9
);
```

We already use this function transitively through `addJob` — calling it directly is the same write, just on our chosen client.

## Step-by-step plan

### Phase 1 — Driver swap

**`server/src/db/client.ts`** (rewrite):

- Replace `import postgres from "postgres"` with `import { Pool, type PoolClient } from "pg"`.
- Replace `import { drizzle } from "drizzle-orm/postgres-js"` with `import { drizzle } from "drizzle-orm/node-postgres"`.
- Replace `sql` (postgres.js client) with `pool` (`new Pool({ connectionString, max: 5, idleTimeoutMillis: 20_000 })`).
- Replace `adminSql` with `adminPool` (same shape, against the `postgres` admin DB, `max: 1`).
- Replace `openShortLivedSql(dbName)` with `openShortLivedClient(dbName)`. Returns a `pg.Pool` with `max: 1` (caller still calls `.end()`).
- Keep `connectionString` export unchanged (still passed to Graphile's `makeWorkerUtils`).
- `db = drizzle(pool)` — shape preserved.

**`server/src/db/migrate.ts`** (rewrite the tx loop):

The current code uses postgres.js's `sql.begin(async tx => { tx.unsafe(...); tx\`INSERT ...\` })`. Replace with Drizzle's `db.transaction`:

```ts
import { sql as drizzleSql } from "drizzle-orm";
import { db, pool } from "./client";

// Bootstrap migrations table (no tx needed)
await db.execute(drizzleSql`
  CREATE TABLE IF NOT EXISTS __singularity_migrations (
    hash text PRIMARY KEY,
    file text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`);

const applied = await db.execute<{ hash: string }>(
  drizzleSql`SELECT hash FROM __singularity_migrations`,
);
const appliedHashes = new Set(applied.rows.map((r) => r.hash));

// ... drift check unchanged ...

for (const m of migrations) {
  if (appliedHashes.has(m.hash)) continue;
  console.log(`[migrate] applying ${m.file}`);
  // Migration SQL is multi-statement raw text — db.execute(sql.raw(...)) handles it.
  // The drizzle-kit-generated DDL is already idempotent (CREATE TABLE IF NOT EXISTS,
  // DO $$ ... EXCEPTION WHEN duplicate_object). So even without a tx wrapping the
  // raw-text + bookkeeping insert, partial-application means re-running the file
  // is safe. But we still want all-or-nothing: if the bookkeeping insert fails we
  // don't want a half-applied state recorded. Keep the tx.
  await db.transaction(async (tx) => {
    await tx.execute(drizzleSql.raw(m.sqlText));
    await tx.execute(
      drizzleSql`INSERT INTO __singularity_migrations (hash, file) VALUES (${m.hash}, ${m.file})`,
    );
  });
}
```

Notes:
- `drizzleSql.raw(text)` is the equivalent of `postgres.js`'s `sql.unsafe(text)`. It runs the raw string (multi-statement supported by node-postgres' simple-query protocol).
- `db.execute<R>(sql)` returns `{ rows: R[] }` (node-postgres shape) — different from postgres.js where the `Sql` is awaited directly. The codebase doesn't use this return shape today, so `migrate.ts` is the only adjust point.

**`plugins/conversations/server/internal/db-fork.ts`** (rewrite):

```ts
import { adminPool, openShortLivedClient } from "@server/db/client";

// ... assertSafeName unchanged ...

export async function forkDatabase(name: string, source = "singularity"): Promise<void> {
  assertSafeName(name);
  assertSafeName(source);
  await adminPool.query(`CREATE DATABASE "${name}"`);
  // ... pg_dump | pg_restore unchanged ...
  if (dumpExit !== 0 || restoreExit !== 0) {
    const err = await new Response(restore.stderr).text();
    await adminPool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    throw new Error(`forkDatabase(${name}) failed: ${err}`);
  }
  const shortPool = openShortLivedClient(name);
  try {
    await shortPool.query(`DROP SCHEMA IF EXISTS graphile_worker CASCADE`);
  } finally {
    await shortPool.end();
  }
}

export async function dropDatabase(name: string): Promise<void> {
  assertSafeName(name);
  await adminPool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

export async function databaseExists(name: string): Promise<boolean> {
  assertSafeName(name);
  const result = await adminPool.query<{ "?column?": number }>(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [name],
  );
  return result.rows.length > 0;
}
```

Note: `assertSafeName` already gates the database-name interpolation, so `query(\`CREATE DATABASE "${name}"\`)` is safe. We keep the assertion as the authoritative guard.

**`server/backfill-pushes.ts`** (driver imports + `.end()`):

- Swap `import postgres from "postgres"` → `import { Pool } from "pg"`.
- `postgres(connectionString)` → `new Pool({ connectionString })`.
- `sql.end()` → `pool.end()`.
- All Drizzle-builder query code is unchanged.

**`plugins/jobs/server/internal/worker.ts`** — no change. `makeWorkerUtils({ connectionString })` and `run({ connectionString })` already speak node-postgres internally.

**`plugins/debug/plugins/db-backup/server/internal/handle-backup.ts`** — has `import { adminSql }`. Rename usages to `adminPool` and rewrite any postgres.js calls to `pool.query(...)`. Confirm specifics during implementation.

**`drizzle.config.ts`** — no change. Drizzle Kit only uses `dialect: "postgresql"` + the schema glob; runtime driver is irrelevant to schema generation.

### Phase 2 — `emit(payload, { tx })`

**`plugins/events/server/internal/event.ts`** — extend the public type and thread `tx` through dispatch:

```ts
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";

type Tx = NodePgTransaction<Record<string, never>, Record<string, never>>;

export type EventHandle<T, F extends Record<string, unknown>> = EventSource<T> & {
  readonly name: string;
  emit(payload: T, opts?: { tx?: Tx }): Promise<void>;
  where(...): EventSource<T>;
};

// ... in defineTriggerEvent:
emit: async (payload: T, opts?: { tx?: Tx }) => {
  await dispatch(def, payload, opts?.tx);
},
```

`dispatch()` becomes `dispatch(def, payload, tx?)`. The two writes that need to participate in the caller's tx:

1. **Trigger-row SELECT.** Use `(tx ?? db).select().from(...)`.
2. **`_event_emissions` audit insert.** Use `(tx ?? db).insert(_event_emissions)...`.

3. **Job INSERT into `graphile_worker.jobs`.** Two paths:

   - **No `tx`** (current behavior): keep `eventsDispatchJob.enqueue(...)`. Goes through `getWorkerUtils()` → `addJob` → fresh connection from Graphile's pool.

   - **With `tx`**: extract the `pg.PoolClient` from the Drizzle tx and call the SQL function directly:

     ```ts
     async function enqueueOnTx(
       client: PoolClient,
       payload: JobTaskPayload,
       maxAttempts: number,
     ): Promise<void> {
       await client.query(
         `SELECT graphile_worker.add_job($1::text, $2::json, NULL, NULL, $3::int)`,
         [JOB_TASK, JSON.stringify(payload), maxAttempts],
       );
     }

     // in dispatch():
     if (tx) {
       // biome-ignore lint/suspicious/noExplicitAny: drizzle exposes session.client at runtime
       //   despite the d.ts marking it private; isolated here so a future drizzle bump
       //   has exactly one line to fix.
       const client = (tx as any)._.session.client as PoolClient;
       await Promise.all(rows.map((row) => enqueueOnTx(client, makePayload(row), maxAttempts(row))));
     } else {
       await Promise.all(rows.map((row) => eventsDispatchJob.enqueue(makePayload(row), { maxAttempts: maxAttempts(row) })));
     }
     ```

The single-line `(tx as any)._.session.client` is the only facade-piercing in the system. It's encapsulated inside the events plugin; callers never see it.

**Type for the public API.** `Tx` is exposed through `plugins/events/server/index.ts` as a re-export so subscribers don't have to import from drizzle-orm directly, e.g.:

```ts
// plugins/events/server/index.ts
export type { EventTx } from "./internal/event";
```

where `EventTx` is the same type alias.

### Phase 3 — First-party adoption

**`plugins/tasks-core/server/internal/mutations/cross-table.ts:35`** — `adoptOrphanConversation()` already wraps three inserts in `db.transaction(...)`. If/when this function emits an event (the design doc mentions `conversationAdopted`), the call becomes:

```ts
await db.transaction(async (tx) => {
  await findNextRankUnder(CONVERSATIONS_META_TASK_ID, tx);
  await tx.insert(_tasks).values({...});
  await tx.insert(_attempts).values({...});
  await tx.insert(_conversations).values({...}).onConflictDoNothing().returning();
  await conversationAdopted.emit({ conversationId }, { tx });   // ← new
});
```

**`plugins/tasks-core/server/internal/mutations/pushes.ts`** and **`.../tasks.ts`** are the spec-named first producers for `tasks.completed`. They will land alongside the events adoption work (out of scope for this plan, but noted as the immediate beneficiary).

### Phase 4 — Documentation

**`docs/events.md`**, "Transactional boundary on `emit()`" section (lines 109-127). Replace with:

```markdown
### Transactional boundary on `emit()`

The events plugin's job INSERT shares a Postgres connection with the caller's
transaction when you pass `{ tx }`. **If you emit inside a transaction, pass
`tx`.** The trigger-row SELECT, the `_event_emissions` audit, and the
`graphile_worker.jobs` INSERT all run on the same client — rollback drops
all three atomically.

```ts
// ✅ atomic with the write
await db.transaction(async (tx) => {
  await markTaskComplete(tx, taskId);
  await taskCompleted.emit({ taskId }, { tx });
});

// ✅ also fine — emit after the tx commits
await db.transaction(async (tx) => {
  await markTaskComplete(tx, taskId);
});
await taskCompleted.emit({ taskId });

// ❌ silent dual-write — emit went out on a different connection
await db.transaction(async (tx) => {
  await markTaskComplete(tx, taskId);
  await taskCompleted.emit({ taskId }); // missing `, { tx }`
});
```

Mechanically, with `tx` provided, dispatch calls
`graphile_worker.add_job(...)` (Graphile's documented public SQL function) on
the tx's `pg.Client`. Without `tx`, dispatch goes through Graphile's
`WorkerUtils.addJob` which uses its own pool — equivalent for post-commit emit.
```

Also delete the trailing "Shared-tx emit requires unifying the server on `pg.Pool`; tracked as future work." sentence (now done).

## Critical files

- `server/src/db/client.ts` — driver swap
- `server/src/db/migrate.ts` — `sql.begin` / `sql.unsafe` rewrite
- `plugins/conversations/server/internal/db-fork.ts` — `adminSql.unsafe` rewrite
- `server/backfill-pushes.ts` — driver imports
- `plugins/debug/plugins/db-backup/server/internal/handle-backup.ts` — verify `adminSql` usage
- `plugins/events/server/internal/event.ts` — `emit({ tx })` API
- `plugins/events/server/index.ts` — re-export tx type
- `docs/events.md` — flip the boundary rule

## Risk audit: postgres.js → pg behavioral differences

| Concern | postgres.js behavior | pg behavior | Impact |
|---|---|---|---|
| Tagged templates with `${param}` | Auto-parameterized as `$N` | Plain string interpolation (DANGEROUS) | High — but only `db-fork.ts` and `migrate.ts` use raw tagged templates with the postgres.js export, both rewritten in Phase 1. App code uses Drizzle's `sql\`…\`` (from `drizzle-orm`), which is driver-agnostic. |
| `sql.unsafe(rawText)` | Multi-statement raw query | `client.query(rawText)` works the same; `drizzleSql.raw(text)` for execute() | Low — both call sites rewritten in Phase 1. |
| `sql.begin(fn)` native tx | Owns BEGIN/COMMIT/ROLLBACK | Use `db.transaction(fn)` (Drizzle's wrapper) | Migrate.ts only. Drizzle's transaction provides the same semantics plus savepoint support. |
| Result shape | `await sql\`SELECT ...\`` returns `Row[]` directly (array-like) | `pool.query(...)` returns `{ rows: Row[], rowCount, ... }`; `db.execute(sql)` returns `{ rows }` | Migrate.ts is the only place that consumed `await sql\`…\`` directly. Adapt to `result.rows`. |
| Error class names | `postgres.PostgresError` | `pg.DatabaseError` (subclass of Error with `.code`, `.detail`, etc.) | Audit any `instanceof PostgresError` checks. Grep finds none in the repo (confirmed during exploration). Drizzle wraps errors in its own `DrizzleError` for some paths regardless. |
| Connection pool defaults | `max: 10`, `idle_timeout: 0s` | `max: 10`, `idleTimeoutMillis: 10_000` | Set `max: 5, idleTimeoutMillis: 20_000` explicitly to match current postgres.js config. |
| LISTEN/NOTIFY | `sql.listen(channel, cb)` API | `client.query("LISTEN ch")` + `client.on("notification", cb)` | Not used in the app today (greppable). Graphile uses LISTEN internally on its own pool. |
| Type coercion | `bigint` → `string` (default), some int → `number` | `bigint` → `string` (default), `int8` → `string`, `numeric` → `string` | Drizzle column types coerce on the way out, so call sites get the same JS types. Plain `db.execute(sql)` raw-text queries return raw `pg` shapes — only `migrate.ts` does this and it casts explicitly. |
| Prepared statements | Auto-prepared by default | Auto-prepared when `name` set (Drizzle handles this) | No-op for Drizzle code paths. |
| `sql.json(...)` / `sql.array(...)` helpers | postgres.js-specific | Not used in repo | None. |

**Net risk: low.** The behavioral differences cluster in three files, all already rewritten in Phase 1. The 45+ Drizzle call sites in plugins are unaffected because Drizzle abstracts the dialect.

## Verification

End-to-end smoke test plan:

1. **Build cleanly.** `./equin build` — confirms migration runner still works against the new pool, all plugins compile against the new client export shape.

2. **Worktree fork still works.** Create a fresh worktree (which exercises `db-fork.ts`); confirm the new DB has the migrations table populated and Graphile's schema dropped+remigrated.

3. **events-test sanity.** Hit the existing `POST /api/events-test/emit` and `POST /api/events-test/subscribe` endpoints; confirm matching/dispatch unchanged. This is the existing canary for the emit boundary.

4. **Transactional emit canary.** Add a test endpoint to events-test that does:
   ```ts
   await db.transaction(async (tx) => {
     await tx.insert(_pings).values({...});
     await pinged.emit({ ... }, { tx });
     if (shouldRollback) throw new Error("rollback");
   });
   ```
   Verify two cases:
   - Commit path: `_pings` row exists AND a job lands in `graphile_worker.jobs`.
   - Rollback path: neither the row nor the job exist (the job INSERT was on the same client, rolled back together).

5. **Existing producer regression.** `pushLanded.emit()` (currently outside any tx) should keep working through the `tx`-less code path.

6. **Type check.** `bun run --bun tsc --noEmit` (or whatever the repo's typecheck is) — catches any leftover `postgres.Sql` typings.

7. **Manual screenshot of the app.** Run a worktree and click through Tasks/Conversations to confirm no runtime errors from the driver swap.

## Out of scope

- Outbox pattern. Considered, rejected as overkill — see Context.
- Migrating `events-test`'s existing emit call to use `{ tx }`. The test already proves the no-tx path; the new canary endpoint (Verification step 4) covers the tx path.
- Implementing `tasks.completed`. That belongs to the events-adoption work; this plan only enables it.
- Replacing `eventsDispatchJob.enqueue` with the SQL-function path globally. Keep the existing path for the no-tx case — it's the right shape (one round-trip via `WorkerUtils.addJob`, retries, etc.) and is unaffected by this work.
