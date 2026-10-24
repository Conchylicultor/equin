# Embedded PG: socket-only unless Zero is on

## Context

The standalone staged `launch` binary produced by `./equin release` (the
`--dev` output, and by extension the packed self-extracting web release and the
Tauri `.app`) starts its bundled embedded Postgres on the fixed default port
5433 with `-c listen_addresses=127.0.0.1`. That loopback TCP listener collides
with any other embedded cluster already on 5433 — the running dev cluster, or
another standalone release/preview. Result:

- A self-contained release fails to boot on any machine already running the dev
  stack (`could not bind 127.0.0.1: Address already in use`).
- Two standalone releases cannot run at once.
- This currently blocks headlessly verifying a release on a dev machine.

The fix couples the TCP listener to the **only thing that needs it**. The
loopback TCP listener + `wal_level=logical` exist solely so a logical-replication
client can consume the cluster — and today that client is *only* Zero's
zero-cache sidecar (`zeroCacheSpec()` in
`plugins/infra/plugins/launcher/server/internal/boot.ts:151-168`,
`upstreamDb: postgresql://…@127.0.0.1:${PG_PORT}/…`). Zero is gated on
`SINGULARITY_ZERO_CACHE === "1"` (default OFF) and is **never** enabled in any
release / launch / preview / Tauri path. Every other PG consumer — Drizzle pool,
admin pool, migrations/drizzle-kit, PgBouncer's upstream, DB-fork, change-feed,
the build CLI's `waitForDatabase` — connects over the **Unix socket**
(`PG_SOCKET_DIR`), never TCP (verified). So when Zero is off, the TCP listener is
pure dead weight and the sole source of the collision.

**Approach (chosen): gate the listener on the existing Zero switch, globally.**
No new knob — the TCP listener becomes *derived* from its consumer. This fixes
standalone releases, Studio previews, Tauri, and even two dev clusters at once,
as one class. The `/tmp/sgs-*` socket dir is already unique per launch, so with
no TCP listener nothing binds a fixed resource.

## Change

### `plugins/database/plugins/embedded/scripts/start.ts`

This standalone lifecycle script cannot import cross-plugin barrels; it already
reads `process.env.SINGULARITY_PG_PORT` directly, so it reads
`SINGULARITY_ZERO_CACHE` the same way. Derive the listener GUCs from it.

Current (lines ~160-177):

```ts
  // pg_ctl start -w: forks PG, waits for readiness, then exits.
  // -o flags: app traffic stays on the Unix socket; a loopback-only TCP
  // listener (listen_addresses=127.0.0.1) + wal_level=logical make the cluster
  // consumable by logical-replication clients (e.g. Zero's zero-cache) ...
  console.log(`pg: starting (socket=${PG_SOCKET_DIR}, port=${PG_PORT})`);
  const result = spawnSync(
    join(binDir, "pg_ctl"),
    [
      "start",
      "-D", PG_DATA_DIR,
      "-l", PG_LOG_FILE,
      "-o", `-k ${PG_SOCKET_DIR} -p ${PG_PORT} -c max_connections=${MAX_CONNECTIONS} -c listen_addresses=127.0.0.1 -c wal_level=logical`,
      "-w",
      "-t", String(READY_TIMEOUT_SEC),
    ],
```

New:

```ts
  // pg_ctl start -w: forks PG, waits for readiness, then exits. App traffic
  // ALWAYS stays on the Unix socket (-k/-p). The loopback TCP listener
  // (listen_addresses=127.0.0.1) + wal_level=logical exist ONLY to let a
  // logical-replication client consume the cluster — today that is solely Zero's
  // zero-cache (see zeroCacheSpec in launcher/server/internal/boot.ts), which
  // can't traverse PgBouncer nor replicate over a Unix socket. Every other
  // consumer connects over the socket. So both GUCs are gated on the same env
  // switch Zero is gated on, read directly here (this standalone script can't
  // import zeroCacheEnabled()). With Zero off — the default; no release / preview
  // / Tauri boot ever sets it — PG binds NO TCP port, so a self-contained
  // release's PG never collides with the dev cluster's 5433, another release's,
  // or another preview's. Both GUCs are postmaster-start-only, so they take
  // effect only on a full cluster (re)start.
  // PGHOST/PGPORT/PGUSER in env so pg_ctl's -w probe finds the socket.
  const zeroCacheEnabled = process.env.SINGULARITY_ZERO_CACHE === "1";
  const listenGucs = zeroCacheEnabled
    ? "-c listen_addresses=127.0.0.1 -c wal_level=logical"
    : "-c listen_addresses=''";
  console.log(
    `pg: starting (socket=${PG_SOCKET_DIR}, port=${PG_PORT}, tcp=${zeroCacheEnabled})`,
  );
  const result = spawnSync(
    join(binDir, "pg_ctl"),
    [
      "start",
      "-D", PG_DATA_DIR,
      "-l", PG_LOG_FILE,
      "-o", `-k ${PG_SOCKET_DIR} -p ${PG_PORT} -c max_connections=${MAX_CONNECTIONS} ${listenGucs}`,
      "-w",
      "-t", String(READY_TIMEOUT_SEC),
    ],
```

Key points:
- `-p ${PG_PORT}` is preserved unconditionally — it still sets the Unix-socket
  filename suffix (`.s.PGSQL.<port>`), independent of `listen_addresses`. The
  `pingSocket` reattach probe (`start.ts:92`) only checks the socket, so reattach
  is unchanged in both modes.
- `listen_addresses=''` is the standard Postgres "no TCP, socket-only" form (and
  is in fact the historical pre-Zero state of this script).
- **`wal_level=logical` is gated too**, not just `listen_addresses`. It has zero
  consumers besides Zero (`change-feed` uses STATEMENT triggers + `LISTEN`, which
  works at the default `wal_level=replica`), shares the exact same "for Zero"
  rationale, carries a modest write-amplification cost when unused, and is
  postmaster-start-only exactly like `listen_addresses` — so gating it introduces
  no new risk class and avoids an inconsistent half-fix.

### No other files change in this fix

- `plugins/database/plugins/pgbouncer/scripts/start.ts` — **no change.** Already
  Unix-socket-only (`listen_addr =` empty) and dials PG's upstream over the
  socket dir (`host=${PG_SOCKET_DIR}`); never sets `listen_addresses`.

## Behavioral change (one, expected)

A developer connecting an external GUI (TablePlus/Postico/DBeaver/pgAdmin) or
`psql -h 127.0.0.1 -p 5433` to the **dev** cluster loses that when Zero is off.
Alternatives: connect over the Unix socket
(`psql -h ~/.singularity/postgres/socket -p 5433 -U singularity`), or set
`SINGULARITY_ZERO_CACHE=1` before starting the dev cluster to opt back into TCP.
This should be called out in the PR description / a `CLAUDE.md` note. An
already-running dev cluster keeps its current listener until its next full
`pg_ctl restart` (GUCs are postmaster-start-only) — which does **not** affect the
fix, since the fix only changes what a *newly*-started release/preview `pg_ctl`
does in its own data dir.

## Follow-up (separate task, deferred — do NOT fold into this fix)

Once Zero-off instances never bind TCP, the free-PG-port allocation that exists
purely to dodge the collision becomes dead (inert, not harmful — it allocates an
unused port; `SINGULARITY_PG_PORT` still legitimately distinguishes two
Zero-*enabled* instances). A later pure-deletion pass would remove:

- `plugins/release/server/internal/preview-manager.ts` — `PREVIEW_PG_PORT_FLOOR`
  (line 20) + its comment, the `pgPort` call site (line 77), the
  `SINGULARITY_PG_PORT` spawn-env entry (line 88), `pgPort` in `previews.set`
  (line 97), the log interpolation (line 103), and `pgPort` passed to teardown
  (line 159). `pickFreePort` itself stays (still used for the HTTP port).
- `plugins/release/server/internal/preview-state-resource.ts` — the `pgPort`
  field (line ~16) and any UI surfacing it (grep first).
- `plugins/infra/plugins/launcher/server/internal/boot.ts` — the
  `killListenerOnPort(pgPort)` PG backstop in `teardownSelfContainedApp` (becomes
  a permanent no-op).
- `tauri/src-tauri/src/lib.rs` — `pick_free_port()` for PG (lines ~45-51, 83),
  the `SINGULARITY_PG_PORT` env sets (125, 152), and the `pg_port` `StackCtx`
  field.
- `plugins/database/plugins/embedded/shared/internal/paths.ts:4-9` — the
  `resolvePgPort()` doc comment rationale goes stale and needs a rewrite.

## Verification

1. **Diff sanity** — confirm `-p ${PG_PORT}` is still unconditional and the `-o`
   string is well-formed in both branches.
2. **Build + launch a release with the dev stack up** — with the dev stack
   running (PG on `~/.singularity/postgres/socket`, `.s.PGSQL.5433`), run
   `./equin release --dev`, then launch the staged `<out>/launch` binary.
   Confirm:
   - It boots — no `pg_ctl start failed` / address-in-use in the release's
     `postgres.log` (this is exactly where the 5433 TCP bind used to collide).
   - `lsof -iTCP:5433 -sTCP:LISTEN` shows at most one listener (never two), and
     none originating from the release's PG pid (`postmaster.pid` under its data
     dir) — proving `listen_addresses=''` took effect.
   - A Unix-socket connection to the release's own `PG_SOCKET_DIR`
     (`psql -h <release-socket-dir> -p 5433 -U singularity -c 'select 1'`)
     succeeds — proving socket-only operation is fully functional.
3. **Two releases at once** — stage + launch a second release (different
   `SINGULARITY_DIR`) simultaneously; confirm both boot with no collision.
4. **Studio preview** — start a preview via
   `plugins/release/server/internal/preview-manager.ts` (`startPreview`) while the
   dev stack is up; confirm its PG comes up socket-only, the app loads at
   `http://<composition>.localhost:<port>`, and `stopPreview` tears down cleanly
   (its `killListenerOnPort(pgPort)` backstop simply no-ops now — expected).
5. **Zero still works when opted in** — start a cluster with
   `SINGULARITY_ZERO_CACHE=1`; confirm PG *does* bind `127.0.0.1:<port>`
   (`lsof -iTCP:<port> -sTCP:LISTEN`) and zero-cache's replication-slot creation
   (needs `wal_level=logical`) succeeds — proving the gate correctly restores
   both GUCs for the one consumer that needs them.
6. `./equin build` to deploy, then `./equin check`.

## Critical files

- `plugins/database/plugins/embedded/scripts/start.ts` — **the only file changed
  by this fix.**
- `plugins/infra/plugins/launcher/server/internal/boot.ts` — reference:
  `zeroCacheSpec()` / `zeroCacheEnabled()`, the TCP consumer.
- `plugins/database/plugins/pgbouncer/scripts/start.ts` — reference: confirmed
  already socket-only.
- `plugins/release/server/internal/preview-manager.ts`,
  `tauri/src-tauri/src/lib.rs` — follow-up cleanup only.
