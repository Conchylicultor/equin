# The queue schema is a property of the database, not of whoever enqueues first

## Context

Four DB-backed tests in `plugins/tasks/plugins/tasks-core` fail with
`error: schema "graphile_worker" does not exist` (Postgres `3F000`):

- `union points > createTask under a folder inherits the folder's label`
- `union points > createTask with no folder starts as its own singleton (cluster_id NULL)`
- `withTaskStatusChange — the incident > detaching a blocker emits for the downstream task…`
- `runStatusBatchOn — batch-entry semantics > two writes touching one task record its status at BATCH ENTRY…`

The filed report said these run against the `db-test-fixture` throwaway
database and blamed a gap in the fixture. **They do not.** All four run against
the REAL worktree DB (`db` from `@plugins/database/server`) inside a
deliberately rolled-back transaction — the fixture is not on their path at all.
Only `clusters.test.ts`'s *other* describe block (`unionTaskClusters`) uses
`createTestDb`, and it passes.

### What is actually broken

`plugins/infra/plugins/jobs/server/index.ts` declares
`ExcludeSchemaFromFork({ schema: "graphile_worker", drop: "schema" })`, so a
freshly-forked worktree database is **born without the queue schema**. The only
thing that puts it back is graphile's own migration, which runs as a *side
effect* of `makeWorkerUtils` — reached from `getWorkerUtils()`
(`jobs/server/internal/worker.ts:83`), which in turn is reached from
`startWorkers()` in the plugin's `onReady`.

`enqueue()` (`jobs/server/internal/registry.ts`) has two transports for the same
row:

| | route | precondition |
|---|---|---|
| no `opts.tx` | `UNSAFE_insertJobRow` → `await getWorkerUtils()` → `utils.addJob` | **self-installs** the schema |
| with `opts.tx` | raw `SELECT graphile_worker.add_job(…)` on the caller's `PoolClient` | **assumes** the schema exists |

Every task status-change emit passes `{ tx }` (`status-scope.ts:86`,
`status-emit.ts:61`), so `createTask` always takes the second transport. In a
worktree whose backend has never booted — a fresh worktree where
`./equin test` runs before `./equin build` — that transport fails
with a bare `3F000` that names nothing in this repo. The first transport, in the
same situation, would have silently healed itself.

That asymmetry is the defect, and registry.ts's own comment above the two
branches claims the opposite ("Both branches below insert the SAME row through
two different transports, so both derive their graphile columns from one spec").
They agree on the *columns*; they disagree on the *precondition*.

The failure is also illegible: the reported task mis-diagnosed it as a fixture
gap, which is evidence enough that a bare `3F000` from `node_modules/pg` is not
a usable signal.

### Intended outcome

1. A backend's own database has the queue schema **before any plugin can
   enqueue**, rather than at whatever moment the first `getWorkerUtils()` lands.
2. A test process that drives the real worktree DB gets the same guarantee from
   one shared harness, so no suite can forget it — and the two duplicated
   rolled-back-transaction helpers collapse into that harness.
3. When the schema really is absent, the failure says so in a sentence and names
   the fix, instead of surfacing as `3F000` from inside `pg`.
4. The four tests go green and stay green in a never-booted worktree.

## Design

### Rejected: ensure-inside-enqueue

The obvious patch — `await installQueueSchema(connectionString())` at the top of
`enqueue()` — looks like it unifies the two preconditions but does not.
`connectionString()` names *this process's app database*; `opts.tx` may be a
transaction on any database. So it would install the schema in one database and
then write to another, while reading as though the invariant were established.
Worse, on a fresh database it would run 25 graphile migrations *inside somebody
else's open transaction*, holding their row locks `idle in transaction` for the
duration. Rejected: a rung-4 assert dressed up as a rung-1 fix.

The right split is: **installation is owned by whoever provisions/boots the
database; `enqueue` only asserts.**

### 1. `installQueueSchema(connectionString)` — one explicit installer

New `plugins/infra/plugins/jobs/server/internal/queue-schema.ts`:

```ts
export async function installQueueSchema(connectionString: string): Promise<void>
export class QueueSchemaMissingError extends Error
```

Implementation owns its own `new Pool({ connectionString, max: 1 })` and calls
graphile-worker's `runMigrations({ pgPool })`, then `await pool.end()` in a
`finally`. Owning the pool is deliberate: graphile's own `connectionString`
branch pushes a releaser that calls `pgPool.end()` **without returning it**, so
the close is floating — a database with a lingering connection cannot be
`ALTER DATABASE … RENAME`d, which matters for the follow-up in *Not doing now*.

No memoization. On an already-installed database it is one connect plus one
`SELECT`; callers own their own once-per-process gate where it matters, and a
`Map` keyed by connection string would grow once per worktree ever forked.

Exported from `plugins/infra/plugins/jobs/server/index.ts` (a named re-export of
an internal file — barrel purity holds).

### 2. Install at `onReadyBlocking`, not at first worker start

`jobs`' plugin definition gains
`onReadyBlocking: () => installQueueSchema(connectionString())`.

`onReadyBlocking` completes across *all* plugins before any `onReady` runs, so a
plugin that tx-enqueues from its own `onReady` on a brand-new database can no
longer beat `startWorkers()`. Cost is one round trip on an already-migrated DB.
The `ExcludeSchemaFromFork` comment's "Graphile re-migrates the schema
idempotently on first worker start" is updated to point at this installer, which
is now the thing that answers "who puts it back".

### 3. `enqueue`'s tx transport asserts, loudly (rung 4)

Wrap the `client.query` in the `opts.tx` branch. On a `3F000` naming the queue
schema, rethrow `QueueSchemaMissingError` — stating that the transaction is on a
database with no queue schema, that the schema is excluded from the worktree
fork by design, and that `installQueueSchema` is how to put it there (and
`./equin build` is what does so for a worktree).

The message must NOT be derived by querying `current_database()` after the
failure: `3F000` aborts the transaction, so every later statement on that client
raises `25P02` instead. The error carries only what is known without a query.

### 4. One harness for "the real worktree DB, rolled back"

New sub-plugin `plugins/database/plugins/db-test-fixture/plugins/worktree-db/`,
server-only, exporting:

```ts
export async function worktreeDbScenario<T>(body: (tx: DbExecutor) => Promise<T>): Promise<T>
```

It owns:

- the `Rollback` sentinel and the `db.transaction` wrap (today copy-pasted, and
  not identically, into `clusters.test.ts:302` and `status-closure.test.ts:90`);
- the documented constraint that currently lives in only one of the two copies
  (`clusters.test.ts:291-298`): no statement inside may raise a *Postgres* error,
  or the transaction aborts and every later read fails;
- a module-level once-per-process gate that runs
  `installQueueSchema(connectionString())` before the first scenario opens.

**Why a child plugin rather than `db-test-fixture` itself:** `db-test-fixture`
must stay jobs-free, because `infra/jobs`' own new test imports it — if the
fixture imported jobs, that edge would close an R6 cycle. Parent and child are
independent plugin ids with no umbrella exception, so `worktree-db → infra/jobs`
and `infra/jobs (test) → db-test-fixture` coexist acyclically.

### 5. The two suites use the harness

`plugins/tasks/plugins/tasks-core/server/internal/mutations/clusters.test.ts`
(`describe("union points")`) and `.../status-closure.test.ts` drop their local
`scenario()` / `Rollback` and call `worktreeDbScenario`. `clusters.test.ts`'s
`unionTaskClusters` describe is untouched — it correctly uses `createTestDb`.

### 6. Regression test for the installer

`plugins/infra/plugins/jobs/server/internal/queue-schema.test.ts`:
`createTestDb` (no app migrations needed — the queue schema is independent), a
locally `defineJob`'d factory that is never `register()`ed, then

- `t.db.transaction(tx => job.enqueue(input, { tx }))` → rejects with
  `QueueSchemaMissingError` (asserted **by instance**, never by message text);
- `installQueueSchema(t.connectionString)` → the same enqueue returns an id and
  the row is visible in `graphile_worker.jobs`.

This is also the coverage the original ticket was reaching for: it proves a
throwaway fixture database can be made enqueue-capable in one call.

**`jobs:no-raw-addjob` constraint:** that check greps `graphile_worker.add_job`
with `maskStrings: false`, so the token may not appear in any *string* outside
`registry.ts`. Hence the instance-based assertion, and reads against
`graphile_worker.jobs` rather than the function.

## Not doing now — follow-up

> **Superseded (2026-08-21).** This section proposed making `drop: "schema"` a
> discriminated union whose schema arm *requires* a `reinstall(connectionString)`
> callback, run by `forkDatabase` against the temp database before the atomic
> rename. It was deferred because `ForkExclusions` crosses HTTP for the
> `./equin db fork` path and a function cannot ride that wire.
>
> The answer turned out to be that nothing needs reinstalling. The declaration
> now states what to KEEP rather than what to drop: DDL is always kept, rows are
> always dropped, and `graphile_worker` keeps `migrations` — so a fork inherits a
> schema graphile already considers installed, and `drop: "schema"` has no
> spelling at all. `ForkExclusions` also stays pure data, so the wire problem
> that deferred this never has to be solved. See
> [`2026-08-21-database-fork-exclusions-are-a-keep-list-checked-against-the-catalog.md`](./2026-08-21-database-fork-exclusions-are-a-keep-list-checked-against-the-catalog.md).
>
> Item 2 above (installing at `onReadyBlocking`) stands, and is now what covers a
> database that never had the schema at all rather than what repairs every fork.

## Files

- `plugins/infra/plugins/jobs/server/internal/queue-schema.ts` (new)
- `plugins/infra/plugins/jobs/server/internal/queue-schema.test.ts` (new)
- `plugins/infra/plugins/jobs/server/index.ts` — export + `onReadyBlocking` + comment
- `plugins/infra/plugins/jobs/server/internal/registry.ts` — tx-transport assert
- `plugins/database/plugins/db-test-fixture/plugins/worktree-db/{package.json,server/index.ts,server/internal/scenario.ts}` (new)
- `plugins/tasks/plugins/tasks-core/server/internal/mutations/clusters.test.ts`
- `plugins/tasks/plugins/tasks-core/server/internal/status-closure.test.ts`

## Verification

1. `./equin check` — boundaries (no new cycle), `jobs:no-raw-addjob`,
   `plugins-registry-in-sync`, `plugins-doc-in-sync`, `type-check`.
2. `./equin test plugins/infra/plugins/jobs` — the new installer test:
   proves the missing-schema arm fails as `QueueSchemaMissingError` and the
   installed arm enqueues, both against a throwaway DB.
3. `./equin test plugins/tasks/plugins/tasks-core` — 97 tests, 0 fail
   (was 93 pass / 4 fail).
4. `./equin build` — deploys; confirms `onReadyBlocking` does not slow or
   break boot.
5. Never-booted-worktree behaviour is covered by (2) rather than by dropping the
   live schema out from under a running backend.
