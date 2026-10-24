# Gateway orphan-backend / stale-socket reaper

## Context

A real incident: after a `./equin build` hot-swap, an old worktree backend
(~11 min uptime) was still alive and orphaned while the gateway served a
freshly-built (~2 min) backend, and the worktree's sockets dir held only
`<name>.next.sock` — no promoted `<name>.sock`.

### Root cause

The gateway is the **sole owner** of every per-worktree `bun` backend process,
but it tracks them **only in memory** (`Worktree.active *backend`). There is no
durable record of a backend's PID anywhere on disk. The only safety net that
survives a gateway restart lives in the *backend*, not the gateway:
`plugins/framework/plugins/server-core/bin/index.ts:336` polls `process.ppid`
every 2s and self-exits once reparented to PID 1. That escape hatch is
**best-effort and the single point of failure** — if the backend's event loop is
wedged, or it never reaches `ppid==1`, the orphan lingers forever.

`sweepStaleSockets` (`gateway/registry.go:326`), the gateway's only boot-time
cleanup, removes socket **files** for **unregistered** worktrees only — it never
kills a process and explicitly skips registered worktrees' sockets.

Reconstruction of the incident (matches the observed state exactly):

1. Gateway G1 cold-starts `B_old` on `<name>.sock`.
2. G1 dies/restarts. The most common non-crash trigger: `./equin start`
   SIGTERMs the old gateway, sleeps a **fixed 2s**, then spawns the new gateway
   regardless of whether G1 finished `StopAll` (`cli/.../commands/start.ts:185`).
   `B_old`'s ppid-poll escape hatch fails to fire (wedged / timing). `B_old`
   lingers, still bound to `<name>.sock`.
3. New gateway G2 boots. `sweepStaleSockets` sees `<name>.sock`, the worktree
   **is** registered → leaves `B_old` and its socket alone. ← the structural gap.
4. A request cold-starts a new backend: `startBackend` does `os.Remove(.sock)`
   (unlinks `B_old`'s file; `B_old` keeps its bound fd), then bun binds a fresh
   `.sock`.
5. A build hot-restarts → new backend on `.next.sock`, swap, `drainAndStop`
   kills the `.sock` backend and removes `.sock`. Result: live backend on
   `.next.sock`, `.sock` gone, `B_old` **still alive** (file-less, 11 min).

### Intended outcome

Make the gateway **authoritative and durable** about backend ownership across its
own restarts, so orphans are deterministically reaped instead of depending on the
backend's cooperative escape hatch. Also fix the routine trigger (overlapping
gateway generations) and a latent unbounded-kill-wait bug in the same paths.

---

## Approach

Three coordinated changes: a durable per-backend PID sidecar, a boot-time
authoritative reconcile that replaces `sweepStaleSockets`, and hardening of the
kill waits. Plus a CLI fix to stop overlapping gateway generations.

### 1. Durable PID sidecar (`gateway/worktree.go`)

Write a sidecar `<socketPath>.pid` next to each socket, JSON:

```json
{"pid":12345,"pgid":12345,"wallStart":"2026-06-15T12:00:00Z","worktree":"central"}
```

- `pgid` is what we kill (`syscall.Kill(-pgid, sig)`); since backends are spawned
  with `Setpgid:true` and are the group leader, `pgid == pid`. `wallStart` is the
  gateway-side spawn time, **advisory** (logged for forensics, see PID-reuse note).
- **Write site (one):** `startBackend` (`worktree.go:567`), immediately after
  `cmd.Start()` succeeds (`:592`), before the `cmd.Wait` goroutine. Write
  atomically (temp + `rename`).
- **Remove sites:** introduce one helper `removeBackendArtifacts(socketPath)` that
  removes the **socket file first, then `.pid`** (crash-safe ordering: worst
  residue is an orphan sidecar, which the reconcile dial-gate handles trivially).
  Replace all five existing `os.Remove(...socketPath)` calls
  (`:308, :391, :444, :496, :631`) with it. Also route the **pre-spawn**
  `os.Remove(socketPath)` at `:568` through the helper so a stale predecessor
  sidecar is cleared too.
- Helpers to add (same file): `writeBackendSidecar(socketPath, cmd)`,
  `removeBackendArtifacts(socketPath)`, `readBackendSidecar(socketPath)`.

### 2. Boot reconcile, replacing `sweepStaleSockets` (`gateway/registry.go`, `main.go`)

Replace `sweepStaleSockets` with:

```go
func reconcileOrphanBackends(dir string, reg *Registry, dialTimeout, killGrace time.Duration)
```

Called synchronously at `main.go:97` (where `sweepStaleSockets` is today) —
**after `LoadAll`, before** the watcher/sweep/eager-central goroutines. This
ordering is load-bearing: at that point the gateway has spawned **zero**
backends, so **any live backend found is an orphan from a prior generation and
must be reaped.** Add a comment locking this invariant.

Per `*.sock`/`*.next.sock` entry (run concurrently with a bounded pool — a serial
loop of multi-second kills would add minutes to boot):

1. `net.DialTimeout("unix", path, dialTimeout)` (~250–500 ms). A bare *connect*
   is the liveness gate — do **not** upgrade to an HTTP `/ready` probe; a wedged
   orphan passes connect but fails HTTP and we want to reap it anyway.
2. **Not live** (refused / ENOENT): `removeBackendArtifacts(path)`. This single
   branch subsumes the old name-based unregistered removal **and** fixes the
   `.next.sock`-only leftover (whose stem *was* registered, so the old sweep kept
   it).
3. **Live + sidecar present:** kill the recorded **pgid** — SIGTERM → poll
   `kill(pid,0)` up to `killGrace` → SIGKILL — tolerating ESRCH as
   already-gone-success. Then `removeBackendArtifacts`. Log loudly at each step
   (orphan reaping is operationally significant; include pid + wallStart).
4. **Live + no sidecar** (legacy backend predating this change): `slog.Error`
   with the socket path and manual-cleanup guidance, then **leave it** — the live
   backend keeps working; the per-spawn unlink + next restart + the retained
   ppid-poll hatch clean it up. Do **not** shell to `lsof` for a one-time
   migration window.

After the socket loop, GC any orphan `*.pid` whose socket file is gone.

The registry is consulted only to **classify** log lines (orphan of registered
worktree X vs deleted worktree Y), never for the kill decision — the
registered/unregistered distinction disappears from cleanup logic.

**No periodic reconcile.** Boot-only is sufficient (intra-generation orphans
don't exist — the gateway tracks its own backends) and a periodic sweep is
actively dangerous: it loses the "zero backends yet" invariant and is one
misclassification away from killing a healthy backend it just spawned.

### 3. Bound + make-loud the kill waits (`gateway/worktree.go`) — Leak 1

The four post-SIGKILL `<-bk.exitCh` receives (`:305, :388, :441, :491`) are
**unbounded**: a silently-failed kill hangs the goroutine forever. Wrap each in
`select { case <-bk.exitCh: case <-time.After(postKillTimeout): slog.Error(...) }`
(`postKillTimeout` ~2–5s). Stop discarding `killGroup` errors at all call sites —
log non-ESRCH errors (ESRCH = already dead = fine).

### 4. Fix the overlapping-gateway trigger (`cli/.../commands/start.ts`)

Replace the fixed `Bun.sleep(2000)` after SIGTERM (`:185`) with a bounded poll on
`isRunning(existingPid)` (up to ~15s, matching the gateway's shutdown context)
so the new gateway only spawns once the old one has actually exited. Removes the
routine, non-crash variant of the trigger.

### Keep the backend ppid-poll escape hatch (defense in depth)

No change to `server-core/bin/index.ts:336` beyond an optional comment. It now
covers cases the gateway reconcile **cannot**: the unlinked-socket orphan
(incident step 4 — invisible to a dir scan), a backend orphaned while the gateway
stays down, and the legacy no-sidecar branch. The two mechanisms are
complementary: ppid-poll = "parent gone, I'll exit" (needs a healthy event loop);
reconcile = "backend wedged, gateway kills it" (works when the backend is broken).

### PID-reuse / TOCTOU safety (documented residual risk)

The kill is gated on "socket is live", so a recycled-but-unrelated pid is only at
risk if **both** (a) pid N is reused **and** (b) an unrelated process is bound to
that exact `~/.singularity/sockets/<name>.sock` path — effectively impossible on a
single-user dev box where only gateway-spawned backends ever bind that path. The
intrinsic POSIX TOCTOU between dial and kill is no worse than the gateway's
existing `killGroup` path; mitigate with `kill(pid,0)` immediately before each
signal and ESRCH-tolerance. `wallStart` is logged on every kill so a wrong kill is
forensically visible. Kernel start-time cross-check is deliberately out of scope
(macOS `libproc`/`sysctl` plumbing not worth it here).

---

## Files to modify

- `gateway/worktree.go` — sidecar write in `startBackend`; `writeBackendSidecar` /
  `removeBackendArtifacts` / `readBackendSidecar` helpers; replace 5 `os.Remove`
  sites + the pre-spawn unlink; bound the 4 post-SIGKILL waits; log `killGroup`
  errors.
- `gateway/registry.go` — replace `sweepStaleSockets` with
  `reconcileOrphanBackends` (dial gate, kill-by-sidecar, concurrent, orphan-`.pid`
  GC).
- `gateway/main.go` — swap the call at `:97`; optional `-reconcile-dial-timeout` /
  `-reconcile-kill-grace` flags (or reuse `ShutdownGrace` for the grace); comment
  locking the boot-invariant ordering.
- `gateway/sockets_test.go` — repoint/extend `TestSweepStaleSockets` →
  `reconcileOrphanBackends`: live-orphan kill (inject a kill func or a real
  `net.Listen("unix")` + killable child), `.next.sock`-only dead leftover removal
  (the incident regression), live+no-sidecar left in place, and a bounded
  kill-wait test (a never-closing `exitCh` returns within `postKillTimeout` and
  emits the error).
- `cli/.../bin/commands/start.ts` — poll old gateway exit instead of fixed 2s.
- `plugins/framework/plugins/server-core/bin/index.ts` — no behavior change
  (optional comment downgrading ppid-poll to cooperative defense-in-depth).

---

## Verification

Gateway is normally launched via `./equin start` (a one-time op); backends
serve at `http://<wt>.localhost:9000`.

**Reproduce the orphan:**
1. `./equin start`; hit `http://<wt>.localhost:9000/api/...` to cold-start.
   Record pid: `pgrep -f 'bun bin/index.ts'`; confirm `~/.singularity/sockets/<wt>.sock`.
2. Wedge + kill gateway: `kill -STOP <backend_pid>` (freeze so ppid-poll can't
   fire), then `kill -9 <gateway_pid>`.
3. Confirm orphan: `ps -o pid,ppid,etime,command -p <backend_pid>` (alive,
   `ppid=1`), `ls ~/.singularity/sockets/` shows `<wt>.sock` lingering.

**Confirm the fix reaps it:**
4. With the fix built, repeat 1–2 (now `<wt>.sock.pid` exists — verify its
   `pid/pgid` match).
5. `./equin start`. In `gateway.log` expect a loud reconcile line: dialed
   `<wt>.sock` → live → sidecar pid → SIGTERM → SIGKILL pgid → removed
   socket+sidecar. (A SIGSTOP'd process *does* die on SIGKILL, exercising the
   escalation branch.)
6. Confirm reaped: `ps -p <backend_pid>` gone; sockets dir has no `<wt>.sock` /
   `.pid`; next request spawns a fresh backend.

**Confirm the `.next.sock`-only regression (incident step 5):** create just
`~/.singularity/sockets/<wt>.next.sock` (plain file, no listener) for a
*registered* worktree → `./equin start` → reconcile dials → refused →
removes it (old sweep would have kept it).

**Confirm kill-wait bounding (Leak 1):** unit test — a `bk.exitCh` that never
closes makes `drainAndStop`/`Stop` return within `postKillTimeout` and emit
`slog.Error`.

**Confirm no self-kill regression:** `./equin start`, cold-start two
worktrees, hot-restart one via `POST /gateway/worktrees/<wt>/restart`; confirm
`gateway.log` shows reconcile ran **only at boot** and never targets a live
current-generation backend.

**Confirm CLI no-overlap:** `./equin start` while a gateway is already
running; confirm the new gateway only spawns after the old pid exits (no
overlapping-generation window in logs).

Finally: `./equin build` and `./equin check` (gateway is Go — also
`go build -o gateway . && go test ./...` inside `gateway/`).
