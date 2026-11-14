# Zero-wait site deploys: swap the backend, keep the gateway and Postgres up

Status: **design, awaiting approval** (D15 a: design first, then build).
Follow-up of report-1794450182-hykohj (empty 502 during a ship, fixed by
Caddy's `lb_try_duration` hold).

## Context

The website box (`equin@website`, Hetzner, `49.13.197.105`) runs one systemd
unit whose tree is `app` (self-extractor) → `launch` → Go gateway → backend,
with Postgres and PgBouncer as daemons inside the same cgroup. `./equin deploy
ship` flips `current` and runs `systemctl restart`, so the old install is gone
before the new one listens. Caddy now holds visitors' requests across the gap
instead of answering 502, but every request still **waits** the gap, and a
write in flight on the stopping process can still fail.

Goal: the Mac's model on the box — gateway and Postgres stay up; a ship swaps
only the backend through the gateway's hot restart (`gateway/worktree.go`
`Restart`: new backend up and ready before the old one stops). A release that
changes the gateway or Postgres itself still restarts the host, loudly.

## Measured (real box, journal + gateway log, 2026-11-12/13)

Eight restarts. Six were ships, and each one re-extracted the bundle. Two were
restarts with nothing to extract.

| phase (ship, median of 6) | time |
|---|---|
| SIGTERM → unit stopped | 0.1–0.2 s |
| unit started → launcher's first line (**self-extraction of the ~200 MB bundle**) | **3.5–4.7 s** |
| gateway spawned → gateway serving (Postgres + PgBouncer start, listeners) | 0.7 s |
| gateway serving → backend ready | 0.9–1.4 s |
| **SIGTERM → serving** | **5.7–6.8 s** |

On a restart with nothing to extract, SIGTERM to serving took 2.2 s.

- **The largest cost is extraction, and it is avoidable even in today's
  layout.** `activate-script.ts` moves the extraction cache aside *before*
  `systemctl restart`. So every ship extracts the bundle after the old process
  has already stopped.
- **The KillMode suspicion is confirmed.** The unit template that
  `converge-script.ts:unitTemplate()` renders sets no `KillMode`, so
  `control-group` applies. On the 17:14:29 ship, systemd signalled every process
  at once. This is the order the logs show:
  - The backend's Postgres sessions died first ("terminating connection due to
    administrator command" / UNLISTEN EPIPE).
  - Only then did the backend log its own "SIGTERM received".
  - The gateway's "backend stopped" came 45 ms after its shutdown began.

  So the gateway's ordered drain never ran, and the backend shut down against a
  dead database. It could not write its live-state handoff row, and a write it
  had in flight failed against a closed connection. Separately, the launcher's
  own teardown sends **SIGQUIT** to Postgres (`boot.ts:1022`, "the cluster is
  thrown away"). That is an immediate shutdown, so every launcher-driven stop
  sends the box's *persistent* production cluster through crash recovery.
- The unit has no `TimeoutStopSec`, so the default of 90 s applies. The
  gateway's budget (15 s) and the Caddy hold comment both assume the dev unit's
  20 s.

## The blocker is the restart, not the unit

The gateway already spawns the backend from `spec.json` (`command`, `server`,
`web`) and already supports `POST /gateway/worktrees/<name>/restart` in a
release, because the route is not gated. Nothing structural requires one unit
per release: Postgres's data dir is outside the release dir, and the backend is
a child the gateway can replace. Two things stop a hot swap today.

1. **The backend's code paths are set by the old launcher's environment.**
   `launch.ts` sets `MIGRATIONS_DIR`, `WEB_DIST`, `PG_CLIENT_BIN_DIR`,
   `PARCEL_WATCHER_NODE`, `SENTINEL_WORKER_JS`, `FORK_MEMORY_WORKER_JS` and
   `REPO_CONFIG_DIR` from *its own* bundle root. The gateway forwards them to
   every backend it spawns. A new backend would therefore run release N+1 code
   against release N's migrations, web tree and workers. This is the real
   coupling.
2. **Ship restarts the unit** instead of asking the gateway to swap.

So the unit layout keeps **one host unit**. That is the same shape as the Mac,
where one login service holds the gateway and Postgres/PgBouncer are daemons
it reattaches. The unit is **restarted only when the host generation changes**.
Splitting Postgres into its own unit would take it out from under the gateway's
supervisor, which the Mac does not do, and it would buy nothing a ship needs.

## Design

### 1. A backend finds its own release, never the launcher's

Every bundle-relative path a backend reads derives from **its own executable**:
`releaseBundleRoot() = dirname(process.execPath)`. The compiled `server` sits at
the bundle root, the same rule `launch` already uses for itself. The seven names
above leave `RUNTIME_FORWARDED_ENV` and the launcher's `setEnvDefault` list.
Their readers (migrations runner, web-dist readers, pg-client, file watcher,
sentinel and fork-memory workers, raw config tree) call the one helper in
`infra/paths` when `isRelease()`.

This is rung 1: no environment can disagree with the binary any more. The
`launcher:runtime-env-declared` check then stops anyone re-adding them as
forwarded names.

`PG_BIN_DIR`, `PGBOUNCER_BIN`, `PG_SOCKET_DIR`, `SOCKETS_DIR` and `DIR` stay as
they are. They belong to the *host generation*: the gateway and the daemons it
supervises.

### 2. The gateway commits a spec only when its backend is ready

Extend the existing restart route instead of adding a second mechanism:
`POST /gateway/worktrees/<name>/restart` with an optional JSON body
`{ spec }`.

- With a body, `Restart` runs on the **candidate** spec.
- On ready, the swap commits the spec in memory and writes `spec.json` (the
  gateway becomes the spec's single writer for this call).
- On failure, both stay as they were.

This closes two windows that today's write-the-file-then-POST order leaves
open:

- `RefreshSpec` makes a new `web` live *before* the new backend is ready, so
  the old backend serves the new HTML.
- A failed restart leaves `spec.json` naming the failed build. On the box, the
  idle sweep stops the backend roughly every 2 h, and the next request
  cold-starts *whatever the spec names*.

The build (`build/cli/internal/deploy-namespace.ts` `restartBackend`) moves to
the same body form. The client (`restartBackend({ gatewayOrigin, namespace,
spec })`, with no more hardcoded `localhost:9000`) moves into a shared core
that both the build and the launcher import. That makes it one path on both
hosts.

### 3. Host generation and the swap verb

At boot, the launcher writes `data/state/host-generation.json`:

- `extractDir`: the bundle the gateway and daemons run from.
- `key`: a digest of the gateway binary, the pg and pgbouncer native trees, the
  generated `database.json` and the gateway's launch flags and forwarded env.

The digest function is shared with `launcher/gateway-drift`'s launch-key
comparison where that fits.

A new launcher verb, `launch swap`, runs from the **new** release's extract dir
and does the following:

1. Computes its own host key. If it differs from `host-generation.json`, it
   exits with code 3 and the reason ("gateway changed", "postgres changed", and
   so on).
2. Runs the per-release launcher work that is not host-level:
   - propagate config origins;
   - `ensureDatabase`, which is a no-op.
3. Calls `restartBackend` with the new spec: `command=[<new>/server]`,
   `server=<new>`, `web=<new>/web`.
4. Prints the gateway's answer.

The new backend boots while the old one serves. When the new one is ready, the
gateway re-points the proxy. `drainAndStop` then waits up to 30 s for the old
backend's in-flight HTTP to finish and SIGTERMs it, with Postgres alive. That
means the old backend's handoff row gets written. WebSockets are cut and
reconnect, as on the Mac.

### 4. Ship's activate script

1. Upload, then **extract up front** while the old backend still serves. The
   extractor gets `EQUIN_EXTRACT_ONLY=1`, which extracts and prints the dir.
   This also removes ~4 s from the host path below.
2. Run `"$EXTRACT/launch" swap`.
   - **Hot path (exit 0).** Run the existing gate: ready, the shipped `runId`,
     `settle_gate` on the new `startedAt`, secrets readable. On pass, flip
     `current` so a later crash or reboot boots the same release, then prune.
   - **Host path (exit 3).** Print it loudly: `[host restart] <reason>:
     visitors wait ~2 s`. Then flip, run `systemctl restart`, and gate. This is
     today's path, but pre-extracted and with an ordered stop (§5).
3. **Pruning** keeps the extract dirs of the host generation (whose gateway and
   Postgres binaries are running), `current` and the previous release (for
   rollback). It deletes the rest. The cache is no longer moved aside before
   the swap.

### 5. Host restarts become ordered, and Postgres stops cleanly

- Unit template:
  - `KillMode=mixed`: SIGTERM goes to the main process only, and the rest of
    the cgroup is SIGKILLed only after the main process exits or on timeout.
  - `TimeoutStopSec=45`: gateway 15 s, plus the launcher's 10 s wait, plus a
    Postgres fast shutdown, plus margin.
  - Caddy's hold comment is corrected to match.
- The self-extractor spawns `launch` asynchronously and **forwards
  SIGTERM/SIGINT**, then exits with the child's status. Today it blocks in
  `spawnSync`, so under `mixed` it would die without forwarding and the rest of
  the tree would be SIGKILLed.
- Launcher teardown stops Postgres with **SIGINT (fast shutdown, with a
  checkpoint)** whenever the cluster persists, which is every release. SIGQUIT
  stays only for throwaway preview clusters.

### 6. Migrations across two live backends

No new mechanism is needed. This is the deferred-contract design main already
runs (`research/2026-10-28-database-deferred-contract-phase.md`):

- The new backend applies expand plus the claimed data migrations at boot while
  the old one serves.
- An expand that fails fails the boot, so the gateway keeps the old backend and
  the visitor sees nothing.
- The contract waits in `onReady` until no older-generation session holds its
  advisory lock. That happens when `drainAndStop` ends the old backend, up to
  about 30 s later.
- A boot that migrated skips the live-state handoff and fully reloads. That
  costs the new backend time, not visitors.

### 7. Rollback

| failure | what visitors see | what happens |
|---|---|---|
| new backend never ready / exits before ready / expand fails | nothing | gateway keeps old backend, spec uncommitted, `current` untouched, ship exits 1 |
| ready, then dies before settle, wrong `runId`, unreadable secret | WS reconnect | activate calls `restartBackend` with the **previous** spec (hot, zero wait); if that fails too, today's undo (flip back + unit restart) |
| host path failure | ≤ the restart gap | today's undo, unchanged |

Caveat, unchanged from today: if the new backend's contract already ran before
it died, the old code meets a contracted schema. Expand/contract makes this
narrow (the contract runs last, after the old process is gone). It is not new
to this design.

## Will the host path be rare?

It is not rare enough to call it zero yet:

- `gateway/` saw **39 commits in 30 days** (about 1.3 per day).
- The box was shipped about 7 times in 2 days.
- So a ship whose gateway digest changed is common: any ship that follows a
  gateway commit.

With this design, such a ship waits ~2 s instead of ~6 s, and every other ship
waits 0 s.

**Can the gateway hand its socket over? Not today.** There is no
`SO_REUSEPORT`, `LISTEN_FDS` or fd passing in `gateway/`, and a stopping gateway
kills its backends.

The way to zero on that path is a **gateway handover**:

1. A new gateway binds the same port alongside the old one (`SO_REUSEPORT`).
2. It reattaches the live backend, as it already reattaches Postgres and
   PgBouncer.
3. The old gateway stops accepting, drains, and exits *without* stopping
   backends.
4. The backend swap above then runs through the new gateway.

That benefits the Mac too, where every gateway follow currently cold-starts
every backend. Proposed as **the next task** after this one lands, and not part
of this build.

## Files to change

- `plugins/infra/plugins/launcher/bin/launch.ts`: drop the seven bundle-relative env defaults; add `swap`; write `host-generation.json`.
- `plugins/infra/plugins/launcher/plugins/env-names/core`: remove the names from `RUNTIME_FORWARDED_ENV`.
- `plugins/infra/plugins/paths`: `releaseBundleRoot()`; readers of the seven names switch to it (found by grep on each name).
- `plugins/infra/plugins/launcher/server/internal/boot.ts`: Postgres fast shutdown for persistent clusters; host-generation write.
- `plugins/framework/plugins/cli/plugins/release/cli/run.ts`: the extractor's async spawn with signal forwarding; `EQUIN_EXTRACT_ONLY`.
- `gateway/proxy.go`, `gateway/registry.go`, `gateway/worktree.go`: restart with candidate spec, committed on ready (+ tests beside the existing restart tests).
- `plugins/framework/plugins/cli/plugins/build/cli/internal/deploy-namespace.ts`: the shared `restartBackend` with spec body.
- `plugins/framework/plugins/cli/plugins/deploy/cli/internal/activate-script.ts`: extract first, swap, the hot/host branches, previous-spec rollback, pruning (+ test).
- `plugins/framework/plugins/cli/plugins/deploy/cli/internal/converge-script.ts`: `KillMode=mixed`, `TimeoutStopSec` (+ test). Converge's restart gate applies the unit change once.
- The deploy and launcher `CLAUDE.md`s and `gateway/CLAUDE.md` (§ release hosts).

## Verification

1. Run `./equin test` on the touched plugins and `go test ./...` in `gateway/`,
   including a gateway test that a failed candidate leaves the spec and
   `spec.json` unchanged.
2. Build locally. The Mac's build must still hot-restart through the new body
   form.
3. Converge the box once. This is the one loud restart that installs the new
   unit; it now shows the ordered stop in the journal: drain, then "backend
   stopped", then Postgres "fast shutdown", with no "administrator command"
   errors before the backend's own SIGTERM.
4. **Run a ship under load.** A load script on the Mac drives `https://equin.ai`
   during the ship: page GETs, `/api/health`, and one public write route, about
   20 requests per second. It records every request's status and latency.
   - Pass: zero non-2xx answers, zero requests over the baseline p99 + 200 ms,
     and the journal shows no unit restart.
   - Also ship one release that differs in its gateway: it must take the host
     path, say so, and stay at about 2 s or less.
5. Report the before/after gap from the same journal fields as the table above.

## Outcome (built and verified on the website box, 2026-11-14)

Load probe: 6 workers against `https://equin.ai`, each cycling a page GET, a
`/api/health/ready` GET and an invalid analytics POST. The POST is answered
400 by the backend and writes nothing. Baseline p99 was ~180–250 ms.

| deploy | requests in window | failed | worst wait |
|---|---|---|---|
| before: a ship (journal, 6 ships) | — | — | 5.7–6.8 s SIGTERM → serving |
| ship, swap path | 590 | **0** | **189 ms** (baseline; no restart) |
| host restart, ordered stop + pre-extracted | 524 | **0** | 1.85 s |

What the build found beyond the design:

- **Stale spec at a host restart.** The gateway loads the previous boot's
  `spec.json` and cold-starts a backend from it on the first request, before
  the launcher rewrites it. After a ship, that spec names the previous release.
  - The first host-path ship hit this: the stale backend (an old-launcher spec
    with no `env`) crashed, and the namespace answered 502 for 16 s. That
    window holds 381 failed API requests and report-1794450182-hykohj's
    regression.
  - Fix: `bootSelfContainedApp` refreshes an existing spec before the gateway
    starts. A spec on disk means a previous boot got past `ensureDatabase`.
- **One-time transition.** The first two unit restarts after installing
  `KillMode=mixed` ran the old self-extractor, which does not forward signals.
  It exited on SIGTERM, and systemd SIGKILLed the rest of the old tree,
  Postgres included. Postgres recovered from WAL in 0.3 s. Every release from
  this one on forwards the signal.
- **Release tooling.** `release`'s foreign-natives `bun install` ran in a
  staging dir outside the checkout, where the mise shim refuses. It is now
  pinned with `toolchainPin()`.
