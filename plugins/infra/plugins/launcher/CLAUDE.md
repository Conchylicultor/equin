# launcher

Brings a packaged app's whole runtime up on a bare host: gateway binary,
`database.json`, the gateway daemon, the app DB, the worktree spec. Consumed by
the release bundle's `launch` binary (`bin/launch.ts`) and, for the gateway
half only, by `./singularity start` / `stop`.

## One launch spec, two launchers

`gatewayLaunchSpec` is the one derivation of how the gateway runs (argv, cwd,
declared env, stdio log). `spawnGatewayDaemon` spawns it detached; where the host
has a service manager `./singularity start` instead renders it into a per-user
service through `gatewayLoginService()` (`server/internal/login-service.ts`), one
`GatewayLoginService` interface with two implementations — a launchd
LaunchAgent on macOS (`launchd-service.ts` + the pure `launchd-plist.ts`) and a
systemd user unit on Linux (`systemd-service.ts` + the pure `systemd-unit.ts`,
which requires lingering and uses `KillMode=process` so a restart never kills
the tmux server running the agents). That is what makes the dev gateway come
back after a reboot. `start` and `stop` name no manager. The gateway writes its own
pidfile (`-pid-file`) because no launcher sees a launchd relaunch; the detached
spawn writes it too, so a gateway that dies before getting that far still
leaves its dead pid for a preview's reaper. Design:
[`research/2026-09-25-global-gateway-survives-reboot.md`](../../../../research/2026-09-25-global-gateway-survives-reboot.md).

## The gateway binary is a dependency

`gateway-binary` (`deps/index.ts`) is an `infra/deps` `build` dependency: `go
build` of `gateway/` (every `.go` file + `go.mod` / `go.sum`, `go version`, the
target), cached at `~/.singularity/cache/deps/gateway-binary/<identity>/env/gateway`.
There is no `<repo>/gateway/gateway` any more. `GatewayLaunchOptions.gateway`
and `bootSelfContainedApp({ gateway })` take its `Ready`, so a launch that never
ensured the binary does not compile; argv[0] is `builtFile(ready)` and the cwd
is the install dir (every path the gateway reads is a flag).

- `./singularity start` ensures it from the MAIN checkout and holds it
  (`holdDep(…, "machine-gateway")`) so the deps sweep never deletes the binary
  the launchd plist names; `serve-app` ensures it from its `--repo-root`.
- A release seals it (`bundle: "required"`, `targets: "any"` — cgo on for a
  darwin target, off for linux) into `<bundle>/deps/gateway-binary/` with
  `deps.sealed.json`; `bin/launch.ts` reads it through
  `bundledGateway(bundleRoot)` (a `readyNow` against the bundle root — no Go,
  no source, nothing built).

## Boot ordering

`bootSelfContainedApp` is a strict sequence and each step exists to gate the
next — the numbered docstring on it is the spec. Two orderings are load-bearing
and easy to break:

- **The worktree spec is written LAST**, after the DB exists. The gateway's
  fsnotify watcher spawns the backend the moment it sees the spec, so writing it
  earlier races the backend's boot migrator against DB creation.
- **`assertSupportedHost()` runs before anything is read, written or spawned.**
  It is the home for host preconditions — facts about the machine that are
  knowable in microseconds but whose violation surfaces minutes later as an
  unrelated downstream symptom. Today: refuse to run as root, because `initdb`
  does. Add new preconditions there rather than letting them be rediscovered at
  runtime.

## Why the launcher waits on the gateway process, not on Postgres

It used to spawn the gateway detached and then poll the PG socket. When a
managed service failed to start, the gateway logged the exact cause
(`initdb: error: cannot be run as root`) into a file nobody was reading and kept
serving; 90 seconds later the launcher reported `connect ENOENT
/tmp/sgs-…/.s.PGSQL.5433` — a different vocabulary, in a different file, that
actively misdirects.

The gateway now exits when a managed service fails to start, and `StartAll`
precedes `ListenAndServe`. So **"the gateway is listening" implies "every
managed service came up"**, which makes `awaitGatewayReady` the single gate for
the entire stack's startup. It checks `isRunning(pid)` on *every* poll tick and
throws immediately — with the tail of `gateway-stdio.log` embedded in the
message — rather than waiting out its deadline.

`gateway-stdio.log` specifically, because `spawnGatewayDaemon` opens it `"w"` (and
`start` empties it before loading the launchd job, which only appends):
it is truncated on every start, so its tail is unambiguously *this* boot's
output, and the gateway writes its fatal start error to stderr precisely so it
lands there. The rotating `gateway.log` is the fallback only — it holds prior
sessions too.

`awaitPgReady`'s deadline path covers the one case that gate cannot: the gateway
came up and PG died *afterwards*. That is a watchdog concern the gateway
deliberately survives (killing it would tear down every live backend over a
transient blip), so the launcher asks
`GET /gateway/services/postgres/status` for the supervisor's recorded `error`
and appends it. Design:
[`research/2026-07-29-global-gateway-fail-loudly-on-service-start-failure.md`](../../../../research/2026-07-29-global-gateway-fail-loudly-on-service-start-failure.md).

## What a boot re-installs from the bundle, and what it must never touch

A deployed host's data dir outlives every deploy — that is what makes the DB and
the user's own settings survive a ship. So anything the launcher installs
"on first run" is, in practice, installed **once, ever**, and the app then serves
that forever no matter what later bundles contain.

`propagateReleaseConfig` is the boot step where that distinction is drawn, and
it is drawn per file, not per directory. config_v2's three-layer model already
says who owns what:

- `<name>.origin.jsonc` — build-owned. Rewritten from the bundle on **every**
  boot, and deleted when the bundle no longer ships it.
- `<name>.jsonc` — the user's own override. Never written, never deleted.
- `<name>.ancestor.jsonc` — written only at the conflict transition, exactly as
  `propagate()` does it, so the settings UI can still offer a three-way Merge.

It was one `existsSync(dest)` over the whole config dir, which conflated the two
layers. The failure is silent by nature, which is why it is worth a section: a
per-app theme scope that never materializes reads as "no scope", and a reorder
directive naming a contribution that no longer exists just falls back to load
order. Nothing throws. The deployed app is simply a different app than the one
that was built. Any future "install this from the bundle" step belongs beside
this one, with the same question answered first: is this layer the build's or
the user's?

## What the runtime tree carries

The runtime tree is the gateway and everything it starts: every backend (main,
central, each worktree) and Postgres / PgBouncer. It
starts from a **declared** environment, never from whoever started it. (It used
to inherit: `./singularity start` from an agent shell put that shell's
`SINGULARITY_CONVERSATION_ID`, `TMUX` and `CLAUDE_*` into every backend on the
host, so their builds' op-log records and commits named one agent's
conversation.)

The declaration is `core/internal/runtime-env.ts`, a leaf with no imports:
host facts (`RUNTIME_HOST_ENV`), the `SINGULARITY_*` installation settings every
backend must see (`RUNTIME_FORWARDED_ENV`, each with a reason naming its
reader), forwarded name prefixes (`SINGULARITY_AUTH_`), third-party tool
locations (`RUNTIME_FORWARDED_TOOL_ENV`), and the `SINGULARITY_*` names that
must **never** be inherited, each with who delivers it instead
(`RUNTIME_WITHHELD_ENV`). An allowlist on purpose: what a starting shell may
carry is an open set, so a list of bad names only catches the last leak found.

Two boundaries, one declaration:

1. **Starter → gateway.** `gatewayLaunchSpec` sets
   `pickRuntimeEnv(process.env)` — for the detached spawn, and baked into the
   launchd plist on macOS dev hosts (so a change reaches that gateway on the
   next `start --force`). It filters the **live** `process.env`, so the
   release launcher's mutations (`launch.ts`'s relocation variables, the release
   identity `bootSelfContainedApp` stamps) still arrive — each is a forwarded
   name. Every launch path (`./singularity start`, the release `launch` binary,
   and through it the desktop app, the preview manager, systemd) goes through
   this one function.
2. **Gateway → every child.** It also passes the required
   `-child-env <runtimeEnvNames().join(",")>` (prefixes spelled `NAME_*`). The
   gateway holds no list of its own; it forwards only those names, plus its
   per-child additions. A backend's socket path is
   not one of them: it travels on argv (`--socket`). See `gateway/CLAUDE.md`.

`PATH` is the one forwarded name not passed through verbatim.
`runtimePath(env)` strips mise's **resolved per-version** tool directories
(`…/mise/installs/<tool>/<version>/bin`) out of it and puts the shims **first**,
so the runtime tree re-resolves its tools per invocation from the committed
`mise.toml` + `mise.lock`. First, because a PATH that lists `/opt/homebrew/bin` or
`~/.cargo/bin` ahead of the shims runs Homebrew's tmux and rustup's default rust
whatever the lock says. It takes the whole environment, not a PATH string: the
shims directory is an explicit `…/mise/shims` entry if PATH has one, else derived
from a stripped install dir, else located from the environment by mise's own
order (`MISE_DATA_DIR`, `XDG_DATA_HOME/mise`, `~/.local/share/mise`). So a starter
whose shell never ran `mise activate` (a fresh machine, a service unit) still
hands the runtime mise's tools — before this, its PATH passed through unchanged
and tmux / rustc were simply missing. `runtimeShimsDir(env)` names the directory
it chose.
A shell with mise activated puts those resolved directories ahead
of the shims — right for a shell, re-activated per directory; wrong for a daemon
that snapshots PATH once and spawns backends against it for weeks. That is how
every backend on this host ran Bun 1.3.13 (a symlink resolved in May 2026) long
after `mise.toml` could have said otherwise, and Bun 1.3.13 closes pooled
Postgres sockets out from under live queries. Backends pick up a `mise.lock` change on
their next restart; a change to this PATH rule itself needs `./singularity start --force`
to reach the already-running gateway.

A shim resolves from its **cwd**, so the shims alone are not enough. With no
`mise.toml` above the directory a tool runs in, mise runs the next non-mise copy
on PATH (Homebrew's tmux, unlocked) or, with none, fails:
`mise ERROR No version is set for shim: bun`. So each backend and central pins
its own checkout at boot — `toolchainPin()` (paths/core), i.e.
`MISE_GLOBAL_CONFIG_FILE=<checkout>/mise.toml`, plus a re-normalised
`runtimePath` PATH, on its own `process.env`
(`server-core/bin/pin-toolchain.ts`, `central-core/bin/index.ts`). The PATH half
matters because the shim that launched the backend prepended its resolved
`…/mise/installs/…/bin` dirs again; left in place, every build the backend
spawns would run its boot-time Bun, so a `mise.lock` bump could never pass
`bun-runtime` and restart it (2026-10-12). mise reads
the global config and the `mise.lock` beside it only when the walk finds no
local config, so inside a checkout nothing changes, and anything the backend
spawns from `/tmp` or `~/.singularity/…` gets that checkout's locked release. The
starter's own `MISE_*` never travels. A release has no checkout and pins nothing
(it spawns no mise tool). `toolchain:resolved` re-measures the pin from a temp
dir on every build, since it rests on mise's semantics rather than ours.

**Adding a variable:** write the reader, then run `./singularity check`.
`launcher:runtime-env-declared` fails on any `SINGULARITY_*` name that code
reads or sets (TypeScript under `plugins/`, gateway Go, git hooks, desktop
Rust — comments and lint rules are not scanned, since they read nothing) that
is not forwarded, withheld or under a forwarded prefix, and asks: *should a
backend inherit this from whoever starts the gateway?* Yes →
`RUNTIME_FORWARDED_ENV`; no → `RUNTIME_WITHHELD_ENV`. The yes case is the one
that bites: a relocation variable set in `launch.ts` but not forwarded silently
never reaches the backend, which reads its dev default in a release only. It
also fails on a listed name no code uses any more — delete that entry. A
non-`SINGULARITY_*` variable goes in `RUNTIME_FORWARDED_TOOL_ENV`; nothing
checks for those.

`launcher:gateway-env-explicit` keeps the second boundary shut: outside
`gateway/env.go`, no non-test Go file may call `os.Environ()`,
`exec.Command(Context)()` or `os.StartProcess()` — a command with a nil `Env`
inherits everything.

`launcher:per-process-env-on-argv` keeps a value that belongs to ONE process
out of the environment. A backend's socket path is the case today: it travels
as `--socket`, and the old `SOCKET_PATH` name may not appear in code at all
(tests excepted). Deleting the variable from `process.env`
after reading it would not stop the leak: a Bun child with no explicit `env`
receives the environment its parent started with. A future value moving onto argv can
list transition sites that may still name its variable; the check reports a
listed site that no longer does, so the list goes when the transition code does.

`pickHostEnv(source)` is the narrow sibling of `pickRuntimeEnv`: only the host
facts (`RUNTIME_HOST_ENV`), for a third-party tool the runtime starts. The
one-shot `claude --print` (`infra/claude-cli`) runs under it.

Design: [`research/2026-09-15-global-declared-runtime-environment.md`](../../../../research/2026-09-15-global-declared-runtime-environment.md).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Boots and tears down the self-contained stack (Go gateway, embedded Postgres, PgBouncer) for ./singularity start, serve-app and the release launcher, and keeps the gateway's launch spec in one place. In a running backend it attaches the gateway it runs behind as a long-lived process in Background activity.
- Server:
  - Uses:
    - `database/admin.ensureDatabase`
    - `database/admin.getAdminPool`
    - `database/embedded.PG_PORT`
    - `database/embedded.PG_SOCKET_DIR`
    - `database/embedded.PG_USER`
    - `database/embedded.pgPostmasterPidFile`
    - `database/pgbouncer.PGBOUNCER_PORT`
    - `database/pgbouncer.PGBOUNCER_SOCKET_DIR`
    - `database/pgbouncer.pgbouncerPidFileUnder`
    - `infra/asset-mirror.seedAssetMirrorCache`
    - `infra/paths.ReleaseIdentity`
    - `infra/paths.setReleaseIdentity`
    - `infra/paths.worktreesDir`
    - `infra/spawn/daemon.defineDaemon`
    - `infra/worktree.writeWorktreeSpec`
  - Exports (types):
    - `GatewayLaunchOptions`
    - `GatewayLoginService`
    - `GatewayServiceState`
    - `ListenAddress`
  - Exports (values):
    - `assertSupportedHost`
    - `awaitGatewayReady`
    - `awaitPgReady`
    - `awaitProcessGone`
    - `bootSelfContainedApp`
    - `bundledGateway`
    - `ensureDatabaseConfig`
    - `GATEWAY_SERVICE_LABEL`
    - `gatewayLaunchSpec`
    - `gatewayLoginService`
    - `gatewayPidFile`
    - `hasPgBouncerPackage`
    - `isGatewayListening`
    - `isRunning`
    - `LISTEN_ENV`
    - `listenFlag`
    - `pgbouncerConnection`
    - `pgbouncerService`
    - `propagateReleaseConfig`
    - `readPid`
    - `resolveListenAddress`
    - `seedReleaseAssetMirror`
    - `spawnGatewayDaemon`
    - `teardownSelfContainedApp`
    - `terminateProcess`
    - `writeReleaseDatabaseConfig`
  - Register: `defineDaemon('launcher.gateway')`
- Deps:
  - Uses:
    - `infra/deps.defineDep`
    - `infra/deps.DepTarget`
    - `infra/deps/build.build`
  - Exports (values): `gatewayBinary`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
  - Imported by: `release`
- Exemptions:
  - Exempts itself from:
    - `paths:data-root-not-joined` — `bin/launch.ts` (sanctioned)
    - `marker-scan-safety/no-adhoc-marker-scan` — `check/internal/strip-comments.ts` (sanctioned)
    - `spawn-safety/no-raw-bun-spawn` — `server/internal/boot.ts` (sanctioned)
- Core:
  - Exports (values):
    - `isRuntimeEnvName`
    - `pickHostEnv`
    - `pickRuntimeEnv`
    - `RUNTIME_FORWARDED_ENV`
    - `RUNTIME_FORWARDED_PREFIXES`
    - `RUNTIME_FORWARDED_TOOL_ENV`
    - `RUNTIME_HOST_ENV`
    - `RUNTIME_WITHHELD_ENV`
    - `runtimeEnvNames`
    - `runtimePath`
    - `runtimeShimsDir`

<!-- AUTOGENERATED:END -->
