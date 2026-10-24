# Make the embedded Postgres cluster consumable by logical-replication clients

> Prerequisite task for adopting Rocicorp Zero. See the roadmap
> [`research/2026-06-23-global-adopt-zero-sync-engine.md`](./2026-06-23-global-adopt-zero-sync-engine.md)
> — this unblocks the Stage 0 spike and every later stage.

## Context

The gateway-owned embedded Postgres cluster (shared across all worktrees, data dir
`~/.singularity/postgres/data-pg18`) is started in **one place** with a fixed flag string
and is currently **not consumable by any logical-replication client**:

- `wal_level` runs at the PG18 default `replica` — below the `logical` level a logical
  decoding consumer (Zero's `zero-cache`) needs to create a replication slot.
- `listen_addresses=` is empty — the cluster is **strictly Unix-socket-only**, no TCP. A
  replication client can't attach: replication can't traverse PgBouncer (no TCP listener +
  transaction-mode pooling tears down the session), and `node-postgres` can't run the
  replication protocol over a Unix socket.

Both must change for the cluster to be reachable by `zero-cache`. The change must coexist
non-breakingly with the existing homemade trigger/`pg_notify` change-feed (which it does —
that engine uses async messaging + xid functions, neither of which touches WAL decoding).

**Decisions taken** (the boundary question from the roadmap is resolved for this task):

- **Commit both** `wal_level=logical` and a **loopback-only** `listen_addresses=127.0.0.1`
  here, so the cluster is fully consumable end-to-end and the spike connects with zero extra
  setup. Loopback-only means no external exposure; trust auth already grants local
  socket-superuser access, so the threat-model delta on a single-user dev box is negligible.
- **Leave `max_wal_senders` / `max_replication_slots` at PG18 defaults (10 each).** The Stage 0
  spike is single-DB (main only) = one slot; default 10 is ample and already satisfies
  `logical`'s `max_wal_senders > 0` requirement. The per-worktree slot ceiling is a Stage 2
  topology decision, deliberately not pre-committed here.

## The change

### 1. Add the GUCs — the only code edit

**`plugins/database/plugins/embedded/scripts/start.ts`** (the `-o` flag string, currently
~line 170 — the entire cluster GUC surface; there is no `postgresql.conf` editing anywhere):

```diff
- "-o", `-k ${PG_SOCKET_DIR} -p ${PG_PORT} -c max_connections=${MAX_CONNECTIONS} -c listen_addresses=`,
+ "-o", `-k ${PG_SOCKET_DIR} -p ${PG_PORT} -c max_connections=${MAX_CONNECTIONS} -c listen_addresses=127.0.0.1 -c wal_level=logical`,
```

Update the adjacent comment (currently `// -o flags pin PG to Unix socket only (no TCP).`)
to reflect that PG now also accepts loopback TCP for logical-replication consumers, while all
app traffic stays on the Unix socket.

Notes:
- `wal_level=logical` and `listen_addresses` are **postmaster-start-only** GUCs (not
  `SIGHUP`-reloadable) — they only take effect on a full cluster restart (step 3).
- `listen_addresses=127.0.0.1` keeps the listener loopback-only. The Unix socket
  (`.s.PGSQL.5433`) is unchanged, so the readiness probe and every existing connection path
  are untouched.
- No `pg_hba.conf` edit is expected: the data dir was `initdb`'d with `-A trust`, which writes
  `host all all 127.0.0.1/32 trust` (and `::1/128`). Loopback TCP trust works out of the box.
  **Verify this in step 4** — if for any reason the host line is missing, that's the only
  additional edit needed.

### 2. Nothing else changes in code

- **Change-feed is unaffected.** `pg_notify`/`LISTEN`/STATEMENT-triggers and
  `pg_current_xact_id()` / `pg_snapshot_xmin()` (in `change-feed/` and `live-state-snapshot/`)
  are independent of `wal_level`. Confirmed: zero repo references to any
  replication-slot / `pg_logical_*` / `CREATE PUBLICATION` / `wal_level` feature.
- **No connection re-routing.** `plugins/database/server/internal/client.ts` (app pool →
  PgBouncer socket :6432) and `plugins/database/plugins/admin/server/internal/pool.ts`
  (admin pool → PG socket :5433) both build **Unix-socket** URLs (host starts with `/`).
  Adding a TCP listener does not make anything switch to TCP.
- **No gateway changes.** `gateway/supervisor.go` is data-driven and already implements a
  `TCPProbe`; readiness probes parse no GUCs and read no logs. (Relevant only to a *future*
  zero-cache service entry — out of scope here.)
- **No `database.json` / `ensureDatabaseConfig` change.** The postgres service entry and its
  `ready: { unix: … }` probe are unchanged.

### 3. One-time cluster restart (the operationally subtle step)

`scripts/start.ts` has a **reattach guard**: if the pidfile exists and the socket pings live,
it returns early without touching the running postmaster. So a plain `./equin build`
will **not** apply the new GUCs. A one-time explicit stop + restart of the shared cluster is
required. This briefly drops every worktree's DB connections; their pools auto-reconnect (the
cluster is detached and survives gateway restarts, but here we're deliberately bouncing it).

Procedure (run once, after the edit and a build so the new `start.ts` is in place):

```bash
# Stop the shared postmaster (path from embedded/shared/internal/paths.ts: PG_DATA_DIR)
<pg-bin-dir>/pg_ctl stop -D ~/.singularity/postgres/data-pg18 -m fast

# Re-spawn with the new flags via the canonical start path
bun run plugins/database/plugins/embedded/scripts/start.ts
```

(`<pg-bin-dir>` is the embedded PG18 binary dir the start script resolves; reuse the same one.
Equivalently, `pg_ctl restart -D … -o "<the full new -o string>"`, but going through
`start.ts` keeps a single source of truth for the flags.)

## Verification

After the restart:

1. **GUCs applied** (connect over the Unix socket, as everything normally does):
   ```bash
   psql "postgres://singularity@/postgres?host=$HOME/.singularity/postgres/socket&port=5433" \
     -c "SHOW wal_level;" -c "SHOW listen_addresses;"
   ```
   Expect `logical` and `127.0.0.1`.
2. **TCP reachability** (the new capability):
   ```bash
   psql -h 127.0.0.1 -p 5433 -U singularity -d postgres -c "SELECT 1;"
   ```
   Must connect (proves loopback TCP + trust pg_hba both work).
3. **Logical slot can be created** (the actual prerequisite a replication consumer exercises):
   ```bash
   psql -h 127.0.0.1 -p 5433 -U singularity -d postgres \
     -c "SELECT pg_create_logical_replication_slot('zspike','pgoutput');" \
     -c "SELECT slot_name, slot_type, plugin FROM pg_replication_slots;" \
     -c "SELECT pg_drop_replication_slot('zspike');"
   ```
   Slot creates as `logical`/`pgoutput` and drops cleanly. (Always drop it — an undropped
   logical slot pins the WAL horizon.)
4. **pg_hba check** — if step 2 fails with "no pg_hba.conf entry", add
   `host all all 127.0.0.1/32 trust` to `~/.singularity/postgres/data-pg18/pg_hba.conf` and
   `pg_ctl reload`. (Expected unnecessary given `-A trust` at initdb.)
5. **Live-state still works (non-breaking proof).** Open a worktree app at
   `http://<worktree>.localhost:9000`, then mutate a row the UI is showing — e.g. via the
   `query_db` MCP tool against that worktree DB, or any normal in-app write — and confirm the
   pane updates live. Watch `debug/live-state-churn` / `debug/op-rate` reports for regressions.
   This proves the trigger/`pg_notify` feed is undisturbed by the raised `wal_level`.

## Critical files

- **Edited:** `plugins/database/plugins/embedded/scripts/start.ts` (the `-o` flag string).
- Read-only context (confirm unchanged / understand routing):
  - `plugins/database/plugins/embedded/shared/internal/paths.ts` — `PG_DATA_DIR`, `PG_PORT`,
    `PG_SOCKET_DIR`, `MAX_CONNECTIONS` constants.
  - `plugins/database/plugins/change-feed/server/internal/triggers.ts` + `listener.ts` —
    the feed that must keep working.
  - `plugins/database/server/internal/client.ts`,
    `plugins/database/plugins/admin/server/internal/pool.ts` — Unix-socket connection paths
    that stay on the socket.
  - `plugins/infra/plugins/launcher/server/internal/boot.ts` (`ensureDatabaseConfig`) and
    `gateway/supervisor.go` — data-driven supervision (unchanged; relevant to a future
    zero-cache service entry, not this task).

## Out of scope (owned by later stages)

- The `zero-cache` service definition / `database.json` entry / gateway wiring (Stage 1/2).
- Per-worktree replication-slot topology and any `max_replication_slots` / `max_wal_senders`
  increase (Stage 2).
- Mutator/permission model, the Zero schema, the `useResource`-shaped adapter (Stage 1/3).
