# Linux port of the full agent-manager composition

Hosted track, Phase 1, step 1 (wiki: Hosted → "Linux port" sub-page holds the
running status). Goal: the full agent-manager composition builds, boots and runs
agents on a Linux host, with the macOS path unchanged.

## Context

Singularity's dev stack (gateway → Postgres/PgBouncer → central → backends →
tmux agent sessions) had only ever run on macOS. The self-contained `release`
already ran the *website* composition on Ubuntu, so the binaries (Go gateway,
`@embedded-postgres/linux-x64`, PgBouncer, parcel-watcher) were known to work;
the agent manager — supervision, secrets, agent sessions, worktrees, builds —
was not.

A sweep (three Explore passes, 2026-10-12) found the code already largely
platform-aware: nearly every macOS facility is behind a `process.platform` /
`runtime.GOOS` guard and degrades (sleep-clock, phys-footprint, vm_stat, QoS
boost), or already has a Linux branch (`nice` in spawn-priority, `libc.so.6` in
flock, `getent` in host-account, inotify in file-watcher, the `.so` shim in
signal-origin, `loadavg_linux.go`). The real gaps were few; the rest could only
be found by running it.

## Test host

The existing Hetzner box (Ubuntu 24.04, 4 vCPU, 7.6 GB, x86_64) that serves the
website release, isolated (approved by the user, "as long as it is truly
self-contained"):

- its own unprivileged account `sgdev` (no sudo), its own home and
  `~/.singularity` (data, Postgres on a Unix socket only — `listen_addresses=''`
  — and PgBouncer likewise);
- gateway bound to `127.0.0.1:9000` (`SINGULARITY_LISTEN`), the release is on
  `127.0.0.1:9100`; ufw only admits 22/80/443 anyway;
- `user-1001.slice`: `MemoryHigh=infinity MemoryMax=6G CPUWeight=20 TasksMax=4096`,
  so builds and agents cannot starve the website (a `MemoryHigh` below the cap,
  with no swap, throttled a build into a two-hour livelock instead of failing it);
- nothing of Caddy, ufw, `/srv/equin` or the release's unit touched; system-wide
  only `apt install build-essential` and Playwright's `install-deps chromium`.
- Browser access: `ssh -L 9000:127.0.0.1:9000`, then
  `http://singularity.localhost:9000`.

The repo is public, so the box clones it from GitHub with no credentials; a
`push` there lands on the box's local main (remotes probe), never on GitHub.

## Decisions

1. **Supervision: a systemd *user* unit, behind one service interface.**
   `infra/launcher` gains `GatewayLoginService` (`gateway-service.ts`):
   `state / write / remove / load / unload`, `manager`, `startsAt`. launchd
   (`launchd-service.ts`, the old code, unchanged behaviour) and systemd
   (`systemd-service.ts` + the pure `systemd-unit.ts` renderer) implement it;
   `gatewayLoginService()` picks by platform. `start` / `stop` drive the
   interface and name no manager. Unit policy mirrors the plist: `Restart=on-failure`
   (launchd `SuccessfulExit=false`), `RestartSec=10`, `TimeoutStopSec=20`,
   `WantedBy=default.target`, and **`KillMode=process`** — every backend's
   children (the tmux server holding all agents) share the unit's cgroup, so the
   default would kill every agent on each `start --force`.
   `load` requires lingering (`loginctl enable-linger`): without it the user
   manager — and the gateway — dies with the last ssh session. It refuses with
   the fix rather than start a gateway that will not outlive the shell.
2. **Secrets: the key file on Linux, by design; key source sticky everywhere.**
   `@napi-rs/keyring` on Linux is the Secret Service (absent/locked headless) or
   the kernel keyring (gone at reboot) — either makes the key differ between
   boots, i.e. every token lost. So Linux uses `state/secrets/.key` only. On all
   platforms: a keychain with no entry defers to an existing `.key`, and no path
   mints a key while `secrets.json.enc` exists (throws instead). macOS happy
   path unchanged.
3. **Listen address: `start` honours `SINGULARITY_LISTEN`'s host** (the one
   listen override a release already honours), so a server keeps the agent
   manager on loopback by how it was started. Port must stay 9000 (backends reach
   central at `localhost:9000`); another port is refused. Default unchanged
   (wildcard).
4. **Agent panes: the account's login shell, the toolchain on PATH.** A pane
   was a hard-coded login zsh starting from `PATH=/usr/bin:/bin:/usr/sbin:/sbin`,
   so an agent found `bun`/`claude` only if the user's profile added them for a
   NON-interactive login shell (a personal `~/.zshenv` on the dev Mac;
   `install.sh` writes `~/.zshrc`). On Linux the pane had neither. Now the pane
   runs the account's own POSIX login shell (`/bin/sh` for fish & co.) and starts
   from the toolchain PATH — mise shims (`runtimeShimsDir`, the rule backends
   get) + `claude`'s dir + the system seed. zsh is no longer a prerequisite.
5. **Linux prerequisites need one sudo, like macOS.** `install.sh` apt-installs
   git/curl/build-essential when missing, enables lingering, and after `start`
   runs Playwright's `install-deps chromium` (the layout checks launch headless
   Chromium, whose NSS/ATK/libgbm/ALSA libraries a server image lacks). The
   Chromium install itself `ldd`-checks the binary and fails naming the missing
   libraries and that command. A rootless install (libraries unpacked into the
   deps cache) is a follow-up.
6. **Host admission on a one-unit host.** On an 8 GB box the fleet `B` is 1:
   the build holds it, and the check's `./singularity deps install chromium`
   child queued host-wide behind its own parent until it timed out (alone: 20 s).
   `admitBackground` now spends an inherited grant (`inheritedGrant()`), and
   `ensureDepViaCli` requires the caller's grant (`Grant | null`), which a check
   passes. Not Linux-specific — any 8 GB machine.

## Out of scope (degrade gracefully today; sidequests)

`/proc` equivalents for phys-footprint, vm_stat swap, sleep-clock (CLOCK_BOOTTIME);
`xdg-open` for host-fs open/reveal (meaningless headless); gateway-side `nice`
for background backend starts (TS side already uses `nice -n 10`); Tauri on
Linux; inotify watch limits with many worktrees (60132 on the box).

## Verification

- Unit: `systemd-unit.test.ts` (quoting, specifiers, `$$`, policy),
  `agent-session-env.test.ts` (the wrapper executed under each available login
  shell finds the toolchain PATH), existing launchd/secrets suites green on macOS.
- On the box (done): `./singularity start` → unit loaded, enabled, gateway on
  127.0.0.1:9000 only, Postgres/PgBouncer up; the build passes every check but
  `type-check` (its worker needs 7–14 GB; killed at the 6 GB cap) and
  `layout-geometry` (1px off: the generic `monospace` font is DejaVu Sans Mono
  there, Menlo on macOS); the website on 9100 unaffected throughout.
- Not yet (needs a ≥16 GB host): a deploy, an agent launched from a task, a
  reboot. Filed as the next Hosted task.
- macOS: `./singularity build` green with all changes.
