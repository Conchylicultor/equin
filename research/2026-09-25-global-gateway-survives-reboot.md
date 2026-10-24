# The gateway comes back after a reboot (launchd LaunchAgent)

## Context

A clean-VM run (2026-09-18) with a working, deployed app was rebooted: no
gateway, no embedded Postgres, `http://singularity.localhost:9000` dead. Only a
hand-run `./equin start` brings it back, and only `docs/setup.md:49-51`
mentions it ("does not survive a reboot, so run it again after one"). To a new
user the first reboot looks exactly like a broken install.

Why: `start` (`plugins/framework/plugins/cli/plugins/start/cli/run.ts`) compiles
the gateway and calls `spawnGatewayDaemon` (`plugins/infra/plugins/launcher/server/internal/boot.ts:439`),
a plain `Bun.spawn` + `unref()` + TS-written pidfile. Nothing registers it with
the OS. Everything else already comes back once the gateway runs: the gateway is
the sole supervisor (`gateway/main.go` — orphan reconcile → `sup.StartAll`
brings up Postgres/PgBouncer from `database.json` → lazy backend spawn), and the
Postgres starter already handles an unclean shutdown (stale `postmaster.pid`,
reattach, base DB re-created — `plugins/database/plugins/embedded/scripts/start.ts:196-343`).
So the missing piece is exactly one thing: **something the OS relaunches the
gateway from**.

The deploy side already solved this the right way for Linux: a composition runs
under a systemd unit (`deploy/cli/internal/converge-script.ts:141`, `Restart=always`).
The dev host gets the macOS equivalent.

## Design

`./equin start` stops being "spawn a detached process" and becomes
**"register the gateway as a per-user launchd service, then (re)start it"**.
launchd owns the process: it starts it at login, restarts it on crash, and runs
at most one instance per label.

### 1. The launchd job (LaunchAgent, not LaunchDaemon)

`~/Library/LaunchAgents/dev.singularity.gateway.plist`, domain `gui/<uid>`.

- **LaunchAgent, not a boot-time LaunchDaemon**: the secrets master key lives in
  the user's login keychain (`plugins/infra/plugins/secrets`), which is locked
  until the user logs in; the runtime is one-instance-per-user by ADR. So the
  app comes back at *login* after a reboot (immediately with auto-login).
- `ProgramArguments`: the **gateway binary directly** (`<main repo>/gateway/gateway`)
  plus the exact argv `spawnGatewayDaemon` passes today. No bun/go needed at
  boot, no recompile per login.
- `EnvironmentVariables`: `pickRuntimeEnv(process.env)` — the same declared
  subset handed to the detached spawn today (PATH already rebuilt by
  `runtimePath` with mise shims first, so the supervised `bun run …/start.ts`
  resolves bun under launchd's minimal environment).
- `WorkingDirectory`: `gatewayDir`. `RunAtLoad: true`.
  `KeepAlive: { SuccessfulExit: false }` (crash/exit≠0 → relaunch; a clean
  SIGTERM stop stays stopped). `ThrottleInterval: 10` so a Postgres that cannot
  start does not hot-loop (the gateway exits 1 in that case, by design).
- `StandardOutPath`/`StandardErrorPath`: the existing `GATEWAY_STDIO_LOG`
  (truncated by `start` before a kickstart, as today).
- Written 0600 (the env block carries HOME/USER-level values; no reason to be
  world-readable).

### 2. One argv/env builder, two launchers

Refactor `spawnGatewayDaemon` into `gatewayLaunchSpec(opts) → { argv, cwd, env }`
plus the existing spawn (still used by the release launcher at `boot.ts:776`,
which runs under systemd and `.ref()`s it). The plist is rendered from the same
spec, so the two ways of launching the gateway cannot drift.

### 3. The gateway writes its own pidfile

Today the TS spawner writes the pidfile; under launchd a relaunched gateway
would leave it stale, and `readPid()` has real consumers
(`paths/scripts/migrate-data-layout.ts:431` "is the gateway running" guard,
preview teardown via `gatewayPidFile(root)` in `release/server/internal/preview-manager.ts`).
Add a `-pid-file` flag to `gateway/main.go`, written at boot. *As built:* it is
never removed (every reader checks liveness, and a preview's reaper reads a
missing file as "still booting"), and the detached spawn still writes it too, so
a gateway that dies before reaching that line leaves its dead pid behind.

### 4. `start`, rewritten around launchctl (darwin)

New module `plugins/infra/plugins/launcher/server/internal/login-service.ts`
(pure plist rendering in `launcher/core`, unit-tested), exposing
`installGatewayService(spec)`, `gatewayServiceState()` (`launchctl print
gui/$UID/<label>` → `not-installed | loaded-stopped | running(pid)`),
`bootstrapGatewayService()`, `bootoutGatewayService()`, `removeGatewayServicePlist()`.
*As built:* a restart is `bootout` + `bootstrap`, never `kickstart -k` — launchd
reads a plist only when it is loaded, so a rewritten job needs a reload.
All `launchctl` calls go through `spawnExpectOk` (`infra/spawn`), so a failure
throws with stderr.

`start` flow:
1. doctor, `assertSupportedHost` (unchanged).
2. `buildOrLocateGateway(forceBuild=true)`, `ensureDatabaseConfig` (unchanged).
3. Write the plist (always — so a changed argv/env/binary path takes effect).
4. If a **legacy detached gateway** is alive (pidfile/port, not launchd-owned):
   - without `--force`: leave it running, `launchctl enable` the job so it loads
     at next login, and print "registered to survive reboot; `start --force`
     hands the running gateway to launchd now". No surprise restart.
   - with `--force`: SIGTERM + existing poll-until-gone, then bootstrap.
5. Loaded and running, no `--force` → no-op, as today. Otherwise: if loaded,
   `bootout` and wait for the old pid to be gone; then `bootstrap`.
6. `awaitGatewayReady({ pid, port })` with pid read from `gatewayServiceState()`.

launchd owning the process also structurally removes the overlapping-generation hazard that
`--force`'s poll loop exists for: launchd never runs two instances of a label.

### 5. `./equin stop`

With `KeepAlive`, `kill <pid>` of a crashed-looking gateway is respawned, so a
supported stop verb is now required: `./equin stop` → `launchctl bootout`
(stops now; the plist stays, so the next login brings it back) and
`--disable` → bootout + delete the plist (opt out of auto-start). New CLI plugin
`plugins/framework/plugins/cli/plugins/stop/` next to `start`.

### 6. Non-darwin

Linux dev hosts keep today's detached spawn and `start` prints one line that it
will not survive a reboot. A `systemd --user` unit is the natural follow-up
(same `gatewayLaunchSpec`), filed as a task rather than built blind.

### 7. Docs

- `docs/setup.md`: `start` is still run once at install, but now "registers the
  gateway with launchd — it comes back on its own after a reboot/login";
  document `stop` / `stop --disable`; delete the "run it again after a reboot" line.
- `start/CLAUDE.md` + launcher `CLAUDE.md`: launchd owns the process; pidfile is
  gateway-written.
- Root `CLAUDE.md`: keep "agents NEVER run `start`", add `stop` to the same rule.

## Critical files

- `plugins/infra/plugins/launcher/server/internal/boot.ts` — split out `gatewayLaunchSpec`; stop writing the pidfile.
- `plugins/infra/plugins/launcher/server/internal/login-service.ts` (new), `launcher/core/…/launchd-plist.ts` (new, pure) + `.test.ts`.
- `plugins/framework/plugins/cli/plugins/start/cli/run.ts` — launchctl flow.
- `plugins/framework/plugins/cli/plugins/stop/` (new CLI plugin).
- `gateway/main.go` — `-pid-file` flag.
- `docs/setup.md`, `start/CLAUDE.md`, `infra/launcher/CLAUDE.md`, root `CLAUDE.md`.

Reused: `pickRuntimeEnv` / `runtimeEnvNames` / `runtimePath` (`launcher/core/internal/runtime-env.ts`),
`buildOrLocateGateway`, `ensureDatabaseConfig`, `awaitGatewayReady`, `gatewayLogTail`,
`spawnExpectOk` (`infra/spawn`), `gatewayLocks` / `gatewayLogs` data-dir declarations.

## Verification

1. Unit: plist render test (argv/env/KeepAlive/paths; round-trip through `plutil -lint`).
2. `go build` + gateway test that `-pid-file` is written and removed on SIGTERM.
3. On this Mac (user runs these — agents never run `start`): `./equin start --force`
   → `launchctl print gui/$UID/dev.singularity.gateway` shows running; app answers;
   `kill -9 <pid>` → relaunched within ~10 s; `./equin stop` → stays down;
   `./equin start` → back.
4. Clean-install VM (`sidequests/clean-install`): install per `docs/setup.md`,
   reboot the Tart VM, log in, `curl http://singularity.localhost:9000` answers
   with no manual step. (Not yet a `steps.sh` step: a step's command runs over
   the guest SSH session a reboot kills, so `run.sh` needs a reboot primitive
   first — follow-up.)
