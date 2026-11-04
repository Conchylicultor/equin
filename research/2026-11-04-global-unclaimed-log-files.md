# Unclaimed log files: daemon logs, dead namespaces' logs, and a check

Task: task-1793813228-4g8l4y (parent: task-1793801431-5ikicv).

## Context

Log retention is supposed to be structural: `defineFileSink` makes a file's
bound part of how it is written. Three gaps let logs grow unbounded and
unnoticed (measured 2026-11-04):

1. **External daemons own a log path.** `~/.equin/postgres/postgres.log` (1.7 GB:
   `pg_ctl -l`) and `pgbouncer.log` (1.4 GB: `logfile =` in the rendered ini).
   Nothing rotates them, and Debug → Logs doesn't list them.
2. **Dead namespaces keep their gateway logs.** Each `logs/gateway/<ns>.log` is
   bounded (50 MB × 5), but nothing deletes the set when the namespace goes
   away: 2,898 of 3,028 names have no `~/.equin/worktrees/<ns>/` (1.9 GB).
3. **Nothing catches the next one.**

Decisions taken with the user:
- Detached log relay.
- Host-scan check with debt claims.
- Old daemon logs: rotate only, no excerpt.

## Design

### 1. Daemon output → a detached relay over the gateway's `rotatingWriter`

The daemons outlive the gateway (they reattach on restart), so their output
can't be a pipe into the gateway process. Instead, each service start gets its
own relay:

- **Relay mode in the gateway binary.** `gateway -log-relay <path>` reads stdin
  and writes it through `newRotatingWriter(path, maxLogBytes, maxLogBackups)`
  (`gateway/logwriter.go`), then exits at EOF. It reuses the same writer and
  bound as every gateway channel; the dispatch goes in `main.go` before the
  normal flag set.
- **Supervisor (`gateway/supervisor.go`, `execStartCommand`).** For each start
  and re-start:
  1. Create a pipe with `os.Pipe()`.
  2. Spawn the relay with stdin set to the read end and `Setsid`, so it
     survives the gateway.
  3. Run the start command with `ExtraFiles=[write end]` (fd 3) and
     `EQUIN_SERVICE_LOG_FD=3`.
  4. Close both ends in the gateway.

  If the daemon took the fd, the relay lives exactly as long as the daemon's
  processes. If the script only reattached, the relay sees EOF at once and
  exits without ever opening the file (the writer opens lazily).

  Both execs go through `env.go`: a new `ChildEnv` method, because the
  `launcher:gateway-env-explicit` check allows exec only there.
- **Where it writes.** `<LogDir>/services/<service>.log`, generic per service
  name; `database.json` needs no change. The Go `"services"` subdir is pinned to
  the TS one by a sync check (pattern: `principal:header-in-sync`).
- **`PG_LOG_FILE` / `PGBOUNCER_LOG_FILE`** become that path, derived from the
  `gatewayLogs` data-dir declaration. Readers keep working unchanged:
  `query-deadline` render, `build/cli/run.ts`, and the start-script error
  messages.
- **`database/embedded/scripts/start.ts`.** `pg_ctl start -l /dev/fd/<fd>` with
  the fd passed in `stdio`. Missing `EQUIN_SERVICE_LOG_FD` on a fresh start is a
  loud error, never a fallback to a file. Declare the key in
  `launcher/env-names` `env-keys.ts`.
- **`database/pgbouncer`.**
  - Drop `logfile` from the rendered ini (`core/internal/lanes.ts`, `config.ts`).
  - Run pgbouncer in the foreground (no `-d`), spawned detached with
    stdout/stderr set to the fd and `unref`'d.
  - The readiness poll stays as it is. The pidfile still names the process
    (to verify).
  - Verify that converging a *running, old-style* pgbouncer onto an ini with no
    `logfile` (RELOAD) is harmless.
- **Accepted cost (documented in gateway `CLAUDE.md` + embedded `CLAUDE.md`).**
  - A stalled relay would block backends' stderr writes. Postgres's own
    `logging_collector` makes the same trade.
  - Lines over `PIPE_BUF` (512 B on macOS) from concurrent backends can
    interleave.
- **Legacy files: rotate only.** On a *fresh* daemon start (not reattach), if
  the legacy `postgres/postgres.log` / `pgbouncer.log` exists, rename it into the
  new rotation as `services/<svc>.log.1`. It then ages out after 5 rotations.
  This is a one-shot migration in the start scripts, commented for removal.
  - Until the cluster restarts, the running daemons keep writing the legacy
    files. Those files carry a debt claim (below) until then.
  - **Rollout needs a gateway restart (`./equin start --force`, which rebuilds
    the binary) plus a Postgres + pgbouncer restart.** That's yours to trigger;
    I won't do it.

### 2. A namespace's gateway logs die with its registry dir (gateway-owned)

The gateway writes the files, so the gateway deletes them. That avoids racing
its own last writes during backend teardown.

- `gateway/registry.go` `remove()`: when the removal is a *registry dir gone*
  (fsnotify Remove, or reconcile's dir-absent branch), it deletes
  `<LogDir>/<ns>.log` and `.log.N` after `Stop` + `CloseLog`. It does not delete
  on the "spec.Server missing" eviction: the registry dir still exists there, so
  the namespace isn't reaped.
- `LoadAll` (boot) sweep: delete every top-level `<name>.log[.N]` whose `<name>`
  has no registry subdir, excluding the gateway's own channels (`gateway`,
  `gateway-stdio`; also check `central`). This clears the 2,898 orphans on the
  next gateway start and covers a reap that happened while the gateway was down.
- The `reapAttempt` / `reclaimNamespace` path needs no TS change: removing the
  spec dir is already the deregistration signal.
- Go tests are added beside `registry_test.go`.

### 3. Check: every log file under the data root is claimed

- **Claims live on the data-dir declarations** (`defineDataDir`, already an
  enumerable collected registry). The new optional field is
  `logs: LogClaim[]`, each `{ pattern, bound }` with `bound` one of:
  - `{ kind: "file-sink" }`
  - `{ kind: "gateway-rotating" }`
  - `{ kind: "truncate-on-start" }` (e.g. `gateway-stdio.log`)
  - `{ kind: "debt", reason, task }`

  A claim for a sink family is trusted, not verified. The writer side is already
  bounded by construction.
- **The check** (in `infra/paths` or a small child plugin; decided at
  implementation by the boundary table):
  - It runs a depth-bounded `readdir` walk of the data root (no `find`).
  - It looks at `*.log`, `*.jsonl` and their `.N` rotations, skipping symlinks
    (the root's legacy `op-log.jsonl` → `logs/…` links).
  - It fails on each file no claim matches, naming the file, its size, and
    "declare it on the owning data dir".
  - It passes on a machine without the files (fresh checkout / CI).
- **Today's other offenders get debt claims plus one task each**, filed under
  this task: `logs/browser-recordings`, `logs/fd-ledger`, `logs/monitors`,
  `logs/menu-bar/helper-stdio.log`, the worktree `runs/` transcripts,
  `state/conversation-rewinds`, and whatever else the first run lists. The legacy
  `postgres/*.log` get a debt claim too, removed once the migration has run
  here.

### 4. Debug → Logs lists service logs

`debug/logs/server/internal/sources.ts` gains a `service` scope. It lists each
`services/*.log` in `gatewayLogs` with the gateway's bound, which also fills the
`backend` scope's currently-`null` bound. The bound constants are shared TS-side
and pinned to Go by the same sync check. `LogScope` (`shared/resources.ts`) and
the catalog's presentation get the new scope.

## Critical files

- **Gateway:** `gateway/logwriter.go`, `main.go`, `supervisor.go`, `env.go`,
  `registry.go`, `CLAUDE.md`, plus tests.
- **Database:**
  - `plugins/database/plugins/embedded/{scripts/start.ts,shared/internal/paths.ts,CLAUDE.md}`
  - `plugins/database/plugins/pgbouncer/{scripts/start.ts,core/internal/lanes.ts,server/internal/config.ts,shared/internal/paths.ts}`
- **Launcher:**
  - `plugins/infra/plugins/launcher/data-dirs/index.ts` (claims, `services`
    subdir)
  - `env-names/core/internal/env-keys.ts`
- **Data dirs:** `plugins/infra/plugins/paths` (`defineDataDir` `logs` field),
  plus every data-dir declaration that owns a log family.
- **Debug → Logs:** `plugins/debug/plugins/logs/{server/internal/sources.ts,shared/resources.ts,web/…}`

## Verification

- **Go:** `go test ./...` in `gateway/`.
  - The relay rotates and exits at EOF.
  - The supervisor's start passes fd 3 and the relay survives the supervisor
    process.
  - `remove()` deletes the dir-gone namespace's logs and keeps them on the
    server-missing eviction.
  - The boot sweep keeps the own channels and live namespaces.
- **Throwaway cluster** (an `./equin run` e2e-style script on a `/tmp` data root
  and its own port):
  - Run initdb + start through a hand-run gateway relay, then check that
    `services/postgres.log` gets the connection lines and rotates at a small
    cap.
  - Do the same for pgbouncer: foreground, pidfile written, no `logfile`.
  - RELOAD an old-style pgbouncer onto the new ini.
- `./equin test` on `query-deadline`, `pgbouncer` (lanes), `debug/logs`.
- `./equin check` passes here, with the debt claims, and fails when an unclaimed
  `/tmp`-root `foo.log` is planted (unit test on the matcher plus the root
  override).
- `./equin build`, then Debug → Logs on `http://<worktree>.localhost:9000` lists
  the service logs (screenshot).
- After you restart the gateway and the cluster:
  - `postgres/*.log` have moved to `services/*.log.1`.
  - The new files grow under the 50 MB × 5 bound.
  - `logs/gateway` holds only live namespaces.

## As built (deviations from the plan above)

- **The fd travels on argv (`--log-fd 3`), not `EQUIN_SERVICE_LOG_FD`.** The
  daemon inherits its start script's environment for life; a per-start value
  belongs on argv (the launcher's `per-process-env-on-argv` rule).
- **Behind an older gateway** (no `--log-fd`): Postgres falls back to the
  legacy file, PgBouncer daemonizes with `-d` and no log — both say so. The
  gateway binary is rebuilt only by `./equin start`, and refusing would leave
  the cluster down on a watchdog re-start until then (same stance as the
  principal handshake).
- **A new bound kind, `rotates-itself`** (`how`): `fd-monitor.sh` rotates its
  own log by line count.
- **Scan scope:** `logs` and `services` dirs plus any dir declaring claims;
  `worktrees`, `cache`, `state`, `apps` are not scanned (a full-root scan took
  ~30 s under load, and those kinds are bounded by reclaim / retention / the
  namespace's life).
- **Verified on a throwaway root** (`/tmp` data root, hand-built gateway, the
  real start scripts): legacy file adopted as `services/postgres.log.1`; both
  daemons log through their relays; relays survive a gateway exit (reparented
  to pid 1) and a reattaching restart spawns relays that exit at EOF; a killed
  PgBouncer is re-started by the watchdog with a fresh relay while the old
  one exits. Postgres survives its relay dying (checked separately).
- **Side finding:** PgBouncer's `socket_setup(N) failed: Invalid argument`
  warning fires exactly while a gateway's watchdog is probing it (stops when
  the gateway is down) — the 2 s readiness dial, closed before any startup
  packet.

Debt tasks: task-1793827125-kkjagx (monitors' logs), task-1793827129-t489g4
(drop the legacy-log migration once every cluster has restarted).
