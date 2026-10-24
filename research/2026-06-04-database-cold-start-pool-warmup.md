# DB cold-start latency: pool warmup + honest profiler metrics

## Context

Right after a backend restart, the runtime profiler shows individual queries
taking seconds instead of sub-100ms:

- `select id, pid from build_runs where finished_at is null` — **12947 ms** (1 occurrence)
- `select rank from tasks where folder_id is null order by rank desc limit $1` — **12930 ms** (max; avg 2712 ms over 5 runs)
- `select id, task_id from attempts where id = $1 limit $2` — **14137 ms** (max; this query ran 246× total, avg 60 ms — only the boot occurrence was slow)

The user asked: is this a connection-pool/pgbouncer cold-start artifact or an
underlying query/index problem, and does it delay first interaction after every
build/deploy?

### Diagnosis (settled)

**It is purely connection-pool / pgbouncer cold-start + a boot-time thundering
herd — not a query or index problem. And yes, it delays first interaction after
every build/deploy.**

Evidence:

1. **`EXPLAIN (ANALYZE, BUFFERS)` proves both flagged queries are trivial.**
   - `tasks` rank query: **0.34 ms** execution — Index Only Scan on
     `tasks_folder_rank_idx (folder_id, rank)`, top-N heapsort, `Heap Fetches: 0`.
   - `build_runs` query: **1.9 ms** execution — seq scan over 668 rows (table is
     tiny; an index on `finished_at` is unnecessary).
2. **The smoking gun.** In the same boot window (all completing at
   `atMs ≈ 19900`), a *trivial primary-key lookup*
   (`attempts where id = $1`) also took **14 s** — and that same query is sub-ms
   245 other times. A PK lookup cannot have a query/index problem, so the time
   is categorically *not* execution. All three slow spans started ~6 s into boot
   and unblocked together at ~20 s: classic cold-pool head-of-line blocking.
3. **The profiler timer wraps connection acquisition.** In
   `plugins/database/server/internal/client.ts`, the `pool.query` wrapper
   captures `t0 = performance.now()` *before* calling `origQuery`. node-postgres
   `Pool.query` acquires a connection (queue-wait + pgbouncer backend
   establishment) *before* executing, so the recorded `db` span =
   queue-wait + acquisition + execution. At boot that's dominated by the first
   two.

Why every build/deploy is affected: `./equin build` restarts the worktree
backend **process**. The node-postgres `Pool` (`max: 5`, no `min`, lazy connect)
is recreated empty each time. Meanwhile the boot fires a thundering herd — many
plugins' `onReady` hooks issue queries concurrently (the two flagged queries run
in `onReady`: `build_runs` orphan reconciliation in `plugins/build/server/index.ts:29`,
and `findNextRankInFolder(null)` from `ensureMetaTask` in
`plugins/tasks-core/server/internal/mutations/tasks.ts:292`), and the HTTP socket
is already serving so the frontend's first loaders pile on. The first wave
serializes through 5 cold connections while pgbouncer spins up fresh PG backends,
so the head queries absorb the full cold-start cost.

## Goals

1. **Eliminate the user-facing latency** — warm the connection pool at boot so
   the first real-query wave hits live connections.
2. **Make the profiler honest** — stop attributing connection-acquisition wait to
   query execution, so this can never again be mistaken for a slow query.

Non-goal: adding an index on `build_runs.finished_at` (table is tiny; would not
help — the cost was never execution).

## Fix 1 — Warm the pool at boot

node-postgres `min` does **not** eagerly pre-connect; it only avoids destroying
idle connections below the threshold. The pool still starts empty and connects
on demand. An explicit warm step is required.

### `plugins/database/server/internal/client.ts`

Add an exported `warmPool()` that saturates the pool up to `max` and validates
each connection (forcing pgbouncer to attach real PG backends now, not on the
first user query):

```ts
export async function warmPool(): Promise<void> {
  const target = pool.options.max ?? 5;
  const need = target - pool.idleCount; // awaitDbReady already left 1 idle
  if (need <= 0) return;
  const clients = await Promise.all(
    Array.from({ length: need }, () => pool.connect()),
  );
  await Promise.all(clients.map((c) => c.query("SELECT 1")));
  for (const c of clients) c.release();
}
```

Self-healing: `awaitDbReady()`'s `SELECT 1` probe leaves 1 connection idle, so
`warmPool` opens the remaining 4. If `max` is 1 (test env), it's a no-op.

### `plugins/database/server/index.ts`

Slot the warm step into `onReady`, between readiness and migrations, so the pool
is hot before the migration batch and before any other plugin's `onReady` runs
(the database plugin's `onReady` is guaranteed to complete first — all DB
consumers depend on it):

```ts
async onReady() {
  await awaitDbReady();
  await warmPool();        // saturate the pool before the onReady herd
  await runMigrations(db);
},
```

### `plugins/database/plugins/pgbouncer/scripts/start.ts` (optional, cheap)

Add `min_pool_size = 5` to the generated `[pgbouncer]` stanza. pgbouncer/PG are
gateway-owned and persist across backend restarts, so this is *not* load-bearing
for the restart case (the node-pg warmup already forces backend attachment).
It only helps the rarer gateway-cold-boot path. Include it as belt-and-suspenders;
it costs nothing.

## Fix 2 — Honest profiler (separate acquisition from execution)

Today the `db` span = acquire + execute. We want the `db` span to reflect
**execution only**, with acquisition recorded as a separate `[acquire]` span.

Drizzle is wired as `drizzle(pool)` and calls `pool.query()` internally for
non-transaction queries, so we keep that wiring and reimplement only the
**promise form** of the `pool.query` wrapper to time the two phases separately.
This is a faithful re-expression of what node-postgres `Pool.query` already does
internally (connect → query → release); the callback form is passed straight
through to `origQuery` untouched (drizzle never uses it).

### `plugins/database/server/internal/client.ts`

Replace the current `pool.query` wrapper with:

```ts
const origQuery = pool.query.bind(pool);
const origConnect = pool.connect.bind(pool);

pool.query = ((...a: Parameters<typeof origQuery>): any => {
  const last = a[a.length - 1];
  if (typeof last === "function") return origQuery(...a); // callback form, untimed

  const first = a[0] as string | { text?: string } | undefined;
  const text = typeof first === "string" ? first : (first?.text ?? "?");

  return (async () => {
    const acq0 = performance.now();
    const client = await origConnect();              // unwrapped: avoids double-record
    recordSpan("db", "[acquire]", performance.now() - acq0);
    try {
      const exec0 = performance.now();
      // biome-ignore lint/suspicious/noExplicitAny: proxy pg's overloaded query.
      const res = await (client.query as any)(...a);
      recordSpan("db", text, performance.now() - exec0); // execution only
      return res;
    } finally {
      client.release();
    }
  })();
}) as typeof pool.query;
```

After this change:
- `[acquire]` aggregate lights up at boot (~13 s) — unambiguously the cost.
- The SQL spans (`build_runs`, `tasks` rank, …) report true execution (~1 ms),
  even at boot.

Notes / risks:
- Use `origConnect` (not a wrapped `pool.connect`) inside the wrapper so we don't
  double-count; do **not** also wrap `pool.connect`.
- `await origConnect()` + `client.release()` in a `finally` replicates pg's own
  connect/release lifecycle, including release-on-error. This is the one spot
  touching the load-bearing query path — validate carefully (see below).
- Drizzle's transaction path calls `pool.connect` directly and is untimed today;
  this change leaves that unchanged.
- No changes to `runtime-profiler/core/recorder.ts` or any profiler consumer —
  `[acquire]` is just another label in the existing aggregation.

## Critical files

- `plugins/database/server/internal/client.ts` — `warmPool()`, rework `pool.query` wrapper.
- `plugins/database/server/index.ts` — call `warmPool()` in `onReady`.
- `plugins/database/plugins/pgbouncer/scripts/start.ts` — optional `min_pool_size = 5`.
- (reference only) `plugins/infra/plugins/runtime-profiler/core/recorder.ts`, `plugins/build/server/index.ts:29`, `plugins/tasks-core/server/internal/mutations/tasks.ts:292`.

## Verification

1. `./equin build` from the worktree (regenerates nothing here — code only —
   restarts the backend).
2. Immediately after restart, exercise first interaction: load
   `http://att-1780591131-b301.localhost:9000` and hit the tasks/build views.
3. `mcp__singularity__get_runtime_profile { kind: "db", limit: 20 }`:
   - **Expect:** the `build_runs`, `tasks` rank, and `attempts id=$1` SQL spans
     now report low single/double-digit ms even on their boot occurrence.
   - **Expect:** a new `[acquire]` aggregate that carries the boot spike
     (its `maxMs` is high once, then sub-ms) — confirming the wait moved out of
     the query spans and shrank overall thanks to warmup.
4. Sanity-check correctness of the reworked wrapper: confirm normal app flows
   (create a task, view build history, open a conversation) work and that
   `EXPLAIN`-level fast queries no longer show multi-second `db` spans.
5. Regression: confirm no errors in server logs around connection
   acquisition/release (the `finally`-release path), and that the pool doesn't
   leak connections (`pool.idleCount` settles at `max` after warmup).
