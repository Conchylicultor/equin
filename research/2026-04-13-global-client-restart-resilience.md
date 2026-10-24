# Client Resilience to Server Restarts

## Context

`./equin build` kills and respawns the backend on every deploy. Currently clients don't cope:

- **WebSockets** (`/ws/terminal`, `/ws/logs`) close and stay closed — the terminal prints `[Connection closed]`, the log viewer just stops.
- **In-flight HTTP** against the backend returns 502 from the gateway during the respawn window; no plugin retries.
- The build button is the worst offender: its own `POST /api/build` races the restart it triggers, so the response never arrives and the UI hangs on "building".

Since rebuilding is part of the core agent loop, every restart costs the user a manual refresh. Goal: make restarts transparent to the UI — reconnect automatically, resume data where feasible, and surface a single toast instead of silent breakage.

## Approach

Four pieces, each independently useful:

1. **Shared WS reconnect hook** in `plugin-core/web/`
2. **Shared fetch-with-retry helper** in `plugin-core/web/`
3. **Plugin wiring**: terminal (via tmux), logs (via sequence numbers), build (fire-and-forget + health poll + toast)
4. **New `GET /api/health`** endpoint for liveness checks

### 1. `useReconnectingWebSocket` — `plugin-core/web/hooks/use-reconnecting-ws.ts` (new)

Thin hook wrapping `WebSocket` with:

- Relative URL construction (matches current `ws://…` / `wss://…` pattern in `terminal.tsx:8` and `log-viewer.tsx:12`).
- Exponential backoff on close: 500ms → 1s → 2s → 5s (cap). Reset on successful open.
- `onOpen(ws)` callback — fires on first connect **and** every reconnect. Plugins put their "replay subscription" logic here (terminal: send `session.create`; logs: send `subscribe` with `fromSequence`).
- `onMessage(ev)`, `onStatusChange("connecting" | "open" | "reconnecting" | "closed")`.
- Returns `{ send, status, ws }`. `send` queues while disconnected and flushes on reopen (bounded queue to avoid runaway memory).
- Unmount → close with a sentinel code so reconnect loop stops.

No external dependency; ~80 lines.

### 2. `fetchWithRetry` — `plugin-core/web/utils/fetch-with-retry.ts` (new)

```ts
fetchWithRetry(input, init, { retries = 3, retryOn = [502, 503, 504], backoffMs = 300 })
```

- Retries on listed HTTP statuses **and** on network errors (`TypeError` from fetch when backend is down).
- Exponential backoff with jitter.
- Opt-in per call site — we **do not** blanket-wrap `fetch`, since some POSTs are non-idempotent (build). Plugins choose when it's safe.

Apply initially to:
- `plugins/logs/web/components/log-viewer.tsx:24` — `GET /api/logs/channels`
- `plugins/conversations/web/**` — list/get calls (safe idempotent GETs)

### 3. Plugin wiring

**Terminal**

The configured shell is already tmux, so persistence is handled by tmux itself — no server-side changes needed. Behavior on reconnect is exactly "as if the page was refreshed": the new PTY reattaches to the tmux session automatically.

Client-side only (`plugins/terminal/web/components/terminal.tsx`): swap raw `new WebSocket` for `useReconnectingWebSocket`. `onOpen` re-sends `session.create` with the current cols/rows, and the component re-initializes the xterm view the same way it does on first mount. Drop the `[Connection closed]` message; show a subtle reconnecting indicator only if `status === "reconnecting"` persists >1s.

Server-side `plugins/terminal/server/internal/ws-handler.ts` stays untouched — it already destroys the old PTY on WS close and spawns a fresh one on the next `session.create`.

**Logs — sequence-based resume**

Protocol changes in `plugins/logs/shared/protocol.ts`:

- `LogEntryWire` gains `seq: number` (monotonic per-channel, assigned by registry).
- `SubscribeMsg` gains optional `fromSequence?: number`.
- History frame (`{ type: "history", entries }`) stays the same shape; server fills it with entries where `seq > fromSequence` (or full buffer if omitted/undefined).

Registry changes in `plugins/logs/server/internal/registry.ts`:

- Per-channel `nextSeq` counter; stamp each entry at append time.
- `subscribe(channel, fromSequence?)` filters the ring buffer.

Client changes in `plugins/logs/web/components/log-viewer.tsx`:

- Track `lastSeenSeq` per channel in a `useRef`.
- `onOpen` of the reconnecting WS sends `{ type: "subscribe", channel, fromSequence: lastSeenSeq }`.
- Drop entries already rendered (defensive — server already filters, but guards against races).

**Build — fire-and-forget + health poll + toast**

New endpoint `GET /api/health` in a new tiny plugin `plugins/health/server/` (or fold into `shell` server; decide during implementation — leaning toward new plugin for separability). Returns `{ ok: true, startedAt }` (unix ms). The `startedAt` lets the client distinguish "still the old server" from "new server came up".

`plugins/build/web/components/build-button.tsx` flow:

1. Send `POST /api/build` via `fetch`. **Don't await** the body — treat disconnect as expected.
2. Immediately enter a "building" state; poll `GET /api/health` every 500ms.
3. When `/api/health` returns a `startedAt` greater than the one captured before the POST → build finished, server respawned.
4. Dispatch `Shell.Toast({ description: "Server restarted", variant: "success" })`.
5. If `/api/health` still reachable with the *old* `startedAt` after ~3s, assume the build is still running (long compile); keep polling.
6. If polling fails for >60s, toast `"Build timed out"` and give up.

The build's actual exit code is lost this way — acceptable because the server logs capture it, and the logs plugin will surface failures. (If we later want exit code, route it through a WS event instead of an HTTP response.)

**Global restart toast — `plugins/health/web/`**

The health plugin owns liveness, so the toast lives there. It subscribes to the WS status bus exported from `plugin-core/web/` (and/or polls `/api/health` on a slow interval as a backup signal). When it detects a `startedAt` change — or *any* reconnecting socket transitioning `reconnecting → open` — it dispatches `Shell.Toast({ description: "Reconnected to server", variant: "info" })`, debounced so multiple sockets reconnecting together produce one toast. The build button's own "Server restarted" toast is a special case of the same mechanism (build triggers the restart, health plugin announces it).

### 4. `GET /api/health`

Trivial handler returning `{ ok: true, startedAt: serverStartedAtMs }`. `serverStartedAtMs` is captured once at module load in `server/src/index.ts`. Used by build poll and potentially a future "status bar" indicator.

## Files to Modify / Create

**Create:**
- `plugin-core/web/hooks/use-reconnecting-ws.ts`
- `plugin-core/web/utils/fetch-with-retry.ts`
- `plugin-core/web/utils/ws-status-bus.ts` (tiny pub/sub for global reconnect toast)
- `plugin-core/web/index.ts` (barrel, if not already)
- `plugins/health/server/index.ts` + `handle-health.ts`
- `plugins/health/web/index.ts` — subscribes to ws-status-bus, owns the global reconnect toast

**Modify:**
- `plugins/terminal/web/components/terminal.tsx` — use `useReconnectingWebSocket`, re-run `session.create` on each open, drop `[Connection closed]` UI
- `plugins/logs/shared/protocol.ts` — add `seq`, `fromSequence`
- `plugins/logs/server/internal/registry.ts` — per-channel seq counter
- `plugins/logs/server/internal/ws-handler.ts` — honor `fromSequence`
- `plugins/logs/web/components/log-viewer.tsx` — track `lastSeenSeq`, use hook
- `plugins/build/web/components/build-button.tsx` — fire-and-forget + health poll
- `server/src/index.ts` — capture `serverStartedAtMs`
- `server/src/plugins.ts` + `web/src/plugins.ts` — register health plugin
- `plugins/CLAUDE.md` — will be regenerated by `./equin build` per `6e36184`

## Verification

1. `./equin build` — deploys and self-restarts.
2. Open `http://<worktree>.localhost:9000/`, open a terminal, run `yes | head -1000000 > /dev/null &` and `echo marker; sleep 1000`.
3. Trigger a rebuild via the Build button. Expect:
   - Build button shows building state, no error.
   - Terminal briefly shows reconnecting indicator, then resumes — `marker` still in scrollback, background `yes` still running (verify with `jobs`). This is the tmux win.
   - Logs viewer keeps streaming with no visible gap or duplicates near the restart boundary.
   - Single toast: "Server restarted" / "Reconnected to server".
4. Run `kill $(lsof -ti :<backend-port>)` to simulate a non-build crash → same resilience behavior, without the build toast.
5. Playwright smoke:
   ```bash
   bunx playwright screenshot --wait-for-timeout 3000 --viewport-size "1280,800" \
     http://<worktree>.localhost:9000 /tmp/before.png
   ```
   then rebuild, then screenshot after — app should be interactive without refresh.
6. Confirm `./equin check` passes (migration check — no schema changes expected here).

## Out of Scope (deferred)

- Exit-code reporting for build (would need WS or SSE from server).
- Reconnect-aware retries for non-idempotent POSTs beyond build (e.g. `POST /api/conversations`) — today a single 502 during restart will fail; acceptable until it bites.
- Status-bar "backend up/down" indicator — the toast is enough for v1.
- Persisting tmux scrollback across *host* reboots (tmux dies with the machine).
