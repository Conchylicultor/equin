# Live-State Invariant Harness — DB-Backed Half (Track 3a follow-up)

> Status: design (plan phase). Follow-up to
> [`2026-07-03-global-live-state-server-invariant-harness.md`](./2026-07-03-global-live-state-server-invariant-harness.md)
> (Track 3a), which explicitly filed this as "the out-of-seam half of catch-up."

## Context

Track 3a pinned the **cascade + hook-contract** half of live-state correctness
through the `createResourceRuntime` fake-injection seam — DB-free, socket-free
`bun:test` suites. It deliberately left the **DB-dependent half** untested,
because those modules import the `db` singleton directly and issue raw SQL, so
they had no injection seam:

1. **`live-state-snapshot/server/internal/catch-up.ts`** — the
   xmin-vs-changelog-floor **arithmetic** (`BigInt(oldestRetained) > floor`), the
   missing-history **backstop** (`fullRecomputeChangedTables`), and the
   `xid >= position` replay predicate + `ORDER BY seq` in `runCatchUp`. The
   "under-replay-impossible / over-replay-harmless" invariant lives here.
2. **`live-state-snapshot/server/internal/persist.ts`** — `captureWatermark`
   (xid8 monotonicity), `persistSnapshot`'s `ON CONFLICT` upsert + `text[]`
   `tables_read` round-trip, `readPersistedReadSets`/`readPersistedSnapshots`
   filtering, `clearPersistedSnapshots` scoping.
3. **`change-feed/server/internal/listener.ts`** — LISTEN establishment,
   NOTIFY→`routeChange` delivery, `firstConnect` skips `fullSweep` /
   reconnect fires `fullSweep`, malformed-payload skip.

A real regression in the xid8 arithmetic (e.g. signed-bigint overflow near 2⁶³,
an off-by-one floor comparison) or the ON-CONFLICT upsert would silently corrupt
cold-boot materialization with **zero** test signal today. This harness closes
that gap.

### Why these need a real Postgres (not a fake db)

The whole *value* is the SQL itself: `pg_snapshot_xmin(pg_current_snapshot())`
monotonicity, `numeric` xid8 comparison, `INSERT … ON CONFLICT … DO UPDATE`,
`text[]` binding via `sql.join`, `ORDER BY seq`. A fake `db` returning canned
rows would test control flow while proving nothing about the SQL — exactly the
part that's load-bearing and unproven. So the harness runs the **real SQL against
a real Postgres**.

### Approach decision: db-parametrization + throwaway DB on the running cluster

No hermetic embedded-Postgres spawn helper exists — `embedded/scripts/start.ts`
is a `main()`/`process.exit` CLI hardwired to the singleton dev-cluster paths,
not importable. Building a per-test cluster spawner is a large, flaky detour.

Instead we reuse the **already-running gateway-owned cluster** via the sanctioned
`admin/server` primitives (`ensureDatabase`, `dropDatabase`, `openShortLivedClient`)
— the same public API `forkDatabase`/the backup sources already use — to create
and drop an **isolated throwaway database per test run**. This mirrors the one
existing real-DB precedent (`migration-applies-clean` check builds a raw `Pool` +
`drizzle(pool)` against a live DB). The tests run the real SQL in isolation and
tear the database down after.

The seam is **db-parametrization**, matching the established repo pattern
(`ensureSnapshotTable(db)`, `rebuildTriggers(db)`, `runMigrations(db)`,
`dryRunPendingMigrations(db)` all take `db: NodePgDatabase` explicitly to avoid
cycling back into `database/server`). We extend that pattern to persist/catch-up
and refactor the listener into an injectable factory.

**Tradeoff (documented, accepted):** these suites require the running cluster.
Per repo policy (tests are optional/manual, run after a build, which starts the
cluster) this is fine. If the cluster is unreachable the fixture throws **loudly**
with an actionable message (`run ./equin build first`), never silently
skips.

## Design

### 1. Refactor `persist.ts` — pure, db-parametrized, import-safe

Remove `import { db } from "@plugins/database/server"`. Every SQL function takes
`db: NodePgDatabase` as its first parameter:

- `captureWatermark(db)`
- `persistSnapshot(db, key, paramsKey, value, watermark, tablesRead)`
- `readPersistedReadSets(db)`
- `readPersistedSnapshots(db, keys)`
- `clearPersistedSnapshots(db, keys)`

`shouldPersist`/`bootCriticalKeys` stay db-free. persist.ts now imports **no**
singleton → importing it in a test never triggers the `SINGULARITY_WORKTREE`-at-
import throw in `database/server`.

**Singleton binding moves to `server/index.ts`** (only ever loaded in a real
backend, which already imports `db`):

- `onReadyBlocking` passes `db` into `readPersistedReadSets(db)` and the hook
  closures: `setLiveStateSnapshotHooks({ shouldPersist, captureWatermark: () =>
  captureWatermark(db), persistSnapshot: (k,p,v,w,t) => persistSnapshot(db,k,p,v,w,t) })`.
- The two **barrel-exported** consumers (`readPersistedSnapshots` used by
  boot-snapshot, `clearPersistedSnapshots` by boot-bench) keep their public
  `(keys) => …` signature by re-binding the singleton in index.ts:
  `export const readPersistedSnapshots = (keys: string[]) => readPersistedSnapshotsImpl(db, keys);`
  (no cross-plugin signature change — boot-snapshot/boot-bench untouched).
- `prune.ts` similarly threads its own `db` (it defines a job; keep its singleton
  import there since it's not under test, OR parametrize for consistency — keep
  minimal: leave prune.ts as-is, it's not in scope).

### 2. Refactor `catch-up.ts` — inject db + route

`runCatchUp(db, route = routeChange)`; `fullRecomputeChangedTables(db, route)`;
`replayChange(row, route)`. Default `route = routeChange` preserves production
behavior (index.ts calls `runCatchUp(db)`); tests inject a **recording route
spy** so they observe exactly which changes replay, in what order, with what
`ids`/`op` — without standing up the full server-core runtime. Remove the
singleton `db` import; `server/index.ts` passes `db`.

### 3. Refactor `listener.ts` — injectable factory

Convert the module-global singleton into
`createChangeFeedListener(opts)` returning `{ start(): void; stop(): Promise<void> }`:

```ts
interface ChangeFeedListenerOptions {
  connectionString: () => string;
  route: (change: DbChange) => void;
  coveredTables: () => readonly string[];
  livenessIntervalMs?: number;   // default 30_000
  reconnectMinMs?: number;       // default 500
  reconnectMaxMs?: number;       // default 10_000
  setTimeoutFn?: typeof setTimeout;   // injectable for deterministic reconnect
  setIntervalFn?: typeof setInterval; // injectable for deterministic liveness
  clearIntervalFn?: typeof clearInterval;
}
```

Production keeps the exact current behavior via a **default singleton instance**
wired to the real deps, re-presented as the existing `startListener` /
`stopListener` exports (called only inside change-feed's own `server/index.ts` —
they are NOT in the plugin's public barrel, so the refactor is fully contained):

```ts
const defaultListener = createChangeFeedListener({
  connectionString, route: routeChange, coveredTables: getCoveredTables,
});
export const startListener = () => defaultListener.start();
export const stopListener = () => defaultListener.stop();
```

All module-global mutable state (`client`, `connecting`, `firstConnect`,
`reconnectDelay`, `livenessTimer`) becomes per-instance closure state, so tests
get a fresh, isolated listener. Timers are injected so reconnect/backoff is
driven deterministically (no real-clock sleeps → no flake).

### 4. Extract `ensureChangelogTable(db)` from change-feed (DRY)

The catch-up test needs the `live_state_changelog` table on the throwaway DB. Its
DDL is currently inlined in `triggers.ts` (`CHANGELOG_TABLE_DDL`, created inside
`rebuildTriggers`'s txn). Extract it to an exported
`ensureChangelogTable(db: NodePgDatabase)` so production (`rebuildTriggers` calls
it inside its txn — pass `tx`) and tests share one DDL source — mirroring
`ensureSnapshotTable(db)`. Export it from change-feed's server barrel.

### 5. Shared DB test fixture

A co-located `test-db.ts` (plain `.ts`, no `bun:test`) helper per plugin,
delegating to admin's **public** barrel — legal cross-plugin barrel imports,
no new production API, no boundary violation:

```ts
// createTestDb(): { db, drop() }
//  - name = `ls_test_${process.pid}_${Date.now().toString(36)}`  (unique per run)
//  - ensureDatabase(name); pool = openShortLivedClient(name); db = drizzle(pool)
//  - drop(): pool.end(); dropDatabase(name)
//  - beforeAll connection failure → throw with "run ./equin build first"
```

Lives in `live-state-snapshot/server/internal/test-db.ts` for the persist +
catch-up suites. The change-feed listener suite gets its own tiny co-located
`test-db.ts` (boundary rules forbid importing another plugin's internal `.ts`;
both are ~25 lines of admin-barrel boilerplate). **Follow-up noted:** if DB-backed
tests proliferate, extract a shared `db-test-fixture` leaf primitive.

`Date.now()`/`process.pid` are available in `bun:test` (the `Date.now` ban is a
Workflow-script constraint only).

### 6. Test suites

**`live-state-snapshot/server/internal/persist.test.ts`** (real DB):
- `captureWatermark` returns a numeric string; strictly increases across two
  committed writes (monotonic xid8).
- `persistSnapshot` inserts a row; a second call on the same `(key, params_key)`
  **updates in place** (ON CONFLICT, no duplicate) — value/position/tables_read
  all replaced.
- `tables_read` `text[]` round-trips (multi-element, and **empty** →
  `ARRAY[]::text[]`, read back as `[]`).
- `value` jsonb round-trips (object/array).
- `readPersistedReadSets` returns only `params_key='{}'` rows; empty `tables_read`
  → `[]`; ignores non-`{}` params.
- `readPersistedSnapshots([])` → empty map, **no query**; filters by key `IN`;
  missing key absent; value round-trips.
- `clearPersistedSnapshots` deletes only matching `{}` keys, returns exact count;
  leaves non-`{}` and unlisted rows.

**`live-state-snapshot/server/internal/catch-up.test.ts`** (real DB + route spy):
- No snapshots (`min(position)` null) → early return, **zero** replays.
- Normal: snapshot floor set; changelog rows straddling the floor → replays
  **only `xid >= floor`**, in **`seq` order**, each with correct `{table,op,ids}`.
- **Backstop:** `min(xid) > floor` (history pruned past a stale snapshot) →
  `fullRecomputeChangedTables`: one FULL (`op:'U', ids:null`) replay per **distinct**
  changelog table, and the loud WARNING is emitted.
- Empty changelog since floor → "already current", zero replays.
- `replayChange` DELETE and null-ids rows → `ids` forced `null` (FULL) into route.
- Boundary: a changelog row **exactly at** the floor xid is replayed (`>=`), one
  strictly below is not.

**`change-feed/server/internal/listener.test.ts`** (real DB + real triggers):
- `createChangeFeedListener` against the throwaway DB with `rebuildTriggers(db)`
  installed on a test user table: start → LISTEN up → a real `INSERT`/`UPDATE`
  produces a NOTIFY → `route` spy receives the parsed `{table,op,ids}`.
- **First connect does NOT fullSweep** (route sees only real changes, no synthetic
  FULL burst on boot).
- **Reconnect DOES fullSweep**: force a socket drop (end the underlying client) →
  injected timer fires reconnect → `route` receives one FULL per covered table.
- Malformed NOTIFY payload (`pg_notify('live_state','not json')`) → skipped, no
  route call, listener survives.
- `stop()` tears down cleanly (LISTEN client ended, liveness timer cleared).

All async DB waits use polling on the recorded route calls (bounded), not fixed
sleeps.

### 7. Docs + follow-ups

- Update `plugins/database/plugins/live-state-snapshot/CLAUDE.md` and
  `change-feed/CLAUDE.md` with a short "Invariant harness (DB-backed)" note: what
  it covers, the throwaway-DB fixture, the running-cluster prerequisite.
- Update the resource-runtime `CLAUDE.md` "Seam boundary" paragraph — the
  out-of-seam half is now **covered** by these suites (point to them), closing the
  loop the Track 3a doc opened.
- Point `2026-06-22-global-live-state-l2-persisted-materialization.md` §3.5 (floor
  arithmetic / backstop) and the Track 3a doc's follow-up bullet to these tests.
- **File follow-up task** (`add_task`): extract a shared `db-test-fixture` leaf
  primitive if DB-backed tests grow beyond these two plugins (removes the ~25-line
  per-plugin `test-db.ts` duplication cleanly through a barrel).

## Critical files

- **Refactor (db-parametrize, drop singleton import):**
  `plugins/database/plugins/live-state-snapshot/server/internal/persist.ts`,
  `.../catch-up.ts`; rewire `.../server/index.ts`.
- **Refactor (factory):** `plugins/database/plugins/change-feed/server/internal/listener.ts`.
- **Extract DDL:** `plugins/database/plugins/change-feed/server/internal/triggers.ts`
  (`ensureChangelogTable`), export from `.../change-feed/server/index.ts`.
- **New tests:** `.../live-state-snapshot/server/internal/{persist,catch-up}.test.ts`,
  `.../change-feed/server/internal/listener.test.ts`.
- **New fixtures:** `.../live-state-snapshot/server/internal/test-db.ts`,
  `.../change-feed/server/internal/test-db.ts`.
- **Reuse (public barrels):** `@plugins/database/plugins/admin/server`
  (`ensureDatabase`, `dropDatabase`, `openShortLivedClient`),
  `ensureSnapshotTable` (internal, same plugin), `rebuildTriggers`/
  `ensureChangelogTable` (change-feed barrel), `routeChange`/`DbChange`.
- **Docs:** the three CLAUDE.md + two research docs above.

## Verification

- `./equin build` — green (type-check picks up refactors + new `.ts`; no
  schema/migration surface touched; boundary check passes — only barrel imports).
  Build also confirms the listener factory refactor didn't break boot (the app
  deploys and live-state still works).
- `bun test plugins/database/plugins/live-state-snapshot plugins/database/plugins/change-feed`
  — all suites green (existing `parse-payload.test.ts` + 3 new files). Run after
  the build so the cluster is up and `node_modules` is populated.
- `./equin check` — green.
- Smoke the running app at `http://<worktree>.localhost:9000` — live-state still
  pushes (the listener refactor is behavior-preserving).
