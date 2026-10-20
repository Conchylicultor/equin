# start

`./singularity start` — ensure the gateway binary and make it the machine's
running, self-restarting gateway daemon.

A system-level host operation, run once at install. It is **not** part of the
agent workflow: agents run `./singularity build`, never this (nor `stop`).

## macOS: a launchd service

The gateway is a per-user LaunchAgent, `dev.singularity.gateway`
(`~/Library/LaunchAgents/dev.singularity.gateway.plist`, rendered by
`infra/launcher`'s `login-service.ts`). launchd starts it at every login —
which is what brings the app back after a reboot; before this the first reboot
of a fresh install looked exactly like the install had broken — and relaunches
it when it exits non-zero. Everything else follows from the gateway: its
supervisor brings Postgres / PgBouncer back up, and backends spawn on demand.

A LaunchAgent (login) rather than a boot-time LaunchDaemon because the secrets
master key is in the login keychain, locked until the user logs in.

The plist runs the compiled binary directly, with the argv and declared
environment of `gatewayLaunchSpec` — the same spec a detached spawn uses, so
the two launch paths cannot drift. Consequences worth knowing:

- **The environment is baked in** when `start` writes the plist. A change to the
  declared runtime environment (or to the PATH rule) reaches the gateway only
  on the next `start --force`.
- **Reloading is `bootout` + `bootstrap`, not `kickstart`**: launchd reads a
  plist only when it is loaded, so a rewritten job takes effect only through a
  reload. `start --force` does exactly that, and waits for the old process to be
  gone first. launchd never runs two instances of a label, so there is no
  overlapping-generation window (the routine trigger for orphaned backends).
- **The gateway writes its own pidfile** (`-pid-file`): no launcher sees a
  launchd relaunch, and `readPid()` has readers.
- **A gateway started before this existed** (detached, pidfile only) is left
  running by a plain `start`, which only registers the plist so the next login
  picks it up; `start --force` stops it and hands over to launchd now.
- Stopping is `./singularity stop` — a `kill` of a crashing gateway is followed
  by a relaunch. `stop --disable` also removes the plist.
- `launchctl bootstrap gui/<uid>` needs a GUI login session for the user; on a
  Mac nobody is logged into (bare SSH) it fails, loudly, with launchctl's error.

## Linux: a systemd user unit

The same job as a systemd **user** unit, `~/.config/systemd/user/dev.singularity.gateway.service`
(`infra/launcher`'s `systemd-service.ts`, rendered by the pure `systemd-unit.ts`),
enabled into `default.target`. Same relaunch policy as the plist. It needs
**lingering** (`sudo loginctl enable-linger <user>`, once): without it systemd
stops the user's manager — gateway, backends and agents — when the last session
closes, so `start` refuses with that fix. With it the gateway starts at boot,
nobody logged in (nothing is locked until login: the secrets key is a file on
Linux). `KillMode=process`: a stop signals the gateway alone, because every running
agent process (started detached) lives in the unit's cgroup.

`start` and `stop` drive both through one `GatewayLoginService` interface
(`gatewayLoginService()`), so the bullets above hold for systemd too (reload is
`stop` + `enable --now` after a `daemon-reload`).

## Bind address

Every interface by default. `SINGULARITY_LISTEN=127.0.0.1:9000 ./singularity start`
binds loopback only — for a server, so the agent manager is unreachable off-box
by how it was started. Only the host may change; the port stays 9000.

## Other hosts: a detached spawn

Without launchd or systemd the gateway is spawned detached, exactly as before, and does
not survive a reboot — `start` says so. `--force` first SIGTERMs the running
daemon and waits until its pid is actually gone.

## Both

The binary is the `gateway-binary` dependency (`infra/launcher/deps`, a `build`
kind of `infra/deps`): `start` runs `ensureDep(gatewayBinary, cliExecContext(),
{ root: <main checkout> })`. Its identity is main's Go source + `go version` +
the platform, so a Go change is built on the next `start` (no flag) into
`~/.singularity/cache/deps/gateway-binary/<identity>/env/gateway`, and an
unchanged one costs a hash. The plist (or the detached spawn) names that path;
`start` rewrites the plist every run, and `start --force` reloads it. It then
`holdDep`s the install as `machine-gateway`, so the daily deps sweep never
deletes the binary launchd will relaunch, however long main has moved on; the
next `start` moves the hold to the new build. A release never builds: its
launcher reads the gateway sealed into the bundle.

It waits for the gateway to actually answer before printing success, because a
gateway exits when a managed service fails to start and an unconditional
"started" line left the operator to discover that via whatever broke next.

Design: [`research/2026-09-25-global-gateway-survives-reboot.md`](../../../../../../research/2026-09-25-global-gateway-survives-reboot.md).

## Why it is not `detachable`

`detachable: true` disarms the orphan guard for commands meant to outlive their
shell. `start` is not one: what outlives the shell is the *daemon*, already
owned by launchd (or spawned detached and unreferenced). This process only builds,
hands it over, and waits —
so if the invoking shell dies, killing the readiness wait is the right outcome.
There is nobody left for it to report to, and the daemon it spawned is unaffected.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: `./singularity start` — build the gateway and register it as a per-user OS service (launchd on macOS, a systemd user unit on Linux) so it comes back after a reboot, then wait for it to actually serve before reporting success.
- Cli:
  - Uses:
    - `framework/cli/doctor.assertPrerequisites`
    - `infra/jobs/supervised-job.cliExecContext`

<!-- AUTOGENERATED:END -->
