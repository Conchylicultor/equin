# Declared runtime environment: the gateway and every backend start from a closed list, not from whoever started them

## Context

`./equin start --force`, run from an agent shell, produced a gateway whose
environment carried that shell's `SINGULARITY_CONVERSATION_ID`,
`SINGULARITY_PARENT_HOST`, `SOCKET_PATH` and the retired `SINGULARITY_WORKTREE`
(observed 2026-09-15, gateway PID 58276). Two spawns forward everything:

- **Starter → gateway.** `spawnGatewayDaemon`
  (`plugins/infra/plugins/launcher/server/internal/boot.ts:535`) passes
  `env: { ...process.env }`.
- **Gateway → children.** `gateway/worktree.go` builds each backend's env as
  `append(os.Environ(), "SOCKET_PATH=…")` (`startBackend`, :994) and each
  zero-cache's as `append(os.Environ(), ZERO_*…)` (`startZeroCache`, :752).
  The Postgres / PgBouncer start commands (`gateway/supervisor.go:251`) and
  `taskpolicy` (:945) set no `Env` at all, which in Go means "inherit
  everything".

So every backend on the host (main, central, every worktree) runs with one agent
conversation's identity. Anything they spawn inherits it too: a toolbar build
(`plugins/build/server/internal/run-build.ts` → `supervised-run`, which spreads
`process.env`) writes op-log records stamped with that conversation
(`op-log/server/internal/profiler.ts:113` reads `SINGULARITY_CONVERSATION_ID`),
and any commit made under it gets that conversation's trailer from
`.githooks/prepare-commit-msg`. This is the same class of leak as the Sep 9
misattributed push and the `SINGULARITY_WORKTREE` inheritance retired in
`research/2026-09-15-global-retire-ambient-worktree-env-runtime-identity.md`.

It is live right now. The gateway restarted since the report (PID 59982, started
from a Claude Code session) carries that session's `CLAUDECODE`,
`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_TOKEN`, `TMUX`, `TMUX_PANE` and
a dozen `WARP_*` terminal variables. Main and central carry all of them. `TMUX`
is worse than cosmetic: a tmux client with `TMUX` set talks to the server that
variable names, not to the default socket. So the backend's agent-session
commands follow whichever tmux server the starter happened to be inside.

The agent-pane side is already fixed the right way:
`runtime-tmux/server/internal/agent-session-env.ts` rebuilds each pane's
environment from a closed allowlist (`env -i`). This plan applies the same
principle one level up, at both of the boundaries above.

**Outcome.** The gateway receives exactly the declared set from its starter. It
hands every child exactly that set plus the child's own declared additions
(`SOCKET_PATH`, `ZERO_*`). Nothing the starting shell carried reaches a backend
unless it is on the list. A new `SINGULARITY_*` variable cannot be added without
deciding whether it travels.

## Design

### A. One declaration, in TypeScript: `launcher/core`

New `core/` runtime on the existing launcher plugin
(`plugins/infra/plugins/launcher/core/index.ts`, a leaf with no imports). The
launcher owns the root of the process tree (it spawns the gateway for
`./equin start`, the release `launch` binary, the desktop app and systemd),
so it owns what that tree carries.

```ts
// Host facts: passed through from the starter when set, never invented.
RUNTIME_HOST_ENV = ["HOME", "USER", "LOGNAME", "SHELL", "PATH", "TMPDIR",
                    "LANG", "LC_ALL", "LC_CTYPE"]

// Installation settings that must reach the backend. Each has a one-line why.
RUNTIME_FORWARDED_ENV = {
  SINGULARITY_DIR, SINGULARITY_SOCKETS_DIR, SINGULARITY_RELEASE,
  SINGULARITY_RELEASE_RUN_ID, SINGULARITY_RELEASE_COMPOSITION,
  SINGULARITY_PG_BIN_DIR, SINGULARITY_PGBOUNCER_BIN, SINGULARITY_PG_PORT,
  SINGULARITY_PG_SOCKET_DIR, SINGULARITY_MIGRATIONS_DIR,
  SINGULARITY_PARCEL_WATCHER_NODE, SINGULARITY_SENTINEL_WORKER_JS,
  SINGULARITY_REPO_CONFIG_DIR, SINGULARITY_WEB_DIST,
  SINGULARITY_ZERO_CACHE, SINGULARITY_ZERO_NODE, SINGULARITY_CLAUDE_BIN,
  SINGULARITY_PROFILING, SINGULARITY_NO_SPAWN_PRIORITY,
  SINGULARITY_NO_SIGNAL_ORIGIN, SINGULARITY_HEAVY_READ_LOCAL_CONCURRENCY,
}
RUNTIME_FORWARDED_PREFIXES = { "SINGULARITY_AUTH_": "operator-set OAuth client credentials, read by central" }

// Third-party tool locations an operator may set, whose install-time and
// run-time readers must agree. PLAYWRIGHT_BROWSERS_PATH: browser-fetch's
// provision step installs chromium there, and chromium.launch() inside the
// backend looks there (browser-fetch/provision/index.ts:156,
// browser-fetch/server/internal/browser-fetch.ts:217).
RUNTIME_FORWARDED_TOOL_ENV = ["PLAYWRIGHT_BROWSERS_PATH"]

// Names that exist but must NEVER be inherited by a runtime. Each says who
// delivers it instead.
RUNTIME_WITHHELD_ENV = {
  SINGULARITY_CONVERSATION_ID: "agent-session identity; tmux -e into its own pane",
  SINGULARITY_PARENT_HOST:     "same",
  SINGULARITY_WORKTREE:        "retired; the runtime namespace is argv",
  SINGULARITY_HOST_GRANT, SINGULARITY_LANE: "per-child admission grant, set by its spawner",
  SINGULARITY_BUILD_ID, SINGULARITY_BUILD_DETACHED, SINGULARITY_BUILD_IN_PROGRESS,
  SINGULARITY_CHECK_*, SINGULARITY_E2E_BASE, SINGULARITY_DEPS_REEXEC,
  SINGULARITY_SKIP_POST_REWRITE: "CLI-run state",
  SINGULARITY_LISTEN, SINGULARITY_DEFAULT_NAMESPACE: "launcher inputs, passed as gateway flags",
}

pickRuntimeEnv(source: Record<string, string | undefined>): Record<string, string>
runtimeEnvNames(): string[]   // host + forwarded names + "PREFIX*" entries, for the gateway flag
```

Deliberately **not** on the list:

- **Session and terminal state:** `TMUX*`, `CLAUDE*`, `TERM*`, `WARP_*`,
  `SSH_*`, `XPC_*`, `SECURITYSESSIONID`. The keychain works without them:
  secrets use the native keyring addon, and agent panes already run `claude`
  under `env -i`.
- **`SOCKET_PATH`:** the gateway sets it per child.
- **`PG*`:** the database location is declared in `database.json`.
  `database/core/internal/config.ts` `libpqEnv()` lets the environment win over
  that file. It is used by the build CLI's Postgres readiness probes
  (`build/cli/run.ts:243,288`), and a toolbar build runs that CLI as a child of
  the backend. So today a stray `PGHOST` in the starting shell would silently
  point a UI-triggered build at another server. (`pg_dump` / `pg_restore` are
  already safe: `libpqSubprocessEnv()` is spread after `process.env`.) This is an
  intentional behaviour change for the "no `database.json`, external PG" case,
  which now reads its connection from the file only.
- **`EQUIN_RELEASE_DIR`:** set by the systemd unit, but consumed only by the
  release self-extractor before `launch.ts` runs; no runtime reads it.
- **Toolchain variables** (`GOROOT`, `CARGO_HOME`, `RUSTUP_*`, `HOMEBREW_*`,
  `__MISE_SHIM`): `PATH` is forwarded, and on this host each of these equals the
  tool's own default or is recomputed by the tool from its install location.
  Verified in step 6.

### B. Boundary 1 — starter → gateway

`spawnGatewayDaemon` spawns with `env: pickRuntimeEnv(process.env)`. It still
reads the **live** `process.env`, so the docstring's reason for the explicit
spread keeps holding: the release launcher's `launch.ts` mutations still reach
the gateway, because every one of them is a forwarded name. It also appends
`-child-env <runtimeEnvNames().join(",")>`.

This is the only TypeScript spawn site that needs to change:

- The **release `launch` binary**, under the desktop app (Rust `Command`
  inherits by default), the preview manager and systemd, reaches the gateway
  through this same function. Its own ambient environment is filtered here.
  Under systemd, `HOME` / `USER` / `LOGNAME` / `SHELL` come from the unit's
  `User=` (systemd fills them from the passwd entry). That is the same
  dependency as today, and the filter keeps it.
- `preview-manager.ts` spawns `launch` with `{ ...process.env, … }` from a
  backend whose environment is already declared.

### C. Boundary 2 — gateway → every child

New `gateway/env.go`, the only file allowed to call `os.Environ()` or
`exec.Command`:

```go
type ChildEnv struct{ base []string }            // captured once at boot
func NewChildEnv(declared []string, environ []string) (ChildEnv, dropped []string)
func (c ChildEnv) With(extra ...string) []string // extra overrides base by name
func (c ChildEnv) Command(name string, args ...string) *exec.Cmd  // Env always set
```

- `-child-env` (comma-separated names; `PREFIX*` matches a prefix) is
  **required**. Without it the gateway exits non-zero with "start the gateway
  with ./equin start, which declares -child-env". The launcher already
  passes every path flag explicitly for the same reason: a Go-side default would
  be a second copy of the list. Go holds no list of its own.
- At boot it logs the names it forwards and, at warn level, the names present
  in its own environment that it drops. The normal path drops nothing. A
  hand-run gateway's leak becomes visible in `gateway.log`.
- Call sites use it:
  - `startBackend`: `ChildEnv.Command(...)` + `With("SOCKET_PATH=…")`.
  - `startZeroCache`: `With(ZERO_*…)`.
  - `execStartCommand` (Postgres / PgBouncer): base env, explicitly.
  - `promoteBackend` (taskpolicy) and `sigterm_darwin.go` (ps): base env, so no
    gateway exec falls back to Go's implicit inherit.
- `ChildEnv` is threaded through `Config` into `Worktree.cfg` and
  `NewSupervisor`. Thirteen Go test sites build `Config` / `ServiceConfig` by
  hand (`sockets_test.go`, `proxy_test.go`, `supervisor_test.go`,
  `registry_test.go`). A zero `ChildEnv` means an empty environment, not
  "inherit", so those sites get a `testChildEnv(t)` helper (`PATH` + `HOME`).
  That way no test silently depends on the old implicit inherit.
- Hand-running the gateway (e.g. under a debugger) now needs `-child-env`.
  `gateway/CLAUDE.md` "Build & Run" gains a copy-pasteable minimal form
  (`-child-env HOME,USER,PATH`), and names `runtimeEnvNames()` as the full list.
- `main.go` drops the dead `SINGULARITY_DEFAULT_NAMESPACE` env default: nothing
  sets it, and the flag is the contract. `SINGULARITY_DIR` and
  `SINGULARITY_SOCKETS_DIR` keep their roles as hand-run flag defaults; both are
  on the list.

**Compatibility.** `./equin start` always rebuilds the gateway
(`start/cli/run.ts`, `forceBuild: true`), so the new flag and the new binary
ship together. A stale worktree's backend spawned by the new gateway gets the
declared set plus `SOCKET_PATH`, which covers everything it reads. New backends
under the still-running old gateway behave exactly as today until the user
restarts it. No transition fallback is needed.

### D. Enforcement

Both checks are contributed from `plugins/infra/plugins/launcher/check/index.ts`
and run in `./equin check` and `push`.

- **`launcher:runtime-env-declared` (rung 3).** Every `SINGULARITY_[A-Z0-9_]+`
  name in plugin code must be forwarded, withheld, or match a forwarded prefix.
  Scope: non-test `.ts`, plus non-test `gateway/*.go` and `.githooks/*`. The
  vite build-time defines `__SINGULARITY_GRAPH__` / `__SINGULARITY_COMMIT__`
  are excluded by matching the leading `__` in the source, not by filtering the
  extracted name. The failure message names the file and asks the
  one question that matters: *should a backend inherit this from whoever starts
  the gateway?* This closes the coupling "a new release relocation variable
  set in `launch.ts` must also be forwarded", which today fails silently in a
  release only.
- **`launcher:gateway-env-explicit` (rung 3).** `os.Environ(` and `exec.Command(`
  appear in non-test `gateway/*.go` only inside `gateway/env.go`. Test files are
  exempt: `sockets_test.go` spawns `sleep` directly, and a test has no
  `-child-env`. Go tests do not run in
  `check`, so this guard lives here.
- **Tests.**
  - `gateway/env_test.go`: undeclared names are dropped, prefix entries match,
    `With` overrides a same-named base entry (a `SOCKET_PATH` in the base never
    wins), and a missing `-child-env` is fatal.
  - `launcher/core/internal/runtime-env.test.ts`: `pickRuntimeEnv` keeps
    declared and prefix-matched names, drops withheld and unknown ones, and the
    forwarded and withheld sets are disjoint.
- **Docs.**
  - `gateway/CLAUDE.md`: "Backend Contract" gains an "Environment" item (the
    declared set + `SOCKET_PATH`, nothing inherited), and the `-child-env` flag
    goes in "Build & Run".
  - `launcher/CLAUDE.md`: new section "What the runtime tree carries".
  - Comments that describe forwarding as "the gateway forwards `os.Environ()`"
    are rewritten to name the declaration: `launch.ts`,
    `paths/core/internal/paths.ts` (`isRelease`, release identity) and
    `run-build.ts`.

## Steps (each builds and checks green on its own)

1. **Declaration + test.** `launcher/core` with the lists, `pickRuntimeEnv`,
   `runtimeEnvNames`; unit test. Nothing uses it yet.
2. **Check `launcher:runtime-env-declared`.** Classify every current name; fix
   the list until green.
3. **Gateway `env.go` + tests.** `ChildEnv`, required `-child-env`, all five
   exec sites converted, boot log of forwarded / dropped names, dead env default
   removed. `go test ./...` in `gateway/`.
4. **Check `launcher:gateway-env-explicit`.**
5. **Starter.** `spawnGatewayDaemon` uses `pickRuntimeEnv` and passes
   `-child-env`. Docs and comments per D. `./equin build` (background).
6. **Restart + verify (user-gated).** The new contract only takes effect when the
   gateway restarts. Per the project rule the agent never runs
   `./equin start` unprompted: the user runs
   `./equin start --force`, or explicitly asks the agent to.

## Verification

- `go test ./...` in `gateway/`;
  `./equin test plugins/infra/plugins/launcher`; `./equin check`
  green. Then a negative probe: add a throwaway `process.env.SINGULARITY_PROBE`
  read and confirm the new check names it, then remove it.
- After the restart, **from an agent shell** (the original repro: this session
  has `SINGULARITY_CONVERSATION_ID` set):
  `ps eww -o command= -p <gateway, main, central, one worktree backend>`. Each
  shows only the declared names, plus `SOCKET_PATH` on backends. No
  `SINGULARITY_CONVERSATION_ID`, `SINGULARITY_PARENT_HOST`, `TMUX*`, `CLAUDE*`
  or `WARP_*`. `gateway.log` lists the dropped names at warn.
- Postgres / PgBouncer / zero-cache processes: same check on their env.
- Things that exercise the implicit dependencies (`PATH`, `HOME`, toolchains,
  keychain):
  - main and central boot; Settings → Accounts still shows connected providers
    (central reads secrets through the keychain);
  - a toolbar build from main completes, and its op-log line
    (`~/.singularity/logs/op-log/op-log.jsonl`) has no conversation id;
  - a backup run completes (`pg_dump` found on `PATH`);
  - a task title is generated (the one-shot `claude --print` path);
  - a terminal pane opens a shell with a working `PATH`;
  - a new agent conversation launches, its pane is claimed, and `query_db`
    answers from it;
  - a `./equin push` from an agent pane still reaches the remote. Git auth
    here does not depend on `SSH_AUTH_SOCK` today, since agent panes already run
    without it; this confirms it after the restart;
  - a UI "Fetch page" that needs the headless browser (browser-fetch) still finds
    chromium;
  - a release preview boots and `/api/health` names its run id. This proves the
    release relocation variables and the release identity still travel launch →
    gateway → backend.

## Follow-ups (own tasks)

- `SOCKET_PATH` → argv (`--socket`), so a backend's descendants do not inherit
  its socket. Needs the transition dance the namespace move had, because
  backends in stale worktrees read the env var.
- `run-claude-print.ts`'s `CLAUDE_CODE_*` denylist scrub becomes redundant once
  backends carry no Claude session state. Decide whether to keep it as
  defense-in-depth or delete it.
