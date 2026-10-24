# Zero-Downtime Server Restart via Dual-Socket Handoff

## Context

When `./equin build` restarts a backend, there's a downtime window: the gateway calls `wt.Stop()` (SIGTERM + socket removal), returns immediately, then the CLI's `probeHealth` triggers a lazy re-spawn via `wt.Ensure()`. During that gap, any request gets a 502. The goal is to eliminate this window by spawning the new backend **before** killing the old one, then atomically swapping the proxy pointer.

A secondary benefit: if the new backend fails to start (bad code, broken migration), the old backend stays up — failed deploys no longer cause downtime.

## Design

### Core mechanism

Two socket paths per worktree: `<name>.sock` (primary) and `<name>.next.sock` (secondary). On restart, spawn the new backend on whichever socket the **current** backend is NOT using. Once the new backend is ready, swap the proxy pointer under the lock. The old backend drains in-flight connections then exits.

The `httputil.ReverseProxy` captures the socket path by value at construction (`worktree.go:455`). After a swap, in-flight HTTP requests continue using the old proxy (old socket) until they complete. New requests get the new proxy (new socket). This is the natural seam — no request buffering needed.

### New state: `StateRestarting`

Added between `StateRunning` and `StateStopping`. During `StateRestarting`:
- `Ensure()` returns the **old** proxy immediately (not blocking) — zero downtime
- `ShouldSweep()` returns false — sweeper won't interfere
- `Stop()` waits for the restart to settle before proceeding

### New struct: `backend`

Groups per-process fields that currently live directly on `Worktree`:

```go
type backend struct {
    cmd        *exec.Cmd
    exitCh     chan struct{}
    socketPath string
    proxy      *httputil.ReverseProxy

    connMu      sync.Mutex
    activeConns int          // WebSocket connections to THIS specific backend
}
```

`Worktree` replaces `cmd`, `exitCh`, `proxy`, `activeConns` with a single `active *backend`. The `socketPath` field on Worktree is removed — it's now derived from `active.socketPath` or computed via helpers.

### `Restart()` flow

```
1. Lock → check state == Running → set StateRestarting → capture oldBk → compute alternate socket → unlock
2. startBackend(spec, alternateSocket) — spawn new process
3. waitReady(alternateSocket) — poll until socket accepts connections
4. On failure: kill new process, revert state → Running, return error (old backend untouched)
5. On success: lock → swap active = newBk, state = Running → unlock
6. Background goroutine: drain old backend's WebSocket connections → SIGTERM → grace → SIGKILL → remove socket
```

Concurrent `Restart()` calls are serialized by `restartMu sync.Mutex`. `restartDone chan struct{}` lets `Stop()` wait for an in-flight restart without holding `w.mu`.

### `onProcExit` → `onBackendExit(bk *backend)`

Compares `w.active == bk` instead of checking state:
- `w.active != bk` → draining old backend exited (expected) → return silently
- `w.active == bk` → active backend crashed → state → Idle (same as current behavior)

This eliminates the subtle state-check race in the current `onProcExit`.

### Restart endpoint becomes blocking + hot-swap aware

```
POST /gateway/worktrees/<name>/restart
  state == running/restarting → wt.Restart(ctx)  — blocks until new backend is ready
  state == idle/broken        → wt.Ensure(ctx)   — cold start
  state == starting/stopping  → 503 retry shortly
```

The endpoint now returns only after the new backend is confirmed serving. The CLI's `probeHealth` becomes a belt-and-suspenders smoke test (should succeed immediately).

## Files to modify

### `gateway/worktree.go` — Major refactor

1. **State enum**: add `StateRestarting` (value 5) + `"restarting"` in `String()`
2. **`backend` struct**: new, groups cmd/exitCh/socketPath/proxy/activeConns
3. **`Worktree` struct**: replace `cmd`, `exitCh`, `proxy`, `socketPath`, `activeConns` with `active *backend`. Add `restartMu sync.Mutex`, `restartDone chan struct{}`
4. **`NewWorktree`**: validate the longer `.next.sock` path against `maxSocketPath`. Remove `socketPath` field assignment
5. **Socket path helpers**: `primarySocketPath()`, `secondarySocketPath()`, `restartTargetPath()` (picks whichever the active backend is NOT using)
6. **`startBackend(spec, socketPath)`**: new signature, returns `*backend` instead of `(*exec.Cmd, chan struct{}, error)`. Spawns `onBackendExit(bk)` goroutine
7. **`Ensure()`**: `StateRunning` returns `w.active.proxy`. `StateRestarting` also returns `w.active.proxy` (the old one — keeps serving). Cold spawn path uses `primarySocketPath()`
8. **`Restart(ctx)`**: new method — the core of this feature (see flow above)
9. **`drainAndStop(bk)`**: new helper goroutine. Polls `bk.conns()` up to 30s drain timeout, then SIGTERM → grace → SIGKILL → remove socket
10. **`Stop(ctx)`**: if `StateRestarting`, wait on `restartDone` first. Then drain active backend as before
11. **`onBackendExit(bk, err)`**: replaces `onProcExit`. Identity check (`w.active == bk`) instead of state check
12. **`Snapshot()`**: read `SocketPath` and `ActiveConns` from `w.active` instead of Worktree fields
13. **`ShouldSweep()`**: `w.active.conns()` instead of `w.activeConns`
14. **`IncConns`/`DecConns`**: removed from Worktree. Replaced by `bk.incConns()`/`bk.decConns()` on the backend struct
15. **`activeBackend()`**: new helper returning `w.active` under lock, for `handleWebSocket`

### `gateway/proxy.go` — Two changes

1. **`handleWebSocket`**: capture `bk := wt.activeBackend()` at connection time. Use `bk.socketPath` for dial, `bk.incConns()`/`bk.decConns()` for tracking. This pins the WebSocket to the backend that was active when the connection was established — hot swaps don't break open connections
2. **Restart endpoint**: replace `wt.Stop()` with the hot/cold dispatch described above

### `gateway/registry.go` — One change

**`sweepStaleSockets`**: recognize both `<name>.sock` and `<name>.next.sock` as belonging to a registered worktree

### `cli/src/commands/build.ts` — Two changes

1. Add `AbortSignal.timeout(30_000)` to the restart `fetch()` — the endpoint now blocks up to ReadyTimeout (15s)
2. Update the console.log from "will respawn on next request" to "Backend restarted"

### `gateway/sockets_test.go` — New tests

- `TestRestartHotSwap`: spawn A → Restart → verify B active, A drained
- `TestRestartFailureKeepsOldBackend`: spawn A → Restart with failing B → verify A still serves
- `TestConcurrentRestarts`: two parallel Restart() calls → both succeed sequentially
- `TestOnBackendExitIgnoresDraining`: fire onBackendExit for old bk → state unchanged
- `TestStopWaitsForRestart`: Start restart → concurrent Stop → Stop waits, then stops new backend

## Implementation stages

1. **`backend` struct extraction** (worktree.go only) — purely mechanical refactor, all existing behavior preserved. Largest diff but safest since it's just field moves.
2. **`Restart()` + drain** (worktree.go only) — add StateRestarting, restartMu, Restart(), drainAndStop(). New tests. No external behavior change yet (endpoint not wired).
3. **Endpoint + WebSocket** (proxy.go) — wire the restart endpoint to Restart(), switch handleWebSocket to per-backend tracking. Feature becomes end-to-end visible.
4. **Cleanup** (registry.go + build.ts) — sweepStaleSockets recognizes `.next.sock`, CLI timeout + log message update.

## Edge cases

| Scenario | Behavior |
|---|---|
| New backend fails to start | Old backend keeps serving. `Restart()` returns error. State reverts to Running. |
| Old backend crashes mid-restart | `onBackendExit` sets state → Idle. `Restart()` detects state change, kills new backend, returns error. Next request triggers cold Ensure(). |
| Gateway shutdown during restart | `Stop()` waits on `restartDone` (up to 15s shutdown context). If timeout, OS reaps all children. |
| Two concurrent restarts | `restartMu` serializes them. Second waits for first to complete, then does its own swap. |
| Idle sweeper during restart | `ShouldSweep()` returns false for non-Running states, including Restarting. |
| Socket path length | `NewWorktree` validates the `.next.sock` path (5 bytes longer) against the 104-byte macOS limit. |
| Stale sockets after crash | Both `<name>.sock` and `<name>.next.sock` are recognized by `sweepStaleSockets`. Per-spawn `os.Remove` handles stale files at the target path. |

## Verification

1. `cd gateway && go test ./...` — all existing + new tests pass
2. `./equin build` from a worktree — verify zero-downtime:
   - Open browser to `http://<name>.localhost:9000`
   - Run build in another terminal
   - Confirm the page stays responsive throughout (no 502s)
3. Deliberately break server code → `./equin build` → verify old backend stays up and error is reported
4. Check `GET /gateway/worktrees` shows `"restarting"` state briefly during a hot restart
5. Verify WebSocket connections (notifications channel) survive a hot restart — open the app, trigger build, confirm no reconnection toast
