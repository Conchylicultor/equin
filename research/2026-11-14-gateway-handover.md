# Gateway handover: a gateway update never makes a request wait or fail, and never cold-starts a backend

Status: **step 1 built** (D21: the keeper; connection passing deferred to a follow-up only if measured necessary). See § Built (step 1) at the end — it supersedes the design where they differ. Follow-up of
`research/2026-11-14-global-zero-wait-site-deploys.md` § "Will the host path be rare?".

## Context

Since zero-wait site deploys, a ship that changes only the backend swaps it through the
running gateway: 0 failed requests, worst wait 189 ms. A ship that changes the **gateway**
still takes the host path (`launch swap` exits 3, then `systemctl restart`). Under load that
was 0 failed requests and a **1.85 s** wait, with every backend cold-started. `gateway/` had
39 commits in 30 days, so this path is common.

On the Mac, every main deploy that changes the gateway runs `followMainGateway`, which
`launchctl bootout` + `bootstrap`s the login service. Every backend is SIGTERMed by the old
gateway's `StopAll` and cold-starts on its next request (main ~4–10 s, central eagerly). Every
open tab's sockets drop. Requests that arrive in the gap find the port closed.

**Goal:** one mechanism on both hosts. A gateway update:

- leaves the listening port open the whole time (no refused connection, no wait);
- lets every in-flight HTTP request finish;
- keeps every WebSocket open;
- keeps every running backend running (same process, no cold start).

## Root cause: what dies with a gateway process today, and why

A gateway process today holds five things whose lifetime is tied to its pid.

| held by the gateway pid | why it dies with it |
|---|---|
| the supervisor's main process (launchd's program on the Mac; on the box, the child `launch` waits on) | launchd runs one instance of a label, and the job ends when its program exits. `launch` tears the whole unit down when its gateway exits (`launch.ts`: `stop("Gateway exited …")`) |
| the listening sockets | `net.Listen` in `listenAll`; nothing can pass them on |
| **parenthood of every backend** (Setpgid children, `cmd.Wait`, stderr pipes) | only a parent can `wait` for a backend's exit status (crash reports, crash loops). The backend's own escape hatch (`server-core/bin/serve.ts:415`) exits when it is reparented to pid 1. macOS has no subreaper, so orphans always go to launchd |
| proxied connections (HTTP in flight, idle keep-alive, hijacked WebSockets) | goroutines and fds of this process |
| in-memory lifecycle state (phases, held, broken, crash loops, deploy edges) | memory |

So the successor cannot simply bind the same port. Even with `SO_REUSEPORT` it would still not
own the backends (no exit status, and the escape hatch kills them). It would not be launchd's
program. Closing the old listener would also reset the connections queued in *its* accept
backlog: Linux spreads connections across `SO_REUSEPORT` listeners, and a closed listener's
queue gets RSTs.

**Re-executing in place** (same pid, so launchd and systemd see nothing) keeps the parent
relationship and the listeners. But nothing can serve during the exec, and in-flight HTTP
exchanges cannot cross an `execve`. Every request in flight would have to drain first, and
new connections would queue for the whole drain. Agents' MCP calls through the gateway can
run for minutes. So that is a wait, not a handover.

The structural fix is to **separate what must outlive a gateway generation from the gateway
itself**: the pid the supervisor watches, the listening sockets, and parenthood of
long-lived children. A tiny, rarely-changing process holds those three things. The gateway,
which is everything that changes (routing, proxying, lifecycle policy, statics, reports),
becomes a replaceable child of it.

## Design

### 1. The keeper: one stable process per host

There is a new binary, `gateway-keeper`, in its own Go package `gateway/keeper/`, built as its
own `infra/deps` build dependency (`gateway-keeper-binary`). Its identity is its own sources
only, so a gateway change does not change the keeper. It is the supervised program everywhere:

- **Mac:** the launchd job's `ProgramArguments` are `[keeper, -listen loopback:9000,
  -launch-file <state>/gateway/launch.json, -stop-budget 15s]`.
- **Box:** `launch` spawns the keeper where it spawned the gateway. The unit, `KillMode=mixed`
  and the self-extractor's signal forwarding are unchanged.

The keeper does five things and nothing else (target: under 400 lines, no imports beyond the
Go standard library and `x/sys/unix`):

1. **Binds the listening sockets once**, with today's `listenAddrs` rules. They are never
   closed while it runs. Every gateway generation receives *dups* of them, so closing one
   generation's copy never closes the socket or drops its backlog.
2. **Spawns gateway generations** from the launch file, which holds the gateway binary, argv
   and env (values included; mode 0600, like the plist and unit env file that hold them
   today). A generation gets the listener fds (fd 3…) and one end of a control socketpair.
3. **Spawns long-lived children on a generation's behalf**: backends and main-deploy runs.
   The generation sends argv, env, dir, Setpgid, its own pipe write ends (SCM_RIGHTS) and an
   opaque **tag** (JSON: worktree, socket path, startedAt, executable, checkout, demoted).
   The keeper forks and execs them, closes its copies of the write ends and answers with the
   pid. The keeper `wait4`s every child and sends `{pid, wait status}` to the current
   generation, buffered while none is connected. It also keeps a dup of each child's
   stdout/stderr **read ends** (it never reads them), so a later generation can be handed
   them.
4. **Runs the handover** (§2), and commits the launch file only once the new generation has
   taken over. That is the same "commit on ready" rule as `{spec}` restarts, so a keeper
   restart (reboot, crash) boots the last gateway that worked.
5. **Forwards SIGTERM/SIGINT** to the current generation, waits for it within the stop
   budget, then exits.

**Exit statuses are not lost.** Backends' parent is the keeper, which is stable, so every exit
still has its exit status (`backend-crash`, `backend-exit`, crash loops). The backend's ppid
escape hatch keeps its meaning: it fires only when the keeper itself is gone, which means
the whole service is gone.

A backend is still spawned the way it is today (`backendLaunch`, `taskpolicy -b` wrapper,
`--socket`, declared env). Only the `fork/exec` moves behind the keeper. `env.go` stays the one
file that names `exec.Command` and `os.Environ()`: the keeper-spawn call replaces its backend
`exec.Command`, and `launcher:gateway-env-explicit` covers the new call site. Supervised
service start commands and log relays stay gateway-run. They are short-lived or `setsid`
daemons that already outlive a gateway, and are reattached as today.

### 2. The handover protocol

The trigger is `POST /gateway/handover {"launch": {binary, argv, env}}` (owner only, like every
mutating `/gateway/*` call). It answers when the new generation serves, or with the reason
it did not. The steps are below; G is the old generation and N the new one.

1. **G quiesces lifecycle transitions.** It takes every worktree's `restartMu` and waits out
   in-flight spawns, restarts and stops. G **keeps serving** while it waits, so the wait only
   delays the handover. Once a worktree is quiesced, a request that needs a *cold start* waits
   on the quiesce, then on N's start. A cold start waits anyway; this adds the handover's
   ~100 ms to it, never to a running backend.
2. **G writes its state** to the keeper as one JSON blob:
   - per worktree: its phase (`running` with its child pid, `idle{held}`, `broken{err,until}`),
     `lastActivity`, `lastSpawnErr`, and its crash-loop counters;
   - the registry's spec revisions (an optimization; N re-reads specs lazily as today);
   - service states and their `runningSince`;
   - main-deploy state: last ref, pending edges, and the run in progress (its child pid).
3. **The keeper starts N** with the listener dups, a control socketpair, the state blob, the
   child table (pids, tags, read-end fds) and **a direct socketpair to G** (the connection
   channel, step 5). N boots in **adopt mode**:
   - It skips `reconcileOrphanBackends`. It is replaced by adopting the keeper's table and
     reaping only sockets no live child claims.
   - It skips the synchronous `StartAll`: it re-arms the watchdogs from the blob.
   - It rebuilds each running worktree as `runningOn(adopted backend)`. One readiness probe
     per backend confirms it, and the probe runs on N's first use or in the background, never
     blocking the accept loop.
   - It starts serving on its listener dups and sends `ready` to the keeper.
4. **The keeper tells G to stop accepting.** G closes its listener dups. The sockets stay open
   (the keeper and N hold them), so the kernel now hands every new connection to N. From the
   moment N sends `ready`, both generations accept, so no connection waits for this switch.
5. **G hands over its live connections** over the G↔N socketpair (fd + metadata, SCM_RIGHTS),
   and N resumes each one:
   - **Idle HTTP keep-alive connections.** G wraps every accepted `net.Conn`, and the wrapper
     knows whether the server has consumed any byte since the connection went idle. G sets a
     past read deadline. A connection whose read times out with **zero bytes consumed** is at
     a request boundary. Its `Close` is intercepted, and the fd is sent to N instead, which
     serves it through a listener that yields handed connections.
     - This removes the classic graceful-shutdown race. A client, Caddy's upstream pool
       included, that sends a request on a keep-alive connection just as the old server
       closes it gets a reset, and a POST on such a connection is not retried. Here no
       keep-alive connection is ever closed.
   - **Active HTTP requests** finish on G (it still proxies them to the same backends over
     their sockets). When each one ends, its connection becomes idle and is handed over as
     above. G has no deadline for them: the agents' long MCP calls are legitimate.
   - **WebSockets.** G pauses both copy loops by setting a past read deadline on both conns.
     `io.Copy` writes every byte it read before it sees the timeout, so no byte is held in
     user space. G then sends the pair `(client fd, backend fd)` with the worktree name. N
     resumes the two copies and counts the socket against its adopted backend. **No WebSocket
     closes**, so no live-state resubscribe and no terminal reconnect.
     - Bytes the hijack buffered (`Hijack()`'s `bufio.Reader`, today ignored) are forwarded
       to the backend at hijack time. That fixes a latent byte-loss case on its own.
   - **The gateway's own SSE log stream** (`streamBackendLogs`, the only stream whose state
     lives in the gateway) ends when its connection's current response ends. The response is
     cut at the end of the drain, and `EventSource` reconnects to N and receives the
     `history` event. That is the one connection the handover closes, and it is a debug view.
6. **G exits** once its last active request has ended (code 0, with a handover marker in its
   log). The keeper reaps it. G's in-flight requests count against their backends in G only.
   So until G reports `drained`, N refrains from stopping any backend: no idle sweep and no
   hot restart's `drainAndStop`, so nothing it adopted can be stopped under a request still
   running on G.
7. **The keeper commits** the launch file, and the handover answers `{handedOver: true,
   pid, tookMs}`.

**Ordering invariant.** Between steps 3 and 6, exactly one generation owns lifecycle
transitions (G until it sends its state, N after). Both may *proxy* to running backends. A
backend's exit notification goes only to the owner.

### 3. Rollback: the old generation never stops until the new one serves

| failure | visitors see | what happens |
|---|---|---|
| N cannot start: bad binary, rejected flag, protocol mismatch, adopt error | nothing | The keeper kills N and tells G `aborted`. G un-quiesces and keeps serving. The launch file stays uncommitted. The handover answers 500 with N's stderr tail. |
| N is not `ready` within 30 s | nothing | same as above |
| N dies after `ready` while G is draining | connections N had accepted reset | The keeper re-runs the handover from the **committed** launch: it starts the previous gateway in adopt mode from its own table plus the last state blob. Backends live on (the keeper owns them). This is loud: a `gateway-restart-failed` report. |
| N dies later (any crash, any time) | that generation's connections reset | Same mechanism: **a gateway crash no longer kills a backend.** Today a crash is a launchd relaunch and a boot that SIGTERMs every live backend (`reconcileOrphanBackends`). |

A crash-adopt has no state blob from the dead generation, so it loses only soft state: idle
timers, crash-loop counters and `held`. `held` is lost today on any gateway restart too
(`StopHeld`: "in memory only"); see Caveats.

### 4. Protocol versioning and when a loud restart remains

The keeper↔gateway protocol carries a version number, which the keeper sends at spawn. A
gateway that does not speak it exits before `ready`, which is the rollback row above. Three
kinds of change still restart loudly:

- a change to the **keeper binary** itself;
- a change to **Postgres / PgBouncer** binaries, start scripts or `database.json`. That is a
  different program on the same data dir. There is no zero-wait way to swap a postmaster, and
  hiding it would hide a restart of every DB session;
- a change to **the supervised program's own definition**: the plist, the unit, or `-listen`.

All three stay explicit: `[host restart] <reason>: visitors wait ~2 s` on the box, and a
`gateway-follow` line naming the reason on the Mac. The keeper is meant to change rarely; it
has its own `gateway/keeper/CLAUDE.md` saying so.

### 5. The Mac: `followMainGateway`

`compareGatewayLaunch` and `isCurrent` split into two questions:

- **Is the keeper current?** That covers its binary identity and the rendered plist (keeper
  argv, env-free). If not, the follow reloads the service as it does today. It is loud, and it
  happens once for this transition and on keeper changes.
- **Is the gateway generation current?** That covers the gateway binary identity, flags and
  env names, compared against `GET /gateway/handover`'s running launch. If not, the follow
  POSTs a handover with the new launch and awaits it.
  - On failure nothing changed for anyone. The follow records `failed`, files
    `gateway-restart-failed` with the reason, and the held build stays where it is.
  - The `follow.lock`, the once-per-launch key and `heldDep` move are reused as they are.

The installed `.app` keeps one executable per component. The keeper becomes the
`gateway` login service's executable. The gateway binary runs from its deps cache path,
held by `machine-gateway` until a later handover moves the hold, so a running generation's
binary is never pruned under it.

### 6. The box: the host key splits

`releaseHostGeneration`'s parts split:

- **Keeper parts:** keeper binary, postgres, pgbouncer, pg-start, pgbouncer-start and
  `databaseConfig`. A difference here means exit 3 and a restart, as today.
- **Gateway parts:** gateway binary, `gatewayFlags`. A difference here makes `launch swap`
  POST a handover to the new release's gateway (`<extract>/deps/gateway-binary/gateway`)
  first, then the backend swap through it.

`activate-script`'s pruning already keeps every extraction a cgroup process runs from. The
keeper, the current generation and the backend each pin theirs. The rollback (`undo`) gains
one step: hand over back to the previous release's gateway.

## Files to change

- `gateway/keeper/` (new package): `main.go` (listeners, launch file, signals), `children.go`
  (spawn, wait4, read-end table), `handover.go`, `protocol.go`, tests, `CLAUDE.md`.
- `gateway/main.go`: inherited listeners, and an adopt-mode boot (no orphan reconcile, no
  synchronous `StartAll`).
- `gateway/env.go`: a backend spawn goes through the keeper (spawn plus exit events replace
  `cmd.Wait`).
- `gateway/worktree.go`: the `backend` struct no longer holds `*exec.Cmd`; it holds pid, exit
  channel and adopted state.
- `gateway/handover.go` (new): quiesce, state blob, connection hand-off (the conn wrapper, the
  WebSocket pause and resume), and the `/gateway/handover` routes.
- `gateway/proxy.go`: the WebSocket copy becomes resumable; hijack-buffered bytes are
  forwarded.
- `gateway/main_deploy.go`: runs are spawned through the keeper.
- `gateway/shutdown.go`: unchanged semantics. SIGTERM via the keeper still stops all
  backends inside the budget.
- `plugins/infra/plugins/launcher/deps`: a `gateway-keeper-binary` build dependency, sealed
  into releases.
- `plugins/infra/plugins/launcher/server/internal/boot.ts`: `gatewayLaunchSpec` renders the
  keeper job plus `launch.json`; `spawnGatewayDaemon` spawns the keeper; `awaitGatewayReady`
  is unchanged.
- `…/launcher/server/internal/release-swap.ts`: keeper vs gateway parts; handover before the
  backend swap.
- `…/launcher/plugins/gateway-drift`: the two-level comparison, and a follow by handover.
- `gateway/CLAUDE.md` (§ The gateway follows main, Shutdown, Orphan reaping), the launcher
  and deploy `CLAUDE.md`s.

## Verification

1. `go test ./...` in `gateway/` and `gateway/keeper/`:
   - a handover under a load goroutine, with real child backends (the test backend binary
     the existing tests use): zero failed requests, an open WebSocket that keeps echoing
     across it, unchanged backend pids;
   - an aborted handover (N exits early): G keeps serving;
   - N crashes after `ready`: the previous launch adopts;
   - keep-alive connections are handed, not closed (a client that reuses one connection
     across the handover sees no error).
2. `./equin test` on the launcher, gateway-drift and deploy plugins.
3. **Mac, before and after under load** (a load script in `gateway-drift/e2e/`): workers cycling
   main's shell, `/api/health/ready`, a WebSocket held open, and one write; every
   status/latency recorded, plus backend pids from `GET /gateway/worktrees`.
   - Before: one follow by reload (today's path), measured as a baseline.
   - After: the transition reload (loud, once), then a handover follow. **Pass:** 0 failed, 0
     closed WebSockets, no request over baseline p99 + 200 ms, the same backend pids.
4. **equin.ai under load** with the probe from the zero-wait doc plus a WebSocket.
   - First, one ship that installs the keeper: the host path, loud, once.
   - Then a ship whose gateway differs. **Pass:** `launch swap` takes the handover path, 0
     failed, worst wait under baseline p99 + 200 ms, no unit restart in the journal, and the
     backend's pid is unchanged until the backend swap replaces it.

## Caveats

- **The transition itself is loud, once per host.** Installing the keeper changes the
  supervised program. That is one reload on the Mac and one host-path ship on the box (about
  2 s, 0 failed, as today).
- **`held` survives a planned handover** (it is in the blob) but not a gateway *crash*. That is
  unchanged from today, where any gateway restart releases it. To be filed as a sidequest
  if it matters for data resets.
- **A long request keeps the old generation alive** until it ends. That is by design: memory
  for one extra process, never a cut request. A second handover while one is draining is
  refused (409) until the first ends.
- **Linux kernel ≥ 3.9 and macOS only.** No `pidfd` is needed (the keeper is the parent); the
  `fork/exec` path is portable.

## Built (step 1): what changed from the design

D21 approved two steps: the keeper now, connection passing (§2 step 5's fd hand-off of keep-alive connections and WebSockets) only if the numbers still need it.

- **The keeper is a mode of the gateway binary, not a second binary.** Started without `-keeper-fd`, the gateway is the keeper and runs itself as its first generation. So neither launcher's launch spec changes (launchd's plist, the release unit, serve-app, previews all start "the gateway" as before), and no new dependency or launch file exists. The running keeper keeps the code of the binary its service manager started; only a restart of the service updates it (`keeperProtocol` versions what generations require of it).
- **No launch file.** The keeper keeps the current launch in memory. A restart of the keeper starts from its service definition, which the Mac follow already rewrites (plist on disk) and which the box re-derives at every unit start.
- **Descriptors only over the control socket** (SCM_RIGHTS), never ExtraFiles: `os.File.Fd()` (which exec calls on ExtraFiles) switches the shared listening socket to blocking mode, and the serving generation's `Close` then hung (found by the first test run).
- **The drain never closes an idle keep-alive connection.** The plain `http.Server.Shutdown` closes them, and a client writing a request on one at that instant gets an EOF (1–3 of ~60 requests failed per handover in the first test runs, POSTs and GETs). Instead the replaced generation closes only its listeners, forwards each later request on a connection it still holds to the successor with `Connection: close`, and waits (≤ 6 min) for clients to close the idle ones (Go 90 s, Caddy 2 min). WebSockets are closed at once and reconnect to the successor, onto the same backend.
- **The keeper holds main's data-root lock** (`-lock-file`, landed meanwhile): generations overlap, keepers must not.
- **A gateway crash no longer kills a backend**: the keeper starts the same launch in `recover` mode over the live children.
- **Box: only a gateway-binary difference is a handover** (`release-swap.ts`); a flag, Postgres or PgBouncer difference stays a host restart.
- **Mac: the follow hands over first**, restarting the service only for a gateway that answers 404 (one from before the keeper — the transition).

### Measured

Load probe (`plugins/infra/plugins/launcher/scripts/gateway-load-probe.ts`): 6 workers cycling the shell, `/api/health` and an invalid `POST /api/analytics/collect`, 2 held `/ws/notifications`, 50 s, the switch at ~21 s.

**Mac, a sandbox gateway on :9301 serving this worktree's real backend** (main's current gateway binary vs this build):

| | today's follow (stop + start) | handover (3 runs) |
|---|---|---|
| failed requests | 12 (ECONNREFUSED, 0.2 s window) | **0** / 0 / 0 |
| worst request | **17.4 s** (backend cold start under load 15–19) | 231 / 130 / 696 ms (the last two outside the handover: host load) |
| backend | a new process (cold start) | the same process |
| WebSockets | 4 closes, reconnect refused | 2 closes, reopened in 3–7 ms |

The handover itself took 109 ms – 3.9 s, of which the successor's process start was up to 3.6 s at load 19 (exec → first log line); the old generation serves meanwhile, so it costs no visitor anything.

**equin.ai under load** (the probe from this Mac over the internet; baseline p99 ≈ 160–325 ms):

| ship | path | requests | failed | worst request | WebSockets | backend |
|---|---|---|---|---|---|---|
| A (installs the keeper) | host restart: the running gateway predated the keeper (and A changed pgStart) | 41,665 | 0 (Caddy held them) | **2.08 s** | 2 closes, reopened in 1.87 s | new (cold start in the restart) |
| B (gateway binary only) | **handover in 6 ms**, then the backend swap through the new gateway | 34,352 | 1 — a TCP *connect* timeout from this Mac at t = 13.6 s, during the 100 MB upload over the same link, 35 s before the handover (t ≈ 48.5 s) | 259 ms (baseline) | 4 closes (2 gateway handover, 2 backend swap), reopened in ≤ 67 ms | swapped by the release itself (no wait) |

| C (gateway binary only, after the review fixes) | **handover in 9 ms**, then the backend swap | 23,649 | 1 — again a TCP/TLS *connect* timeout to equin.ai:443 (t = 68 s, ~6 s after the handover, while the new backend booted on the box); a connection that never reached Caddy cannot be the gateway behind it, whose listeners never close | 2.0 s at t ≈ 216 s, far from the ship (network/host noise; the handover window's worst was baseline) | 4 closes, reopened in ≤ 109 ms | swapped by the release |

So a gateway-changing ship went from ~2 s of waiting and a host restart to a 6 ms handover no request waited on.

### What step 1 still does not keep: WebSockets

A replaced generation closes its WebSockets; clients reconnect in 3–67 ms onto the same backend (live-state resubscribes). Connection passing (step 2) would keep them open; the numbers above do not show a visitor-facing cost that would justify it yet (no request failed or waited), so it is not filed.
