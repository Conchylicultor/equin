# Expose backend crash logs in the frontend

## Context

When a worktree's backend crash-loops, users currently have no way to diagnose it from the UI — the gateway captures backend stdout/stderr via `pumpLog` (`gateway/worktree.go:434-441`) and writes them to its own slog sink (`/tmp/gateway.log`), but the lines are not retained per-worktree and there's no way to retrieve them.

Crucially, the existing **logs plugin** lives inside each backend (`plugins/logs/server/*`, served via `/ws/logs`). When that backend is broken, its log channels are unreachable. To surface crash logs, the **gateway itself** must retain and expose them out-of-band.

Goal: add a per-worktree ring buffer in the gateway, expose it over SSE, and integrate it as a new "channel" in the existing logs plugin UI so users have one place to view logs — app-level channels (served by the backend's WebSocket) alongside a `backend` channel (served by the gateway's SSE).

## Approach

### 1. Gateway: per-worktree ring buffer

**File: `gateway/worktree.go`**

Add to `Worktree` struct (near the `mu`-protected fields around line 95):

```go
logBuf *logRing // protected by mu
```

Add a small ring buffer type in the same file (keep it local — ~40 lines):

- Fixed capacity (e.g. 1000 lines; configurable via `Config` like `BrokenCooldown`).
- Each entry: `{Seq uint64, Stream string, Line string, TimestampMs int64}` — matches `LogEntryWire` in `plugins/logs/shared/protocol.ts` for easy reuse on the frontend.
- Methods: `Append(stream, line)`, `Snapshot() []entry`, `Subscribe() (ch, unsub)`. Subscribe registers a buffered Go channel; `Append` does non-blocking sends and drops to slow subscribers (log a warn once).
- Entries persist across crashes/respawns so the ring holds the last N lines *before* the crash (do NOT clear on spawn).

**Modify `pumpLog` (line 434)** to append to `w.logBuf` in addition to the current `slog.Info`. Pass `*Worktree` in so the pumpLog can reach the buffer.

**Initialize `logBuf`** in the `Worktree` constructor (or lazily under `mu` on first use). Do not tie its lifecycle to spawn — the buffer is per-worktree, not per-process.

### 2. Gateway: HTTP endpoints

**File: `gateway/proxy.go`** — extend `handleGatewayAPI` (line 153), matching the existing `/gateway/worktrees/<name>/restart` pattern.

Add a single endpoint:

- `GET /gateway/worktrees/<name>/logs` — SSE. On connect, send all current buffer entries as one `event: history`, then stream each new line as `event: entry`. Close the SSE loop on client disconnect (`r.Context().Done()`) and unsubscribe from the ring buffer.

SSE handler is ~25 lines of stdlib — no dependency. Pattern:

```go
w.Header().Set("Content-Type", "text/event-stream")
flusher := w.(http.Flusher)
ch, unsub := wt.logBuf.Subscribe()
defer unsub()
// snapshot -> write "event: history\ndata: ...\n\n"; flush
for {
  select {
  case <-r.Context().Done(): return
  case e := <-ch: write entry; flush
  }
}
```

### 3. Frontend: extend the logs plugin

**Files: `plugins/logs/web/components/log-viewer.tsx`, `plugins/logs/web/index.ts`, `plugins/logs/shared/protocol.ts`**

The logs plugin today fetches channel IDs from `GET /api/logs/channels` and subscribes via `/ws/logs`. Extend it to treat the gateway as a **second source** of channels:

- Add a `source: "backend" | "gateway"` discriminator to the channel list model (frontend-only; gateway doesn't need to know about the plugin).
- At viewer init, also fetch `GET /gateway/worktrees` (already used by `plugins/worktree-switcher/web/components/worktree-dropdown.tsx:29`) and add a synthetic channel `backend` (label: "Backend (gateway)") for the current worktree, derived from the host — the gateway sets the worktree context via hostname (`<name>.localhost:9000`).
- When a gateway-sourced channel is selected, open `EventSource(/gateway/worktrees/<name>/logs/stream)` instead of sending a WS subscribe. Reuse the existing `LogEntry` rendering — the wire shape is intentionally the same.
- Visual indicator: tag gateway channels with a small icon/color so users can tell at a glance this is pre-crash backend output rather than an app log channel.

Scope: only expose the *current* worktree's backend channel. Cross-worktree log inspection can come later.

## Critical files

- `gateway/worktree.go` — add ring buffer, modify `pumpLog` (l.434), extend struct (l.75-96).
- `gateway/proxy.go:153` — new `/logs` and `/logs/stream` routes.
- `gateway/main.go:15-28` — optional new `Config.LogBufferLines` (default 1000).
- `plugins/logs/web/components/log-viewer.tsx` — dual-source subscription.
- `plugins/logs/web/index.ts` — channel list merge.
- `plugins/logs/shared/protocol.ts` — no wire change needed; `LogEntryWire` is reused.

## Reusing existing code

- **`LogEntryWire`** (`plugins/logs/shared/protocol.ts`) — gateway emits the same shape; no new frontend type.
- **Channel dropdown UI** in `log-viewer.tsx` — extend with a grouped list, don't rebuild.
- **Gateway handler pattern** (`proxy.go:167-186` restart endpoint) — copy structure for path parsing, `reg.Get(name)`, JSON error response.
- **Poll loop** in `worktree-dropdown.tsx:29-39` — lift into a shared hook (e.g. `plugins/worktree-switcher/web/hooks/use-worktree-states.ts`) so the logs plugin doesn't add a second 5s interval.

## Out of scope

- Cross-worktree log inspection from a single app instance.
- Structured (JSON) log parsing — backend output stays as raw lines.
- Persisting logs across gateway restarts.
- Downloading logs as a file.

## Verification

1. `./equin build` — deploy the change.
2. Induce a crash: in a throwaway worktree, introduce a syntax error in `server/src/index.ts`, run `./equin build`, hit the worktree URL.
3. Open the logs plugin, select the `backend` channel — should show the pre-crash stderr including the error trace. Verify the ring keeps ~1000 lines after repeated crash-loop attempts.
4. Fix the code, rebuild — verify new stdout lines stream live via SSE into the same channel.
5. `curl -N http://localhost:9000/gateway/worktrees/<name>/logs` — verify the SSE endpoint directly; confirm `event: history` fires first then live `event: entry` lines, and that it closes cleanly on Ctrl-C (no goroutine leak; check gateway log for unsubscribe).
6. Open two browser tabs on the same worktree — both should receive live entries (fan-out test).
