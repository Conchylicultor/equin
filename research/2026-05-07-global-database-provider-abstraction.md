# Database Provider Abstraction

## Context

`SINGULARITY_USE_SYSTEM_PG=1` is an env var checked in 5 places to branch between embedded PG (Unix socket, port 5433, user "singularity") and system PG (localhost:5432, current user). The gateway has 410 lines of PG-specific lifecycle code (`postgres.go`) that should be generic process supervision. The goal:

1. Remove `SINGULARITY_USE_SYSTEM_PG` entirely
2. Control the provider via a config file at `~/.singularity/database.json`
3. Make the gateway a generic process supervisor (no PG knowledge)
4. Move PG lifecycle code from the gateway to the embedded plugin

## Config File: `~/.singularity/database.json`

Two consumers read different parts of the same file:

- **`connection`** — read by server + CLI for DB connectivity (database name is the worktree name, filled at runtime)
- **`services`** — read by gateway for generic process supervision

**Embedded PG:**
```json
{
  "connection": {
    "host": "/Users/x/.singularity/postgres/socket",
    "port": 5433,
    "user": "singularity"
  },
  "services": [
    {
      "name": "postgres",
      "start": ["bun", "run", "/abs/path/to/plugins/database/plugins/embedded/scripts/start.ts"],
      "ready": { "unix": "/Users/x/.singularity/postgres/socket/.s.PGSQL.5433" },
      "watchdog": { "intervalSec": 2 }
    }
  ]
}
```

**System PG:**
```json
{
  "connection": {
    "host": "localhost",
    "port": 5432,
    "user": "epot"
  },
  "services": []
}
```

TypeScript type:
```typescript
interface DatabaseConfig {
  connection: {
    host: string;
    port: number;
    user: string;
  };
  services: Array<{
    name: string;
    start: string[];
    ready: { unix: string } | { tcp: string };
    watchdog?: { intervalSec?: number };
  }>;
}
```

## Implementation

### Phase 1: Config file reader (no deps)

**NEW `plugins/database/shared/internal/config.ts`** — `readDatabaseConfig(): DatabaseConfig`
- Reads `~/.singularity/database.json` via `node:fs.readFileSync` + `JSON.parse`
- Caches in a module-level variable (config file changes require restart)
- If file missing: returns `{ connection: { host: "localhost", port: 5432, user: process.env.USER ?? "postgres" }, services: [] }` — equivalent to system PG
- Pure Node APIs only (no Bun imports), safe for CLI and server

**NEW `plugins/database/shared/index.ts`** — barrel re-exporting `readDatabaseConfig`, `DatabaseConfig`

### Phase 2: Embedded PG start script (no deps)

**NEW `plugins/database/plugins/embedded/scripts/start.ts`**

Absorbs all PG lifecycle currently in `gateway/postgres.go` (lines 115–175, 210–350). This is a standalone Bun script invoked by the gateway's generic supervisor.

Steps (mirrors `PgSupervisor.Start()` exactly):
1. Resolve binary dir from `import.meta.dir` → traverse up to `node_modules/@embedded-postgres/<platform>/native/bin/`
2. Platform detection: map `process.platform`/`process.arch` to npm package names (`darwin`+`arm64` → `@embedded-postgres/darwin-arm64`, `linux`+`x64` → `@embedded-postgres/linux-x64`, etc.)
3. Ensure dylib symlinks from `pg-symlinks.json` (replaces Go `ensureSymlinks`)
4. Reattach: if `PG_PID_FILE` exists + socket dials → print "already running", exit 0
5. Partial data dir: if `PG_DATA_DIR` exists but no `PG_VERSION` → nuke and re-initdb
6. `initdb` if no valid data dir (same args as Go: `-D`, `-U singularity`, `-A trust`, `--no-locale`, `--encoding UTF8`)
7. Clear stale pidfile if pidfile exists but socket doesn't dial
8. `pg_ctl start -w -D <dataDir> -l <logFile> -o "-k <socketDir> -p 5433 -c max_connections=500 -c listen_addresses=" -t 30`
9. Exit 0 on success, non-zero on failure (gateway reads exit code)

Imports from `../shared`: `PG_PORT`, `PG_USER`, `PG_DATA_DIR`, `PG_DIR`, `PG_SOCKET_DIR`, `PG_LOG_FILE`, `PG_PID_FILE`, `MAX_CONNECTIONS`.

Socket ping: `Bun.connect({ unix: socketPath })` with a 1.5s timeout for reattach check.

### Phase 3: Gateway — generic supervisor (depends on Phase 2)

**DELETE `gateway/postgres.go`** (410 lines)

**NEW `gateway/supervisor.go`**

Generic service supervisor. No PG knowledge — just "exec command, probe readiness, watchdog."

```go
type ServiceState int // Stopped | Starting | Running | Crashed

type ServiceConfig struct {
    Name     string            `json:"name"`
    Start    []string          `json:"start"`
    Ready    json.RawMessage   `json:"ready"`
    Watchdog *WatchdogConfig   `json:"watchdog"`
}

type WatchdogConfig struct {
    IntervalSec int `json:"intervalSec"`
}

type ReadyProbe interface {
    Check(timeout time.Duration) bool
}
type UnixProbe struct { Path string }  // net.DialTimeout("unix", path, timeout)
type TCPProbe struct { Addr string }   // net.DialTimeout("tcp", addr, timeout)

type Service struct {
    config    ServiceConfig
    probe     ReadyProbe
    mu        sync.Mutex
    state     ServiceState
    watchStop chan struct{}
}

type Supervisor struct {
    services []*Service
}
```

Key methods:
- `NewSupervisor(configPath string) (*Supervisor, error)` — reads `database.json`, parses `services[]`, builds probes
- `StartAll(ctx context.Context) error` — for each service: exec start command (blocking, check exit code), verify readiness via probe, arm watchdog goroutine
- `StopAll()` — stop all watchdog goroutines (services themselves are daemons, not killed)
- `List() []ServiceSnapshot` / `Get(name string) *ServiceSnapshot`

Watchdog: same pattern as `postgres.go:runWatchdog` — tick every `intervalSec` (default 2), probe, on failure attempt one re-exec of start command, if that also fails mark Crashed.

Start execution: `exec.Command(config.Start[0], config.Start[1:]...)`, run synchronously, check exit code. The start script handles daemonization internally (`pg_ctl` forks PG).

**MODIFY `gateway/main.go`**
- Remove `RepoRoot string` from `Config` struct (line 29)
- Remove `-repo-root` flag (line 51)
- Line 95: `pgSup := NewPgSupervisor(cfg.RepoRoot)` → `sup, err := NewSupervisor(filepath.Join(home, ".singularity", "database.json"))`; handle `err` (log + continue with empty supervisor if file missing)
- Line 117: `pgSup.Start(ctx)` → `sup.StartAll(ctx)`
- Line 134: `NewProxy(reg, routes, pgSup)` → `NewProxy(reg, routes, sup)`
- Line 148: `pgSup.Stop()` → `sup.StopAll()`

**MODIFY `gateway/proxy.go`**
- Line 22: `pg *PgSupervisor` → `sup *Supervisor`
- Line 25: Update `NewProxy` signature
- Lines 41–44: Remove `/api/database/status` interception entirely (no frontend consumers)
- In `handleGatewayAPI`, add new routes:
  - `GET /gateway/services` → `json.Encode(sup.List())`
  - `GET /gateway/services/<name>/status` → `json.Encode(sup.Get(name))`

### Phase 4: Server client (depends on Phase 1)

**MODIFY `plugins/database/server/internal/client.ts`**
- Remove `import { PG_PORT, PG_SOCKET_DIR, PG_USER } from "@plugins/database/plugins/embedded/shared"`
- Remove `const useSystemPg = ...` branching (lines 19–29)
- Replace with:
  ```typescript
  import { readDatabaseConfig } from "@plugins/database/shared";
  const config = readDatabaseConfig();
  const host = process.env.PGHOST ?? config.connection.host;
  const port = process.env.PGPORT ?? String(config.connection.port);
  const user = process.env.PGUSER ?? config.connection.user;
  ```
- Everything else (`pool`, `db`, `adminPool`, `awaitPgReady`, `libpqSubprocessEnv`, etc.) stays the same — they use `host`/`port`/`user` which now come from config

### Phase 5: CLI (depends on Phase 1 + Phase 3)

**MODIFY `cli/src/paths.ts`**
- Remove `EMBEDDED_PG_SOCKET`, `EMBEDDED_PG_PORT`, `EMBEDDED_PG_USER` constants (lines 14–16)
- Rewrite `libpqEnv()`:
  ```typescript
  import { readDatabaseConfig } from "@plugins/database/shared";
  export function libpqEnv(): Record<string, string> {
    const config = readDatabaseConfig();
    return {
      PGHOST: process.env.PGHOST ?? config.connection.host,
      PGPORT: process.env.PGPORT ?? String(config.connection.port),
      PGUSER: process.env.PGUSER ?? config.connection.user,
    };
  }
  ```
- Keep `PG_DIR`, `PG_DATA_DIR`, `PG_LOG_FILE` exports (still used by `build.ts` for error messages)

**MODIFY `cli/src/commands/build.ts`**
- `waitForPg()` line 242: replace `SINGULARITY_USE_SYSTEM_PG` check with:
  ```typescript
  const config = readDatabaseConfig();
  if (config.services.length === 0) return; // externally managed, assumed ready
  ```

**MODIFY `cli/src/commands/start.ts`**
- Line 93: remove `-repo-root`, `repoRoot` from gateway spawn args
- Before gateway spawn (after line 89), add `ensureDatabaseConfig(repoRoot)`:
  - If `~/.singularity/database.json` exists, return (respect user edits)
  - Detect embedded-postgres binaries: check if `<repoRoot>/plugins/database/plugins/embedded/node_modules/@embedded-postgres/` exists
  - If yes: write embedded config (absolute path to `scripts/start.ts`, socket path, port 5433, user "singularity")
  - If no: write system PG config (empty services, localhost:5432, `process.env.USER`)

### Phase 6: Cleanup (depends on all above)

**Remove all `SINGULARITY_USE_SYSTEM_PG` references:**
- `plugins/database/plugins/embedded/shared/internal/paths.ts` — delete `useSystemPg()` (lines 21–23)
- `plugins/database/plugins/embedded/shared/index.ts` — remove `useSystemPg` re-export

**Update docs:**
- `docs/setup.md` — replace env var instructions with `database.json` editing
- `gateway/CLAUDE.md` — replace "Postgres supervision" with "Service supervision", remove `-repo-root`, update file list (`supervisor.go` not `postgres.go`)
- `plugins/database/CLAUDE.md` — document `shared/` barrel and `database.json` schema
- `plugins/database/plugins/embedded/CLAUDE.md` — document `scripts/start.ts`, remove env var references

## Dependency Graph

```
Phase 1 (config reader)  ─────────────────────── Phase 4 (server client)
                          ╲                     ╱
                           ──── Phase 5 (CLI) ──
                          ╱
Phase 2 (start script)  ──── Phase 3 (gateway) ──
                                                  ╲
                                                   ── Phase 6 (cleanup)
```

Phases 1 and 2 are independent (parallel). Phase 3 needs 2. Phases 4 and 5 need 1. Phase 6 is last.

## Verification

1. Delete `~/.singularity/database.json`, run `./equin start` → auto-generates embedded config, PG comes up
2. `http://equin.localhost:9000` loads → embedded PG supervised correctly
3. `./equin build` from a worktree → CLI reads config, waits for PG, builds
4. Edit `database.json` to system PG (`"services": []`, `localhost:5432`), `./equin start --force` → skips supervision
5. `GET /gateway/services` returns `[{"name":"postgres","state":"running"}]` for embedded, `[]` for system
6. `GET /gateway/services/postgres/status` returns individual state
7. Kill PG manually → watchdog detects, re-runs start script once
8. `rg SINGULARITY_USE_SYSTEM_PG` returns zero results in code files
