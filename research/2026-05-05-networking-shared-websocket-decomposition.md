# SharedWebSocket decomposition

## Context

`SharedWebSocket` (`plugins/primitives/plugins/networking/web/shared-websocket.ts`) is a ~370-line class mixing three concerns: reconnecting WebSocket, cross-tab leader election, and BroadcastChannel relay. A bug where a frozen leader tab silently blocked all followers was hard to diagnose because the logic was interleaved. The fix (heartbeat + steal) made the class even denser. Decomposing into focused primitives improves testability, readability, and future reuse.

## Design: two primitives

### 1. `ReconnectingWs` (new: `reconnecting-ws.ts`, ~80 lines)

Pure connection engine. No cross-tab awareness, no status bus.

```ts
const DEFAULT_BACKOFF = [500, 1000, 2000, 5000];

class ReconnectingWs {
  readonly url: string;      // absolute ws:// URL, resolved once in constructor
  readyState: number;        // 0 | 1 | 3

  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;

  constructor(url: string, opts?: { backoff?: number[] });
  send(data: string): void;  // queues if not yet open
  close(): void;             // idempotent, suppresses reconnect
}
```

Design decisions:
- Callbacks take raw values (no `Event` wrappers) — the orchestrator wraps them.
- URL resolved once in constructor from `location.protocol`/`location.host`.
- `close()` does NOT call `onclose` — caller manages lifecycle events.
- No send-queue limit (matches current `SharedWebSocket` behaviour; `useReconnectingWebSocket`'s 1000-cap is intentional for its use case).

### 2. `SharedWebSocket` (refactored: `shared-websocket.ts`, ~220 lines)

Cross-tab orchestrator. Uses `ReconnectingWs` as its engine.

```
┌─────────────────────────────────────────────────┐
│ SharedWebSocket (public API: send/close/on*)    │
│                                                 │
│  ┌──────────────┐   ┌───────────────────────┐  │
│  │ReconnectingWs│   │ navigator.locks +      │  │
│  │ (leader only)│   │ BroadcastChannel relay │  │
│  └──────────────┘   │ + heartbeat/timeout    │  │
│                      └───────────────────────┘  │
│                                                 │
│  publishWsStatus() on every state transition    │
└─────────────────────────────────────────────────┘
```

When **leader**: instantiates `ReconnectingWs`, relays `onopen`/`onmessage`/`onclose` to followers via BroadcastChannel, publishes status.

When **follower**: receives relayed events from leader, routes `send()` through BroadcastChannel `{kind:"tx"}`. Monitors leader heartbeat; steals lock after 12s silence.

Public API unchanged — `NotificationsClient` and all other code is unaffected.

### Why not extract leader election as a third primitive?

The heartbeat IS a BroadcastChannel message. The timeout resets ON BroadcastChannel messages. The `hello`/reply is a BroadcastChannel exchange. They're one cohesive concern. No other code needs leader election. Splitting would create cross-references with zero reuse.

## Implementation

### Step 1: Create `reconnecting-ws.ts`

```
plugins/primitives/plugins/networking/web/reconnecting-ws.ts
```

Extract from current `SharedWebSocket`:
- `connectWs` → `_connect` (private arrow)
- `scheduleReconnect` → `_scheduleReconnect`
- `writeOrQueue` → `send` (public)
- `BACKOFF_MS` constant (shared)

Key differences from the extracted logic:
- URL resolution happens once in constructor, not per-connect
- `onclose` callback fires on every socket close (lets orchestrator track state), but `close()` does NOT invoke it (prevents double-fire on teardown)
- Callbacks are `() => void` / `(data: string) => void` — no Event wrappers

### Step 2: Refactor `shared-websocket.ts`

Remove from class:
- `ws: WebSocket | null`
- `outboundQueue: string[]`
- `reconnectTimer`
- `reconnectAttempt`
- Private methods: `connectWs`, `scheduleReconnect`, `writeOrQueue`

Add to class:
- `_rws: ReconnectingWs | null = null`

Rewrite `becomeLeader()`:
```ts
private becomeLeader(): void {
  if (this.closed) return;
  this.isLeader = true;
  this.stopLeaderTimeout();
  this.startHeartbeat();
  this.teardownEngine();
  this.setStatus("connecting");

  const rws = new ReconnectingWs(this.url);
  rws.onopen = () => {
    this.readyState = SharedWebSocket.OPEN;
    this.setStatus("open");
    this.postChannel({ kind: "open" });
    this.dispatchOpen();
  };
  rws.onmessage = (data) => {
    this.postChannel({ kind: "rx", data });
    this.dispatchMessage(data);
  };
  rws.onerror = () => this.dispatchError();
  rws.onclose = () => {
    if (this.closed) return;
    this.readyState = SharedWebSocket.CONNECTING;
    this.setStatus("reconnecting");
    this.postChannel({ kind: "close" });
  };
  this._rws = rws;
}

private teardownEngine(): void {
  if (!this._rws) return;
  const old = this._rws;
  this._rws = null;
  old.onopen = old.onmessage = old.onerror = old.onclose = null;
  old.close();
}
```

Update `send()` leader path: `this._rws?.send(data)`

Update `close()` leader path: call `this.teardownEngine()`

Update `hello` handler: check `this._rws?.readyState === 1`

### Step 3: Update barrel

In `plugins/primitives/plugins/networking/web/index.ts`, add:
```ts
export { ReconnectingWs } from "./reconnecting-ws";
```

No type export needed — the class itself is the useful export; options are optional and inferrable.

### Step 4: No consumer changes

`NotificationsClient` uses `SharedWebSocket` whose API is unchanged.

## Verification

| Check | Command |
|---|---|
| Types | `bunx tsc --noEmit --project web/tsconfig.json` |
| Build | `./equin build` |
| Single tab | Playwright: connect, subscribe `tasks`, create a task, assert push arrives |
| Leader close | Playwright: 2 tabs, close leader, assert follower takes over, push still works |
| Frozen leader | Playwright: 2 tabs, kill leader heartbeats, wait 12s, assert follower steals lock |

## Files

- `plugins/primitives/plugins/networking/web/reconnecting-ws.ts` — NEW
- `plugins/primitives/plugins/networking/web/shared-websocket.ts` — REFACTOR
- `plugins/primitives/plugins/networking/web/index.ts` — ADD EXPORT
