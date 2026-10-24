# Gateway↔backend IPC: TCP loopback → Unix domain sockets

## Context

The gateway proxies traffic to per-worktree Bun backends over TCP loopback. It allocates a port from 9001–10000 (`gateway/ports.go`), spawns the backend with `PORT=<n>` in env (`gateway/worktree.go:343-348`), then dials `127.0.0.1:<port>` for readiness (`gateway/worktree.go:398-414`), HTTP proxy (`gateway/worktree.go:425-427`), and WebSocket proxy (`gateway/proxy.go:126-132`).

This morning a real incident: bun bound `*:9277` (dual-stack), Warp had bound `127.0.0.1:9277` (IPv4 only), the kernel allowed both, the gateway dialed `127.0.0.1:9277` and traffic silently routed to Warp → 404. Investigation showed the bug class is wider than this one symptom: the port allocator's probe and the backend's bind disagree on shape, and on macOS asymmetric coexistence of TCP listeners on the same port is allowed (verified empirically — a `[::]:port` wildcard listener does not preclude an IPv4-only `127.0.0.1:port` bind). A symmetric-bind tactical patch is staged on the worktree but not committed; we're choosing the structural fix instead.

The intended outcome: eliminate the port-conflict bug class entirely by removing TCP from the gateway↔backend path. There is no LAN exposure requirement (gateway always dials loopback) and no port-discoverability requirement (no frontend reads the port).

## Goal

Replace TCP loopback with Unix domain sockets. One socket file per worktree at `~/.singularity/sockets/<name>.sock`. Gateway hands the path to the backend via `SOCKET_PATH` env var; both sides talk UDS. Delete `gateway/ports.go` and the `PortPool`. Single atomic cutover (no dual-transport phase) — gateway is started once via `./equin start`, all backends respawn on gateway restart.

## Design

### Path strategy

`~/.singularity/sockets/<name>.sock`. Stable, predictable, debuggable via `lsof -U`. The directory is created at gateway boot.

macOS `sun_path` = 104 bytes. With `/Users/<user>/.singularity/sockets/<name>.sock` (~32 char prefix + 5 char suffix), worktree names ≤67 chars fit. Validate at spawn — if the path overflows, fail with a clear error ("worktree name too long for UDS path; rename"). Don't add a hash fallback until/unless this becomes a real problem.

### Stale socket handling

Two layers, both authoritative on the gateway side:

1. **Per-spawn unlink-before-bind**: `os.Remove(socketPath)` immediately before `cmd.Start()`. Bun then unconditionally binds. Handles the "previous process crashed and left a socket file" case.
2. **Boot-time sweep**: at gateway startup, scan `~/.singularity/sockets/*.sock` and remove any whose worktree name isn't in the registry. Cheap (one directory read); prevents accumulation when worktrees are deleted while their socket lingers.

We do not rely on the backend cleaning up on its own SIGTERM — gateway owns lifecycle.

### File permissions

Bun.serve doesn't expose `unixOptions.mode`, so the socket inherits umask-derived default (typically 0755 dir / 0644 file). On a single-user dev machine this is fine; document as a known limitation in `gateway/CLAUDE.md`. If multi-user use ever becomes a requirement, revisit (chmod-after-bind is racy; safer is to set umask in the spawned process env).

### Backend (Bun.serve)

Replace TCP config with UDS:

```ts
// server/src/index.ts:128-134
const server = Bun.serve<WsData>({
  unix: (() => {
    const p = Bun.env.SOCKET_PATH;
    if (!p) throw new Error("SOCKET_PATH env var is required");
    return p;
  })(),
  idleTimeout: 255,
  fetch, websocket
});
```

Drop `port` and `hostname`. `unix:` and `port:` are mutually exclusive in Bun.serve. The `websocket` handler is independent of transport — WS upgrades work identically over UDS.

### Gateway (Go)

**`Worktree` struct** (`gateway/worktree.go:75-101`): replace `port int` (line 87) with `socketPath string`. Drop `pool *PortPool` (line 78). The `socketPath` is computed deterministically from `Name` at spawn time, not stored on the manifest.

**`Spec`** (`gateway/worktree.go:51-54`): unchanged. The on-disk manifest stays `{server, web}`. CLI's `cli/src/commands/build.ts:376-384` doesn't change.

**`WorktreeStatus`** (`gateway/worktree.go:56-66`): replace `Port int` (line 61) with `SocketPath string`. Confirmed no frontend consumer reads the port field — only `cli/src/commands/start.ts:31` uses the endpoint, and only as a liveness check (`resp.ok`). Logs that include `port` (lines 215, 275, 364) become `socketPath`.

**`Ensure()`** (`gateway/worktree.go:127-217`): replace `pool.Acquire()` (line 163) with a deterministic path computation + length validation. Replace `port: port` cleanup branches (lines 195-196, 267, 271, 386, 390) with socket-path cleanup (`os.Remove`).

**`startBackend`** (`gateway/worktree.go:342-374`): change env var on lines 345-348:
```go
cmd.Env = append(os.Environ(),
  fmt.Sprintf("SOCKET_PATH=%s", socketPath),
  fmt.Sprintf("SINGULARITY_WORKTREE=%s", w.Name),
)
```
Add `os.Remove(socketPath)` (ignore-error) immediately before `cmd.Start()` on line 359.

**`waitReady`** (`gateway/worktree.go:398-414`): swap the dial:
```go
conn, err := net.DialTimeout("unix", socketPath, 200*time.Millisecond)
```
Loop shape and exit-watch unchanged. Signature changes from `(port int, ...)` to `(socketPath string, ...)`.

**`newReverseProxy`** (`gateway/worktree.go:425-438`): keep `httputil.NewSingleHostReverseProxy` but install a custom `Transport` that dials UDS. `socketPath` is captured by value in the closure to avoid the mutation hazard the design review flagged:

```go
func newReverseProxy(socketPath string) *httputil.ReverseProxy {
  target := &url.URL{Scheme: "http", Host: "backend"} // host is a placeholder; transport ignores it
  rp := httputil.NewSingleHostReverseProxy(target)
  rp.Transport = &http.Transport{
    DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
      var d net.Dialer
      return d.DialContext(ctx, "unix", socketPath)
    },
  }
  // Director and ErrorHandler unchanged.
  return rp
}
```

**WS proxy** (`gateway/proxy.go:116-165`): replace lines 121-128:
```go
socketPath := wt.Snapshot().SocketPath
if socketPath == "" {
  http.Error(w, "backend socket unavailable", http.StatusBadGateway)
  return
}
backendConn, err := (&net.Dialer{}).DialContext(r.Context(), "unix", socketPath)
```
Switch from `net.DialTimeout` to `net.Dialer.DialContext` so client cancellation propagates to the dial (low-priority improvement the design review noted; cheap to fold in here). The 3-second timeout becomes a context with deadline. Hijack, `r.Write(backendConn)`, and the two `io.Copy`s are transport-agnostic. `r.Host` can stay set to the original incoming Host — Bun doesn't validate Host against listener type, and the backend doesn't care.

**Audit**: confirm the WS error path closes `backendConn` on every return after a successful dial (the existing `defer backendConn.Close()` on line 133 covers this — verify it stays in place after the edit).

**Boot sweep**: in `gateway/main.go`, after `LoadAll` populates the registry, call a new `sweepStaleSockets(socketsDir, reg)` that lists `*.sock` in the dir and removes any whose stem isn't a known worktree name.

**Delete**: `gateway/ports.go` and `gateway/ports_test.go` (the staged tactical patch). Drop `cfg.PortMin`, `cfg.PortMax`, `pool := NewPortPool(...)` from `gateway/main.go:82` and any flag definitions referencing the port pool.

### Cutover

Single atomic change. Gateway is started once via `./equin start`. After the migration commit lands, the next `./equin start` (user-driven) restarts the gateway under UDS contract; all in-flight backends die with the gateway and respawn under UDS on first request. No dual-transport phase needed.

## Critical files

- `server/src/index.ts` (lines 128-134) — Bun.serve config
- `gateway/worktree.go` (struct, Ensure, startBackend, waitReady, newReverseProxy, Stop, onProcExit, Snapshot)
- `gateway/proxy.go` (lines 116-165 — WS hijack path)
- `gateway/main.go` (drop PortPool, add socket dir setup + boot sweep)
- `gateway/ports.go` — delete
- `gateway/ports_test.go` — delete (staged in this worktree)
- `gateway/CLAUDE.md` — update (see doc updates)
- `server/CLAUDE.md` — update
- `CLAUDE.md` (top-level) — update

No changes needed:

- `cli/src/commands/build.ts:376-384` — manifest schema unchanged
- `web/vite.config.ts` — no Vite proxy exists
- `server/package.json` — no scripts to update (no standalone dev mode)
- `gateway/registry.go` — `Spec` schema unchanged
- `gateway/central_routes.go` — central runtime is just another worktree

## Test plan

Replace `gateway/ports_test.go` with a new `gateway/sockets_test.go`:

1. **`TestWaitReadyOverUDS`** — start `net.Listen("unix", tmpPath)` in a goroutine that accepts after a 50 ms delay; assert `waitReady(tmpPath, 1*time.Second, exitCh)` returns nil. Negative case: no listener → assert non-nil error after the 1-second deadline.
2. **`TestUnlinkBeforeSpawn`** — touch a file at the socket path; call the helper that does the pre-spawn unlink; assert the file is gone and no error returned. Also: missing-file case is silent (`os.Remove` not-exist error is ignored).
3. **`TestNewReverseProxyOverUDS`** — stand up a `net.Listen("unix", ...)` in the test, serve a minimal HTTP/1.1 response from a goroutine, send a request through `newReverseProxy(tmpPath)` via `httptest.NewRecorder` + `rp.ServeHTTP`; assert the response body matches.
4. **`TestSweepStaleSockets`** — populate a tmp dir with `a.sock`, `b.sock`; pass a registry containing only `a`; assert `b.sock` is removed and `a.sock` remains.

All tests use `t.TempDir()` for socket paths (well under 104 bytes; safe to skip the path-length test in unit tests).

End-to-end (real Bun + real gateway) is intentionally out of scope — the four unit tests above cover the failure modes and the design review confirmed e2e adds complexity without proportional signal.

## Doc updates

- **`gateway/CLAUDE.md`**:
  - "What It Does": replace "Allocates backend ports dynamically from a pool (9001–10000); backends read `PORT` from env" with "Hands each backend a Unix domain socket path under `~/.singularity/sockets/<name>.sock`; backends read `SOCKET_PATH` from env."
  - "Backend Contract": rewrite to: read `SOCKET_PATH` from env, bind that Unix socket, accept HTTP/1.1 + WS over it. Note that gateway dials with `net.Dial("unix", path)`.
  - "File Structure": delete `ports.go` line.
  - "Routing Rules": no change.
  - Add a short "Stale-socket cleanup" subsection: per-spawn unlink + boot sweep.
  - Add a "File permissions" note: socket mode is umask-derived; single-user dev tool by design.
- **`server/CLAUDE.md`**:
  - "How It Works" §1: replace "starts `Bun.serve()` on port 9001" with "starts `Bun.serve()` on the Unix socket at `SOCKET_PATH`".
  - "Dev Proxy" section: remove or rewrite — Vite has no proxy block; this section is already stale.
  - "Backend Contract" mention near the bottom and any `port: 9001` reference: update to UDS contract.
- **Top-level `CLAUDE.md`**:
  - "Ports" section: keep "9000 = equin.localhost:9000" line; remove the "9000–10000" backend-pool line; replace with "backends communicate via Unix domain sockets, not TCP."

## Verification

1. `cd gateway && go build ./...` — must compile clean after deletions.
2. `cd gateway && go test ./...` — the four new tests must pass.
3. `./equin build` from this worktree — backend rebuild + restart through normal flow; assert `lsof -U | grep singularity` shows the worktree's socket and `lsof -i :9001-10000` shows nothing on this worktree's behalf.
4. Hit `http://<worktree>.localhost:9000/api/conversations` — assert 200 (HTTP path).
5. Open a conversation in the UI and confirm `/ws/notifications` connects (WS path).
6. `curl http://localhost:9000/gateway/worktrees | jq '.[] | {name, socketPath, state}'` — confirm the new field shape.
7. Manual stale-socket test: `touch ~/.singularity/sockets/zzz.sock` (a name not in the registry) → restart gateway → assert the file is gone after boot.
8. Manual crash-recovery test: while a backend is running, `kill -9` the bun process; hit a backend path through the gateway; assert the gateway respawns and a fresh socket appears.

User reviews the diff before any commit; do not run `./equin push` without explicit instruction.
