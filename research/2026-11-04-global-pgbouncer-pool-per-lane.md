# One PgBouncer pool per connection lane

Task 4 of `research/2026-11-04-global-db-connection-failure-vision.md` (vision point 6).

## Context

The app splits its database connections into an **interactive** lane (a human
is waiting) and a **background** lane (flush, cascade, jobs), with gates in
`database/machine/internal/pg-driver.ts` (`backgroundQueryGate`,
`backgroundTxGate`, `RESERVED_INTERACTIVE`). The split stops at the app's
`pg.Pool`. Behind it PgBouncer (`pool_mode = transaction`,
`default_pool_size = 16`) has ONE server pool per database, shared by both lanes.

The app's gates only count connections the app still *holds*. A connection lost
to a deadline is abandoned (`connection/server/internal/abandon.ts`): the app
frees its gate slot and opens a replacement, but PgBouncer still counts the old
client, which keeps its server connection for as long as it sits idle in a
transaction. On 2026-11-03, 16 abandoned `conversations.usage:sync`
connections took every server slot of main's database, so `/home`'s
`SELECT 1` queued in PgBouncer forever.

This task is about **isolation, not headroom**: background trouble must not take
interactive capacity. It is not a fix for the leak (task 2) and must not hide it:
an exhausted background lane must stay loud (its calls miss their deadline and
name their pool — task 1 reports them; task 3's watchdog sees the sessions).

## Design

### A lane is a Postgres login role; PgBouncer pools per (database, user)

PgBouncer keys a pool by (database, user). The catch-all `* = host=… port=…`
entry cannot alias a database per lane without a config entry per worktree, so
each lane logs in as its own role:

| lane | role | PgBouncer `pool_size` (per database) | `max_user_connections` (whole cluster) |
|---|---|---|---|
| interactive | `singularity` (the cluster user) | 8 | 160 |
| background | `singularity_background` | 10 | 120 |

- The background role is `LOGIN`, a member of the cluster user, and has
  `ALTER ROLE … SET role = 'singularity'`: every session it opens runs as
  `current_user = singularity`, so object ownership and privileges are
  identical to today, while `session_user` (`pg_stat_activity.usename`) names
  the lane — the database can now tell which lane a blocked or idle session
  belongs to (helps task 3; nothing gets less visible).
- The role is created at backend boot (`ready()`), on the interactive pool, in
  one transaction under a `pg_advisory_xact_lock`, only when missing or
  misconfigured (idempotent, race-free across concurrent boots).

### One table of lanes, owned by `database/pgbouncer`, everything derived from it

`database/pgbouncer/core` gains `PGBOUNCER_LANES` (user suffix, pool size,
cluster cap per lane), `laneUser(base, lane)` and the pure
`renderPgbouncerConfig(inputs)` (the `pgbouncer.ini` + `userlist.txt` text);
`server`'s `pgbouncerConfigFiles()` binds it to this install's paths, and a new
`machine` barrel has `convergePgbouncerConfig()` (write both atomically when they
differ from what is on disk, then `SIGHUP` the running PgBouncer — its config
reload; `server/` may not touch the filesystem). Consumers:

- `pgbouncer/scripts/start.ts` writes the rendering on a fresh start (a reattach
  leaves the running daemon alone; the next backend boot converges it).
- `pg-driver.ts` sizes each app pool **from the same lane entry**, so the app
  pool and its PgBouncer pool cannot disagree (rung 1: the second number does
  not exist).
- The backend's `ready()` converges too. PgBouncer is started by the gateway
  and only re-run at gateway start, so without this, a deploy of this change
  would leave the running daemon without the background user and every
  background login would fail (measured: an unknown user gets
  `"trust" authentication failed` from PgBouncer). Every backend renders the
  same bytes, so concurrent converges are no-ops after the first.

The cluster budget is asserted at module load in the same file:

```
Σ lane max_user_connections + DIRECT_SESSION_RESERVE ≤ MAX_CONNECTIONS − superuser_reserved_connections
         160 + 120          +          217           ≤        500       −              3
```

`DIRECT_SESSION_RESERVE` is what bypasses PgBouncer (graphile runner/enqueue,
job locks, the change-feed LISTEN, admin, schema-generation locks — ~32 per
serving backend at most; 57 in use cluster-wide at design time). Past a lane's
cap PgBouncer queues that lane's clients instead of Postgres refusing logins,
so a burst of worktrees cannot eat the direct sessions' share.
`MAX_CONNECTIONS` is the embedded plugin's, re-exported from its server barrel.
`min_pool_size` drops 5 → 3 per pool, since every database now has two pools
(6 idle servers per database instead of 5).

### The app: two `pg.Pool`s behind one front

- `createLanePools(database)` builds `createDbPool({ name: "app" })` (interactive
  user, max = interactive `pool_size`) and `createDbPool({ name:
  "app-background" })` (background user, max = background `pool_size`). A new
  pool name, so every deadline miss names its lane.
- drizzle keeps ONE genuine `pg.Pool` (the interactive one — `db.transaction()`
  needs `instanceof Pool`); `installQueryWrapper(front, background)` routes a
  background-origin `query`/`connect` to the background pool, everything else
  (interactive and context-less: boot, migrations) to the front.
- `RESERVED_INTERACTIVE` disappears: the interactive floor is now a separate
  pool, not a share of a common one. The deadlock proof becomes
  `BACKGROUND_TX_MAX + BACKGROUND_QUERY_MAX ≤ BACKGROUND_POOL_SIZE` (3 + 7 ≤ 10),
  still asserted at module load; the background pool size IS the PgBouncer
  pool size, so it holds end to end.
- `ready()`: interactive probe → ensure the background role → converge PgBouncer
  → background probe (a bounded wait only for PgBouncer to apply the reload it
  was just sent; a missing lane then fails boot loudly, naming the user) →
  warm both pools (serving backends only).
- Gauges: `db-pool` (interactive) and `db-pool-background`.
- No PgBouncer (a system Postgres): both lanes use the cluster user on the
  direct socket; no role, no converge.

### Sizes

Interactive 8 + background 10 = 18 server connections per database (was 16
shared). Background keeps today's ceiling (3 tx + 7 query) so the cascade and
flush run as fast as today; interactive keeps more than its old floor of 6,
since it can no longer borrow idle background connections (its upstream bound,
`readLoadGate`, is 6 cold reads plus endpoint mutations). Nothing was raised
because it got hit: the total grows by 2 to give each lane a pool of its own.

## Caveats

- Worktree backends still on older code connect only as `singularity`, with a
  16-connection app pool, onto an 8-server PgBouncer pool once main converges:
  slower under load, never broken; fixed by rebasing.
- The shared PgBouncer config is written by any backend running this code: a
  worktree that edits `PGBOUNCER_LANES` rewrites it for the whole machine until
  main converges again.
- An exhausted background lane still wedges background work (by design — the
  leak itself is task 2); its calls miss deadlines on pool `app-background`.

## Verification

- `machine/internal/lanes.test.ts` (real cluster, throwaway database): hold every
  background PgBouncer server slot (`BEGIN` left open on 10 background-user
  sessions — the 11-03 shape), show a background-origin query through the app
  pools does NOT answer, and an interactive query does.
- `pg-driver.test.ts` updated for the two-pool wrapper (lane routing, gates).
- `render` unit test: both users, sizes and caps in the ini; budget relation.
- `./equin check`, `./equin build`, then `query_db` on `pg_stat_activity` shows
  `singularity_background` sessions for this worktree; the app works.
